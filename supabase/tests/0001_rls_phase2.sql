-- RLS verification for Phase 2 (families, profiles, invites).
--
-- Runs against a Supabase database (the auth schema must exist). It is wrapped
-- in a transaction and ROLLED BACK at the end, so it changes nothing.
--
--   psql "$DATABASE_URL" -f supabase/tests/0001_rls_phase2.sql
--
-- A raised exception = a failed assertion. "ALL PHASE 2 RLS CHECKS PASSED" at
-- the end means everything held.

begin;

-- --- Setup (as superuser, bypassing RLS) -----------------------------------
-- Two users in two different families: a parent in family A, a child in
-- family A, and a parent in family B.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'parentA@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'childA@test.local'),
  ('33333333-3333-3333-3333-333333333333', 'parentB@test.local');

-- Helper to run a block as a given authenticated user.
create or replace function pg_temp.as_user(p_uid uuid)
returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
end;$$;

-- Parent A creates family A via the sanctioned onboarding path.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.create_family_and_parent('The A Family', 'Parent A');
reset role;

-- Parent A generates an invite; child A redeems it.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temporary table _inv on commit drop as
  select code from public.create_invite('child');
reset role;

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.redeem_invite((select code from _inv), 'Child A');
reset role;

-- Parent B creates a separate family B.
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.create_family_and_parent('The B Family', 'Parent B');
reset role;

-- --- Assertions ------------------------------------------------------------

-- 1. Roles were assigned correctly by the definer functions.
do $$
declare v_role public.family_role;
begin
  select role into v_role from public.profiles
    where id = '11111111-1111-1111-1111-111111111111';
  if v_role <> 'parent' then raise exception 'FAIL: creator is not parent'; end if;

  select role into v_role from public.profiles
    where id = '22222222-2222-2222-2222-222222222222';
  if v_role <> 'child' then raise exception 'FAIL: invite redeemer is not child'; end if;

  raise notice 'PASS: roles assigned correctly (parent / child)';
end;$$;

-- 2. Child A and Parent A share a family; Parent B is separate.
do $$
declare v_fam_a uuid; v_fam_child uuid; v_fam_b uuid;
begin
  select family_id into v_fam_a    from public.profiles where id = '11111111-1111-1111-1111-111111111111';
  select family_id into v_fam_child from public.profiles where id = '22222222-2222-2222-2222-222222222222';
  select family_id into v_fam_b    from public.profiles where id = '33333333-3333-3333-3333-333333333333';
  if v_fam_a <> v_fam_child then raise exception 'FAIL: child not linked to parent family'; end if;
  if v_fam_a =  v_fam_b then raise exception 'FAIL: family B collided with family A'; end if;
  raise notice 'PASS: child linked to parent; family B is isolated';
end;$$;

-- 3. Cross-family read isolation: as Parent B, the profiles of family A are
--    invisible.
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$
declare v_visible int;
begin
  select count(*) into v_visible from public.profiles
    where family_id = (select family_id from public.profiles
                       where id = '11111111-1111-1111-1111-111111111111');
  -- Note: the subquery itself is RLS-filtered, so it resolves to null for B;
  -- the point is B sees only its own single profile.
  select count(*) into v_visible from public.profiles;
  if v_visible <> 1 then
    raise exception 'FAIL: parent B can see % profiles, expected only its own', v_visible;
  end if;
  raise notice 'PASS: cross-family read isolation holds';
end;$$;
reset role;

-- 4. A child cannot escalate their own role.
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
do $$
begin
  begin
    update public.profiles set role = 'parent'
      where id = '22222222-2222-2222-2222-222222222222';
    raise exception 'FAIL: child was able to promote itself to parent';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      raise notice 'PASS: child role escalation blocked (%).', sqlerrm;
  end;
end;$$;

-- 5. A child cannot move themselves into another family.
do $$
begin
  begin
    update public.profiles set family_id = gen_random_uuid()
      where id = '22222222-2222-2222-2222-222222222222';
    raise exception 'FAIL: child was able to change its family_id';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      raise notice 'PASS: child family_id change blocked (%).', sqlerrm;
  end;
end;$$;

-- 6. A child cannot create an invite (parent-only).
do $$
begin
  begin
    perform public.create_invite('child');
    raise exception 'FAIL: child was able to create an invite';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      raise notice 'PASS: child invite creation blocked (%).', sqlerrm;
  end;
end;$$;
reset role;

do $$ begin raise notice 'ALL PHASE 2 RLS CHECKS PASSED'; end;$$;

rollback;
