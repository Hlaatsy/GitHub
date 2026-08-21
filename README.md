# Kinnect

A family operating system. A parent and child share an agreement, track mood
check-ins, manage school goals, and run a points/rewards system.

See [`CLAUDE.md`](./CLAUDE.md) for the full build brief — it is the source of
truth for this project.

## Stack

- **Next.js 15** (App Router, TypeScript)
- **Supabase** (Postgres, Auth, Row Level Security, Realtime)
- **Tailwind CSS**
- **Netlify** for deploy
- **Zod** for input validation

## Getting started (local)

```bash
npm install
cp .env.example .env.local   # then fill in your Supabase values
npm run dev
```

Open http://localhost:3000. The home page shows a Phase 1 status banner that
reports whether the Supabase environment variables are detected.

### Scripts

| Command | Does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint (next/core-web-vitals) |
| `npm run typecheck` | `tsc --noEmit` |

## Environment variables

Copy `.env.example` to `.env.local` and set:

| Variable | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API | Safe for the browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API | Safe for the browser (protected by RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API | **Server only.** Bypasses RLS. Not needed for Phase 1. |

Real secrets never get committed — `.env.local` is git-ignored.

## Database (Supabase)

SQL migrations and RLS tests live in [`supabase/`](./supabase/README.md). Apply
`supabase/migrations/0001_families_profiles_invites.sql` to your project, then
run `supabase/tests/0001_rls_phase2.sql` to verify the permission model.

### Phase 2 manual acceptance

1. Apply the migration (and, for dev, turn off email confirmation).
2. Browser A → **Create a family** (you become the parent) → land on `/dashboard`.
3. Parent → **Family** → **Generate invite code**; copy the code.
4. Browser B (incognito) → **Join with a code** → paste code → land on `/dashboard`
   as a **child**.
5. Confirm each session shows its own role, and both list the same family under
   **Family → Members**.
6. Confirm a child hitting `/family` is redirected to `/dashboard`, and that RLS
   blocks direct API access to another family's rows (the RLS test automates this).

## Deploy (Netlify)

1. Create a Netlify site from this repo.
2. Netlify auto-detects Next.js; `netlify.toml` pins the build command and the
   `@netlify/plugin-nextjs` runtime.
3. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` under
   Site settings → Environment variables.
4. Deploy. TLS is provided by Netlify; Supabase encrypts at rest.

## Project structure

```
src/
  middleware.ts             # session refresh + protected-route gating
  app/
    layout.tsx              # root layout, fonts, global CSS
    page.tsx                # public landing (roadmap preview + auth CTAs)
    globals.css             # Tailwind + base styles
    (auth)/                 # login, signup (create family), join (with code)
    (app)/                  # dashboard, family (invites), onboarding — protected
    actions/                # auth.ts, family.ts server actions
  components/               # AppHeader, SubmitButton, auth/*, family/*
  lib/
    auth.ts                 # getCurrentProfile() server helper
    tiles.ts                # shared dashboard tile data
    types.ts                # Profile / Family / Invite types
    validation.ts           # Zod schemas for all inputs
    supabase/               # env, browser client, server client, middleware
supabase/
  migrations/               # SQL schema + RLS + onboarding functions
  tests/                    # non-destructive RLS assertions
tailwind.config.ts          # Kinnect palette + serif heading font
netlify.toml                # Netlify build + Next.js runtime plugin
```

## Build phases

Phases ship in order; a phase does not start until the previous one is deployed
and working. See `CLAUDE.md` for the full list.

- [x] **Phase 1 — Foundation:** Next.js + Supabase clients + Tailwind, placeholder
      page, Netlify config. *(Live deploy + env vars are set up by the owner.)*
- [x] **Phase 2 — Auth and families:** email/password auth, family creation
      (parent), invite codes, invite redemption (child), RLS + SECURITY DEFINER
      onboarding functions, middleware route protection, RLS test. *(Needs a live
      Supabase project to run end-to-end — see below.)*
- [ ] Phase 3 — Check-ins
- [ ] Phase 4 — The Couch
- [ ] Phase 5 — Goals
- [ ] Phase 6 — Points and rewards
- [ ] Phase 6.5 — Responsibilities (parent-assigned chores that earn points)
- [ ] Phase 7 — Parent admin queue
- [ ] Phase 8 — Legal and launch prep
