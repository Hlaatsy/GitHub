# SwiftInbox

A WhatsApp assistant for small businesses on the West Rand. Customers message
the shop's normal WhatsApp number; SwiftInbox answers, books, and hands over to
a person when it should.

Next.js 14 · Tailwind · Supabase (auth + RLS) · WhatsApp Cloud API · Groq
(llama3-70b) · n8n · Paystack, in rands.

## Status

Builds, typechecks, 23 tests pass. **Not yet pointed at a real Supabase
project or a real WhatsApp number**, so nothing here has handled a live
message.

There is also an open design decision — see "Unresolved" below. Do not treat
the schema as settled.

## Running it

```sh
npm install
cp .env.example .env.local     # then fill it in
npm run dev
```

Apply `supabase/schema.sql` once against a fresh Supabase project (SQL editor
or `supabase db push`). It is re-runnable.

```sh
npm test         # plans, wallet arithmetic, webhook parsing and signatures
npm run typecheck
npm run build
```

## The parts

| Path | What it is |
| --- | --- |
| `src/lib/plans.ts` | The four tiers. **The only place prices live.** |
| `src/lib/wallet.ts` | Usage arithmetic and the wording when it runs out. Pure, so it is tested. |
| `supabase/schema.sql` | Tables, RLS, and `consume_conversation()` |
| `src/app/api/whatsapp/route.ts` | Inbound messages: verify, meter, answer |
| `src/app/api/paystack/webhook/route.ts` | Settlement, idempotent |
| `src/app/dashboard` | What the shop owner sees |
| `src/app/manager` | Every client's usage, for admin |

## Three things worth knowing before changing anything

**A conversation is a 24-hour window with one contact, not a message.** Twenty
messages sorting out one booking is one conversation. This is how WhatsApp
itself bills and how an owner counts ("someone messaged us"). If it were
per-message, Starter's 50 would be roughly two customers a month.

**The limit check is a row lock, not an `if`.** `consume_conversation()` in
`supabase/schema.sql` identifies the business, drops duplicate retries, opens
or reuses the window, checks the allowance and increments it — in one
statement under `for update`. Split apart, two messages arriving together
against a client on 49 of 50 both read "49 < 50" and both get answered.

**The business's customer is never told the business ran out.** They get a
normal holding reply. The owner gets the upgrade nudge on their own number, at
most once a day. Telling a member of the public that the shop has not paid its
software bill embarrasses the customer we are selling to. There is a test that
fails if that message ever mentions plans, limits or money.

## Pricing

| Tier | Price | Conversations | Per conversation | Numbers |
| --- | --- | --- | --- | --- |
| Starter | R300 | 50 | R6,00 | 1 |
| Basic | R650 | 150 | R4,33 | 1, + calendar |
| Growth | R1 250 | 400 | R3,13 | 2, 24/7 booking, 7-day nurture |
| Scale | R2 500 | 1 000 | R2,50 | Unlimited |

Each step must be cheaper per conversation than the one below it, or upgrading
is a worse deal than staying put. Asserted in `tests/plans.test.mjs` rather
than trusted.

## Unresolved

**The schema is not agreed.** A second design was proposed after this was
built and the two differ on things that are not cosmetic:

- **Billing period** — calendar month (`month_year` like `'2026-10'`) vs. the
  rolling period from signup used here.
- **What a conversation is** — one row per message vs. the 24-hour window
  used here. This changes what customers get for R300.
- **Top-ups** — a `prepaid_balance` and an R500 = 200 top-up. Not built here.
  At R2,50 a conversation that top-up matches Scale's rate and undercuts Basic
  (R4,33) and Growth (R3,13), so a Basic client would top up forever instead
  of upgrading. A top-up needs to be *dearer* per conversation than any tier.
- **`leads` and `bookings` tables** — not built here.
- **Alerting** — at 80% with a projection ("you'll run out in 3 days") vs. at
  100% when blocking, as built.

Also proposed: a system prompt instructing the assistant to deny being an AI.
That is the fastest route to a restricted WhatsApp Business account, and sits
badly beside a conversation log kept for POPIA.

None of this is decided. Ask before building to either shape.

## Not done yet

- Nothing has run against a live Supabase project or WhatsApp number.
- No n8n workflow exists; the webhook falls back to Groq, which works.
- `npm audit` reports advisories against the pinned Next 14. Upgrading is a
  major version and was not done unasked.
- Media messages (image, audio, location) are ignored rather than answered.
  They are deliberately not charged, but the customer gets nothing.
