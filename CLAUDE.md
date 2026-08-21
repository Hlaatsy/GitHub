# Kinnect: Build Brief

Family operating system. Parent and child share an agreement, track mood check-ins, manage school goals, and run a points/rewards system.

This file is the source of truth for Claude Code. Read it before any task.

---

## Stack

- **Next.js 15** (App Router, TypeScript)
- **Supabase** (Postgres, Auth, Row Level Security, Realtime)
- **Tailwind CSS** for styling
- **Netlify** for deploy
- **Zod** for all input validation

Do not add libraries without asking. No state management library until we prove we need one.

---

## Non-negotiable rules

1. **Permissions are enforced in the database, not the UI.** Every table gets Row Level Security policies. A child must not be able to read another family's data or write to parent-only fields, even by calling the API directly. UI-level `isParent` checks are cosmetic only.
2. **This app stores children's data and mental health signals.** Treat every column as sensitive. No third-party analytics on any screen containing check-in content. No logging of check-in text.
3. **No mock data in committed code.** Seed scripts live in `/supabase/seed.sql` and never ship to production.
4. **Every feature ships as a vertical slice**: schema, RLS policy, API route, UI, test. Do not build five screens against a fake backend.
5. Ask before scope creep. If a task needs a decision I have not made, stop and ask.

---

## Data model

```
families
  id, name, created_at

profiles
  id (= auth.users.id), family_id, display_name, role ('parent' | 'child'),
  avatar_emoji, date_of_birth, points_balance, support_mode boolean

invites
  id, family_id, code, role, expires_at, claimed_by

checkins
  id, family_id, author_id, mood (1-5), note text, is_private boolean,
  created_at

checkin_responses
  id, checkin_id, author_id, body, created_at

agreement_sections
  id, family_id, key, title, description, is_enabled, is_parent_only,
  sort_order

agreement_items
  id, section_id, body, created_by, status ('active' | 'suggested' | 'declined'),
  created_at

agreement_signatures
  id, section_id, profile_id, signed_at

goals
  id, family_id, child_id, subject, target, progress int, term,
  academic_year, status, teacher_name, teacher_note

rewards
  id, family_id, title, description, points_cost, icon, category, is_active

redemptions
  id, reward_id, child_id, status ('pending' | 'approved' | 'declined'),
  requested_at, resolved_at, resolved_by

point_events
  id, family_id, child_id, delta int, reason, awarded_by, created_at
```

**Points are never a stored counter you mutate directly.** `points_balance` is derived from `point_events`, either as a view or a trigger-maintained cache. Redemptions insert a negative event on approval.

---

## RLS policy shape

For every table:

- Read: `family_id` matches the caller's `family_id`.
- Child write: only rows where they are the author, and only into the fields listed as child-writable below.
- Parent write: any row in their family.
- `checkins.is_private = true` is readable only by the author.

Child-writable fields:

| Table | Child may |
|---|---|
| checkins | insert own, set mood/note/is_private |
| checkin_responses | insert own |
| agreement_items | insert with status = 'suggested' only |
| goals | update `progress` on own goals only |
| redemptions | insert with status = 'pending' only |

Everything else is parent-only. Enforce this in SQL policies, then mirror it in the UI.

---

## Build order

Do not start a phase until the previous one is deployed and working.

### Phase 1: Foundation
Next.js project, Supabase connected, Tailwind, deployed to Netlify with a placeholder page. Environment variables set. Confirm the deploy pipeline works before writing features.

### Phase 2: Auth and families
Email/password signup. On first signup the user creates a family and becomes the parent. Parent generates an invite code. Second user redeems the code and joins as child. Role stored on `profiles`. Middleware protects all app routes.

Acceptance: two browser sessions, two accounts, correctly linked, each seeing their own role.

### Phase 3: Check-ins (first full slice)
Schema, RLS, insert, list, parent response, private flag. This is the proof that the permission model works. Test it by hitting the API directly as the child account and trying to read a private entry.

### Phase 4: The Couch
Agreement sections and items. Parent CRUD. Child suggestions land as `status = 'suggested'` and appear in the parent approval queue. Signatures per section.

### Phase 5: Goals
Parent creates, child updates progress only. Teacher fields are plain text for now, no teacher accounts.

### Phase 6: Points and rewards
`point_events` ledger, derived balance, reward catalogue, redemption request and approval flow.

### Phase 7: Parent admin queue
Single view aggregating suggested agreement items, pending redemptions, and unanswered check-ins.

### Phase 8: Legal and launch prep
Privacy policy, terms, parental consent flow at child signup, data export, account deletion. See below.

---

## Deliberately out of scope for v1

- Mood pattern alerts and "support mode" automation
- Teacher accounts and messaging
- Push notifications
- Native mobile apps
- Multiple children per family (design the schema to allow it, do not build the UI)

Support mode stays a manual parent toggle in v1. Automated detection of a child's emotional state is a product and liability decision, not a feature to ship casually.

---

## Legal requirements before any real family uses this

These are blocking. Do not invite outside users until they are done.

- Verifiable parental consent captured at child account creation
- Privacy policy covering what is collected, why, retention period, and deletion
- Data export and full account deletion, both working
- Encryption at rest confirmed, TLS everywhere
- A decision documented on what happens if a check-in indicates a child is at risk, and what the app does and does not promise

South Africa: POPIA applies. If any user is in the UK or EU, GDPR and the Age Appropriate Design Code apply. Get advice before public launch.

---

## UI reference

Port from the existing React prototype. Keep the visual language:

- Georgia serif headings, dark gradient page headers, cream body background
- Colours: cream `#FAF7F2`, dark `#1A1A2E`, coral `#E8634A`, sage `#7BAE9A`, gold `#D4A853`, lavender `#9B8EC4`
- Rounded cards, soft shadows, generous spacing
- Parent accent is coral, child accent is lavender

Convert inline styles to Tailwind classes during the port. Extract shared pieces into components rather than copying blocks.

---

## Working style

- Small commits, one concern each
- Write the SQL migration before the UI
- After each phase, tell me what to test manually and what could break
- Flag anything that looks like a security or child-safety issue immediately, even if I did not ask