-- Phase 2: Auth and families
-- Tables: families, profiles, invites
-- Everything below assumes Supabase auth (auth.users, auth.uid()).
--
-- Permission model (see CLAUDE.md):
--   * A child must not read another family's data or escalate their own role,
--     even by calling the API directly. RLS enforces this, not the UI.
--   * "First signup creates a family and becomes parent" and "invite redemption
--     joins as child" are handled by SECURITY DEFINER functions, so a client can
--     never insert a profile with an arbitrary role/family_id of its choosing.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'family_role') then
    create type public.family_role as enum ('parent', 'child');
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.families (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 100),
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  family_id      uuid not null references public.families (id) on delete cascade,
  display_name   text not null check (char_length(display_name) between 1 and 60),
  role           public.family_role not null,
  avatar_emoji   text,
  date_of_birth  date,
  -- Derived cache of the point_events ledger (Phase 6). Never mutated by
  -- clients; RLS + a trigger below forbid changing it directly.
  points_balance integer not null default 0,
  support_mode   boolean not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists profiles_family_id_idx on public.profiles (family_id);

create table if not exists public.invites (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families (id) on delete cascade,
  code       text not null unique,
  role       public.family_role not null default 'child',
  expires_at timestamptz not null default (now() + interval '7 days'),
  claimed_by uuid references auth.users (id),
  claimed_at timestamptz,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create index if not exists invites_family_id_idx on public.invites (family_id);

-- ---------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so they can read profiles without
-- triggering the profiles RLS policies — which would otherwise recurse).
-- ---------------------------------------------------------------------------
create or replace function public.current_family_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select family_id from public.profiles where id = auth.uid();
$$;

create or replace function public.is_parent()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'parent'
  );
$$;

-- ---------------------------------------------------------------------------
-- Onboarding functions.
-- These are the ONLY sanctioned way to create a profile. There is no INSERT
-- policy on profiles, so a client cannot self-assign a role or family.
-- ---------------------------------------------------------------------------

-- First signup: create a family and become its parent.
create or replace function public.create_family_and_parent(
  p_family_name  text,
  p_display_name text,
  p_avatar_emoji text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_family public.families;
  v_profile public.profiles;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'Profile already exists for this user';
  end if;

  insert into public.families (name)
  values (trim(p_family_name))
  returning * into v_family;

  insert into public.profiles (id, family_id, display_name, role, avatar_emoji)
  values (v_uid, v_family.id, trim(p_display_name), 'parent', p_avatar_emoji)
  returning * into v_profile;

  return v_profile;
end;
$$;

-- Parent generates an invite code for their family.
create or replace function public.create_invite(
  p_role public.family_role default 'child'
)
returns public.invites
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_family uuid := public.current_family_id();
  v_invite public.invites;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_parent() then
    raise exception 'Only a parent can create invites';
  end if;

  insert into public.invites (family_id, code, role, created_by)
  values (
    v_family,
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
    p_role,
    v_uid
  )
  returning * into v_invite;

  return v_invite;
end;
$$;

-- Second user redeems an invite code and joins as the invited role (child).
create or replace function public.redeem_invite(
  p_code         text,
  p_display_name text,
  p_avatar_emoji text default null,
  p_date_of_birth date default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_invite  public.invites;
  v_profile public.profiles;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'Profile already exists for this user';
  end if;

  select * into v_invite
  from public.invites
  where code = upper(trim(p_code))
    and claimed_by is null
    and expires_at > now()
  for update;

  if v_invite.id is null then
    raise exception 'Invite code is invalid, already used, or expired';
  end if;

  insert into public.profiles (id, family_id, display_name, role, avatar_emoji, date_of_birth)
  values (v_uid, v_invite.family_id, trim(p_display_name), v_invite.role, p_avatar_emoji, p_date_of_birth)
  returning * into v_profile;

  update public.invites
  set claimed_by = v_uid, claimed_at = now()
  where id = v_invite.id;

  return v_profile;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trigger: forbid client-side changes to privileged profile columns.
-- Role, family, id, and the derived points cache can never be changed by an
-- UPDATE from the API — only by the SECURITY DEFINER paths above (INSERT) and
-- the future ledger (Phase 6).
-- ---------------------------------------------------------------------------
create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id
     or new.family_id <> old.family_id
     or new.role <> old.role
     or new.points_balance <> old.points_balance then
    raise exception 'Cannot modify id, family_id, role, or points_balance directly';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_columns on public.profiles;
create trigger protect_profile_columns
  before update on public.profiles
  for each row execute function public.protect_profile_columns();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.families enable row level security;
alter table public.profiles enable row level security;
alter table public.invites  enable row level security;

-- families: members read their own family; parents may rename it.
drop policy if exists families_select on public.families;
create policy families_select on public.families
  for select using (id = public.current_family_id());

drop policy if exists families_update_parent on public.families;
create policy families_update_parent on public.families
  for update using (id = public.current_family_id() and public.is_parent())
  with check (id = public.current_family_id() and public.is_parent());

-- No families INSERT/DELETE policy: creation is via create_family_and_parent().

-- profiles: read anyone in your family; update your own row; parents may update
-- rows in their family. Column-level escalation is blocked by the trigger.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (family_id = public.current_family_id());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists profiles_update_parent on public.profiles;
create policy profiles_update_parent on public.profiles
  for update using (family_id = public.current_family_id() and public.is_parent())
  with check (family_id = public.current_family_id() and public.is_parent());

-- No profiles INSERT policy: creation is via the onboarding functions only.

-- invites: parents see and manage invites for their own family. Redemption
-- does not need a broad SELECT because redeem_invite() runs as definer.
drop policy if exists invites_select_parent on public.invites;
create policy invites_select_parent on public.invites
  for select using (family_id = public.current_family_id() and public.is_parent());

-- No invites INSERT/UPDATE/DELETE policy: creation is via create_invite(),
-- redemption via redeem_invite().

-- ---------------------------------------------------------------------------
-- Grants: expose the RPCs to authenticated users.
-- ---------------------------------------------------------------------------
grant execute on function public.create_family_and_parent(text, text, text) to authenticated;
grant execute on function public.create_invite(public.family_role) to authenticated;
grant execute on function public.redeem_invite(text, text, text, date) to authenticated;
grant execute on function public.current_family_id() to authenticated;
grant execute on function public.is_parent() to authenticated;
