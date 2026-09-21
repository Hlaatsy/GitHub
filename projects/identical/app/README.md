# IDENTICAL — the app

A running web app. Standard library only, like the rest of this repository:
no pip install, no build step, no services to pay for before there is revenue.

    cd projects/identical/app
    python -m app                 # http://localhost:8000
    python -m unittest discover -s tests

## What is bought and what is built

The talking-face model is **not** ours. It is an API call to a video
generation vendor, billed per video or per second, and it is the only part of
this product that cannot be written here.

| Bought — `app/provider.py` | Built — everything else |
| --- | --- |
| Photo → talking video | Accounts, plans, quotas |
| Voice cloning | Credits, expiry, consumption order |
| Translation | The cap and the upgrade advice |
| Transcription | ZAR billing hooks, ledger |
| | Consent records and retention |
| | Length cap, share encoding |

Everything in the right column is where IDENTICAL differs from a login to
someone else's platform, and none of it comes from a vendor.

`StubProvider` implements the interface with no network and no cost, so the
whole app runs end to end before any contract is signed. Swapping in a real
vendor is one class.

## The number this is waiting on

`VideoProvider.cents_per_video` is `None`, deliberately. Nothing here knows
what a video costs us, because that comes from a vendor contract — and the
entire pricing model rests on it. A test asserts the stub does not invent one.

When it is known, check it against `docs/monetisation.md`: Starter is 10
videos inside R499, which is R49.90 a video. There is more room than the
consumer pricing left, but it still has to be a number rather than a hope.

## Layout

    app/auth.py       sign-in links and phone verification
    app/plans.py      plans, credit packs, and the pricing invariants
    app/billing.py    quota, credits, expiry, consumption order
    app/db.py         SQLite schema and a per-thread connection pool
    app/provider.py   the vendor boundary, and the WhatsApp size ceiling
    app/server.py     routes and views
    app/app.css       one stylesheet, shared with the pricing page design

## Rules the tests enforce

These are the ones that cost money or trust when they break:

- **A credit always costs more per video than any plan.** If credits undercut
  a plan nobody upgrades — they top up forever, and the tiers stop meaning
  anything. Checked against every pack and every tier.
- **Allowance is spent before credits.** Burning a credit somebody paid for
  while their included videos sit unused is indefensible, and customers check.
- **Oldest credits go first**, so a batch about to expire is used, not wasted.
- **Unused allowance does not roll over; credits do.** That is what a cap
  means, and what "credits do not expire at month end" means.
- **Running out raises** rather than rendering something unpaid — the cap is
  the upgrade conversation, not an inconvenience to route around.
- **Trial withholds the costly features**, not just video count: no voice
  cloning (per-user compute) and no guided build, which is a paid service.
- **Team 5 carries more videos per seat than Pro**, which is what justifies
  its higher per-seat price.
- **Avatar limits are enforced on the endpoint**, not just hidden in the UI.
  A form that disappears at the limit is not a limit; the route refuses too.
- **Old plan keys migrate.** Accounts created under the consumer model carry
  keys that no longer exist; without the mapping every lookup raises and the
  account cannot load.
- **A two-minute video exceeds WhatsApp's 16MB limit** at the sharing bitrate,
  so it gets a second smaller encode. Tested, because the first version of
  this would have handed users a file that silently fails to send.

## Still to build

In the order that unlocks revenue:

1. **Payments.** `POST /credits` and `POST /upgrade` currently change state
   without taking money. Paystack or Flutterwave, so EFT, debit order and
   mobile money work — card-only excludes most of this market. See
   `docs/monetisation.md`, "Payment rails".
2. **A real provider** behind `VideoProvider`, which settles the cost question.
3. **Wire up `app/auth.py`.** Sign-in links and phone verification are
   written and tested but not yet connected to the server, which still takes
   an email on trust. Connecting it needs an email sender — anything that
   delivers a link will do.
4. **Async rendering.** Rendering is synchronous, which is fine against a stub
   and wrong against a vendor that takes 40 seconds. Queue and notify.
5. **The WhatsApp pipeline** — voice note in, video back. `docs/product.md`
   section 3. The distribution unlock, and the reason to build mobile web
   rather than native first.

## Notes for whoever picks this up

- `IDENTICAL_SECRET` signs session cookies and sign-in links. Unset, a random one is
  generated per run, so restarting signs everyone out — fine in development,
  set it in production.
- Session cookies are HMAC-signed. An unsigned account id in a cookie would
  let anyone become any account by editing one number.
- The `ledger` table is append-only and records every movement of money or
  quota, so a billing dispute is answered from data rather than memory.
- A consent record is written **with** the avatar, never backfilled. Selling
  compliance expertise while our own product cannot show who agreed to what
  would be indefensible.
