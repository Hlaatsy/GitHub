# Supabase — migrations & tests

The database is the source of authority for permissions. UI checks are cosmetic;
Row Level Security is what actually keeps a child out of another family's data
and out of parent-only writes.

## Layout

```
supabase/
  migrations/   Ordered SQL migrations. Apply in filename order.
  tests/        Non-destructive RLS checks (wrapped in a transaction + rollback).
```

## Applying migrations

Against your Supabase project's Postgres connection string:

```bash
psql "$DATABASE_URL" -f supabase/migrations/0001_families_profiles_invites.sql
```

(Or paste the file into the Supabase SQL editor. If you use the Supabase CLI,
`supabase db push` / `supabase migration` also work — the files are plain SQL.)

`$DATABASE_URL` is the direct Postgres URL from **Project Settings → Database →
Connection string**. It is a server secret — never put it in `NEXT_PUBLIC_*`.

## Running the RLS tests

```bash
psql "$DATABASE_URL" -f supabase/tests/0001_rls_phase2.sql
```

The script seeds two families, exercises the onboarding functions, asserts the
guarantees below, and then **rolls back** — it leaves no data behind. A raised
exception means a check failed. Success prints:

```
NOTICE:  ALL PHASE 2 RLS CHECKS PASSED
```

What it proves for Phase 2:

1. `create_family_and_parent` makes the caller a **parent**; `redeem_invite`
   makes the caller a **child** of the invite's family.
2. A redeeming child is linked to the inviter's family; a second family stays
   isolated.
3. Cross-family reads are blocked — a parent in family B cannot see family A.
4. A child cannot promote itself to parent (privileged-column trigger).
5. A child cannot move itself into another family.
6. A child cannot create an invite (parent-only RPC).

## Auth settings for development

Onboarding finalizes as soon as a session exists. Two ways to get there:

- **Fastest for dev:** Supabase → Authentication → Providers → Email → turn
  **Confirm email** off. Signups get an immediate session and land on
  `/dashboard`.
- **With confirmation on:** the user confirms via the email link, signs in, and
  the `/onboarding` screen finalizes their family/child profile.

Either way the security-critical role and family assignment happen in the
database functions, not in the client.
