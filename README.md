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
  app/
    layout.tsx        # root layout, fonts, global CSS
    page.tsx          # Phase 1 placeholder / deploy-check page
    globals.css       # Tailwind + base styles (cream body, serif headings)
  lib/
    supabase/
      env.ts          # reads & validates public Supabase env vars
      client.ts       # browser client (@supabase/ssr)
      server.ts       # cookie-aware server client (@supabase/ssr)
tailwind.config.ts    # Kinnect palette + serif heading font
netlify.toml          # Netlify build + Next.js runtime plugin
```

## Build phases

Phases ship in order; a phase does not start until the previous one is deployed
and working. See `CLAUDE.md` for the full list.

- [x] **Phase 1 — Foundation:** Next.js + Supabase clients + Tailwind, placeholder
      page, Netlify config. *(Live deploy + env vars are set up by the owner.)*
- [ ] Phase 2 — Auth and families
- [ ] Phase 3 — Check-ins
- [ ] Phase 4 — The Couch
- [ ] Phase 5 — Goals
- [ ] Phase 6 — Points and rewards
- [ ] Phase 6.5 — Responsibilities (parent-assigned chores that earn points)
- [ ] Phase 7 — Parent admin queue
- [ ] Phase 8 — Legal and launch prep
