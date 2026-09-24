-- SwiftInbox schema.
--
-- Run this once against a fresh Supabase project (SQL editor, or
-- `supabase db push`). It is written to be re-runnable.
--
-- Two decisions worth knowing before reading:
--
-- 1. No tier's numbers appear in here. `clients.conversation_limit` is set by
--    the application from src/lib/plans.ts whenever a plan changes. Putting
--    "50" and "1000" in SQL as well would mean two sources of truth for the
--    thing customers are charged on, and they would drift.
--
-- 2. A conversation is not a message. It is a 24-hour window with one
--    contact, which is how WhatsApp itself bills and how a customer counts
--    ("someone messaged us"). Twenty messages sorting out one booking is one
--    conversation. consume_conversation() below is what enforces that.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- clients

create table if not exists public.clients (
  id                         uuid primary key default gen_random_uuid(),
  name                       text not null,
  suburb                     text,
  plan                       text not null default 'starter',
  conversation_limit         integer not null default 50,
  conversations_used         integer not null default 0,
  status                     text not null default 'trialing'
                               check (status in ('trialing','active','past_due','cancelled')),
  period_start               timestamptz not null default now(),
  period_end                 timestamptz not null default (now() + interval '1 month'),
  paystack_customer_code     text,
  paystack_subscription_code text,
  ai_system_prompt           text,
  -- The owner's own WhatsApp number, for the "you have run out" nudge. It is
  -- not the same as the business number customers message.
  owner_wa_id                text,
  -- Throttles that nudge to once a day; see shouldNotifyOwner() in
  -- src/lib/wallet.ts for why.
  upgrade_notice_at          timestamptz,
  -- Customers turned away since the cap was hit, so the nudge can say how
  -- much the shortfall is actually costing. Reset when the period rolls.
  blocked_since_cap          integer not null default 0,
  created_at                 timestamptz not null default now()
);

-- ------------------------------------------------------- profiles / roles

-- One row per signed-in person. `client_id` is null for staff.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  client_id  uuid references public.clients(id) on delete set null,
  email      text,
  full_name  text,
  role       text not null default 'owner' check (role in ('owner','staff','manager')),
  created_at timestamptz not null default now()
);

create index if not exists profiles_client_idx on public.profiles(client_id);

-- ------------------------------------------------------- WhatsApp numbers

create table if not exists public.whatsapp_numbers (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients(id) on delete cascade,
  phone_number_id  text not null unique,   -- Meta's id for the number
  display_number   text not null,
  label            text,
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

create index if not exists wa_numbers_client_idx on public.whatsapp_numbers(client_id);

-- -------------------------------------------------------------- contacts

create table if not exists public.contacts (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients(id) on delete cascade,
  wa_id      text not null,                -- the customer's number, E.164
  name       text,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  unique (client_id, wa_id)
);

-- --------------------------------------------------------- conversations

create table if not exists public.conversations (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  contact_id    uuid not null references public.contacts(id) on delete cascade,
  opened_at     timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '24 hours'),
  message_count integer not null default 0,
  -- Which billing period this was charged to. Kept so usage can be
  -- recounted from the ledger if the denormalised counter is ever doubted.
  period_start  timestamptz not null,
  handed_over   boolean not null default false
);

create index if not exists conversations_client_period_idx
  on public.conversations(client_id, period_start);
create index if not exists conversations_open_idx
  on public.conversations(client_id, contact_id, expires_at desc);

-- -------------------------------------------------------------- messages

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  -- Meta's message id. Unique because WhatsApp retries delivery until it
  -- gets a 200, and a retry must not be charged or answered twice.
  wa_message_id   text unique,
  direction       text not null check (direction in ('inbound','outbound')),
  body            text,
  blocked         boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists messages_conversation_idx
  on public.messages(conversation_id, created_at);
create index if not exists messages_client_idx
  on public.messages(client_id, created_at desc);

-- -------------------------------------------------------------- payments

create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid references public.clients(id) on delete set null,
  reference    text not null unique,       -- Paystack reference
  event_id     text,
  amount_cents integer not null,
  plan         text,
  status       text not null default 'pending',
  -- Set the moment the payment is turned into plan access. Checked before
  -- applying, so a replayed webhook cannot extend a subscription twice.
  applied_at   timestamptz,
  raw          jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists payments_client_idx on public.payments(client_id, created_at desc);

-- ============================================================ the wallet
--
-- consume_conversation() is the only thing allowed to decide whether the AI
-- answers. It runs as one statement under a row lock because the check and
-- the increment must not be separable: two messages arriving in the same
-- instant against a client on 49 of 50 would otherwise both read "49 < 50",
-- both pass, and both be answered. The lock makes the second one wait and
-- see 50.
--
-- Returns jsonb:
--   status  'ok' | 'blocked' | 'duplicate' | 'unknown_number'
--   ... plus the numbers the caller needs for the reply and the log.

create or replace function public.consume_conversation(
  p_phone_number_id text,
  p_wa_id           text,
  p_wa_message_id   text,
  p_body            text,
  p_contact_name    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id  uuid;
  v_client     public.clients%rowtype;
  v_contact_id uuid;
  v_conv_id    uuid;
  v_counted    boolean := false;
begin
  -- Which business owns the number the customer messaged?
  select client_id into v_client_id
    from public.whatsapp_numbers
   where phone_number_id = p_phone_number_id and active
   limit 1;

  if v_client_id is null then
    return jsonb_build_object('status', 'unknown_number');
  end if;

  -- A retry of a message we already handled. Checked before the lock so
  -- duplicates stay cheap, and again by the unique index below in case two
  -- copies race each other here.
  if exists (select 1 from public.messages where wa_message_id = p_wa_message_id) then
    return jsonb_build_object('status', 'duplicate');
  end if;

  -- Everything past this point is serialised per client.
  select * into v_client from public.clients where id = v_client_id for update;

  -- Roll the prepaid period forward if it has run out. Done here rather
  -- than on a schedule so a client who is quiet for two months still gets a
  -- correct allowance the moment somebody messages them.
  if now() >= v_client.period_end then
    update public.clients
       set period_start = v_client.period_end,
           period_end   = v_client.period_end + interval '1 month',
           conversations_used = 0,
           blocked_since_cap = 0,
           upgrade_notice_at = null
     where id = v_client_id
     returning * into v_client;
  end if;

  -- Upsert the contact.
  insert into public.contacts (client_id, wa_id, name)
       values (v_client_id, p_wa_id, p_contact_name)
  on conflict (client_id, wa_id) do update
          set last_seen = now(),
              name = coalesce(excluded.name, public.contacts.name)
    returning id into v_contact_id;

  -- An open 24-hour window with this contact?
  select id into v_conv_id
    from public.conversations
   where client_id = v_client_id
     and contact_id = v_contact_id
     and expires_at > now()
   order by expires_at desc
   limit 1;

  if v_conv_id is null then
    -- A new conversation is what costs. This is the only place the limit
    -- is enforced.
    if v_client.conversations_used >= v_client.conversation_limit then
      insert into public.messages
             (client_id, wa_message_id, direction, body, blocked)
      values (v_client_id, p_wa_message_id, 'inbound', p_body, true);

      update public.clients
         set blocked_since_cap = blocked_since_cap + 1
       where id = v_client_id
       returning * into v_client;

      return jsonb_build_object(
        'status', 'blocked',
        'client_id', v_client_id,
        'client_name', v_client.name,
        'plan', v_client.plan,
        'used', v_client.conversations_used,
        'limit', v_client.conversation_limit,
        'owner_wa_id', v_client.owner_wa_id,
        'upgrade_notice_at', v_client.upgrade_notice_at,
        'blocked_since_cap', v_client.blocked_since_cap
      );
    end if;

    insert into public.conversations (client_id, contact_id, period_start)
         values (v_client_id, v_contact_id, v_client.period_start)
      returning id into v_conv_id;

    update public.clients
       set conversations_used = conversations_used + 1
     where id = v_client_id
     returning * into v_client;

    v_counted := true;
  end if;

  insert into public.messages
         (client_id, conversation_id, wa_message_id, direction, body)
  values (v_client_id, v_conv_id, p_wa_message_id, 'inbound', p_body);

  update public.conversations
     set message_count = message_count + 1
   where id = v_conv_id;

  return jsonb_build_object(
    'status', 'ok',
    'client_id', v_client_id,
    'client_name', v_client.name,
    'plan', v_client.plan,
    'conversation_id', v_conv_id,
    'contact_id', v_contact_id,
    'new_conversation', v_counted,
    'used', v_client.conversations_used,
    'limit', v_client.conversation_limit,
    'system_prompt', v_client.ai_system_prompt
  );
exception
  -- Lost the race on the unique index: the other copy is handling it.
  when unique_violation then
    return jsonb_build_object('status', 'duplicate');
end;
$$;

revoke all on function public.consume_conversation(text, text, text, text, text) from public, anon, authenticated;

-- ================================================================== RLS
--
-- These two helpers are security definer so that a policy on `profiles` can
-- ask about `profiles` without re-entering its own policy and recursing.
-- A policy written as `exists (select 1 from profiles where ...)` on the
-- profiles table itself deadlocks Postgres into infinite recursion; this is
-- the standard way around it.

create or replace function public.my_client_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$ select client_id from public.profiles where id = auth.uid() $$;

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select coalesce((select role = 'manager' from public.profiles where id = auth.uid()), false) $$;

grant execute on function public.my_client_id() to authenticated;
grant execute on function public.is_manager() to authenticated;

alter table public.clients          enable row level security;
alter table public.profiles         enable row level security;
alter table public.whatsapp_numbers enable row level security;
alter table public.contacts         enable row level security;
alter table public.conversations    enable row level security;
alter table public.messages         enable row level security;
alter table public.payments         enable row level security;

-- Read: your own business, or everything if you are a manager.
-- Write: nothing. Every write happens in a webhook under the service role,
-- which bypasses RLS. A customer cannot award themselves conversations.

drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients for select to authenticated
  using (id = public.my_client_id() or public.is_manager());

drop policy if exists clients_update_own on public.clients;
create policy clients_update_own on public.clients for update to authenticated
  using (id = public.my_client_id())
  with check (id = public.my_client_id());

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_manager());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));

drop policy if exists wa_numbers_read on public.whatsapp_numbers;
create policy wa_numbers_read on public.whatsapp_numbers for select to authenticated
  using (client_id = public.my_client_id() or public.is_manager());

drop policy if exists contacts_read on public.contacts;
create policy contacts_read on public.contacts for select to authenticated
  using (client_id = public.my_client_id() or public.is_manager());

drop policy if exists conversations_read on public.conversations;
create policy conversations_read on public.conversations for select to authenticated
  using (client_id = public.my_client_id() or public.is_manager());

drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated
  using (client_id = public.my_client_id() or public.is_manager());

drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments for select to authenticated
  using (client_id = public.my_client_id() or public.is_manager());

-- ------------------------------------------------ new signups get a profile

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
       values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------ manager overview

-- One row per client with the numbers the manager dashboard shows. A view
-- rather than a query in the app so the percentage is defined once.
create or replace view public.client_usage as
  select c.id,
         c.name,
         c.suburb,
         c.plan,
         c.status,
         c.conversations_used,
         c.conversation_limit,
         case when c.conversation_limit = 0 then 0
              else round(100.0 * c.conversations_used / c.conversation_limit)
         end as percent_used,
         c.period_start,
         c.period_end,
         greatest(0, extract(day from c.period_end - now())::int) as days_left,
         (select max(created_at) from public.messages m where m.client_id = c.id) as last_message_at
    from public.clients c;

alter view public.client_usage set (security_invoker = on);
