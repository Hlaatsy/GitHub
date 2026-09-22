# IDENTICAL — the app

A running web app. Standard library only, like the rest of this repository:
no pip install, no build step, no services to pay for before there is revenue.

    cd projects/identical/app
    python -m app                 # http://localhost:8000
    python -m unittest discover -s tests          # 109 unit tests, milliseconds
    python tests/mail_e2e.py                      # against a real SMTP server
    python tests/payments_e2e.py                  # checkout, callback, webhook
    pip install playwright
    python tests/browser_preview.py               # the real app in a browser

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

    app/approvals.py  sign-off before a video can be shared
    app/auth.py       sign-in links and phone verification
    app/mail.py       delivering those links -- SMTP, console or memory
    app/teams.py      organisations, memberships, invitations, seats
    app/health.py     account health and retention, from the ledger
    app/plans.py      plans, credit packs, and the pricing invariants
    app/billing.py    quota, credits, expiry, consumption order
    app/db.py         SQLite schema and a per-thread connection pool
    app/provider.py   the vendor boundary, and the WhatsApp size ceiling
    app/server.py     routes and views
    app/app.css       one stylesheet, shared with the pricing page design

## Approvals

Team 5 sells an approval workflow, and now has one. Turned on, a finished
video waits for an owner before it can be shared or downloaded — which is the
thing a communications lead is personally accountable for.

Three decisions worth knowing:

- **Approval gates use, not rendering.** You cannot approve a video you have
  not watched, and a script reads differently from the same words in
  someone's mouth. The cost is tokens spent on videos that are then rejected;
  the provider charged us either way.
- **The maker may be the approver, unless four-eyes is on.** In a small team
  the writer is often the accountable person, and blocking that by default
  makes the feature something people switch off. Organisations needing
  separation of duties turn four-eyes on, and then nobody clears their own
  work.
- **A rejection needs a reason.** Rejecting without one sends somebody back
  to a blank page.

The `approvals` table is append-only and never pruned. A rejection is not
erased by a later approval, because "somebody approved it" is only an answer
if the record names them and says when — the same reasoning as the consent
register, applied to publishing.

Moving up to a plan that includes approvals turns it on. A feature nobody
switches on is a feature nobody bought.

## Account health

    python -m app health

Who is about to leave, and who should be moved up a plan — computed from the
ledger and the tables beside it, sorted worst first.

Bought customer-success platforms start around $12 000 a year and work by
scoring exactly these signals. This scores them from the history the app
already records, which is worth doing long before there is a book of business
large enough to justify buying anything.

Three risk signals and one opportunity:

| Signal | Why it is the one to watch |
| --- | --- |
| **Dormant** — nothing made in 21 days | Accounts go quiet long before they cancel |
| **Under-using** — under 25% of a paid allowance | They will notice at renewal even if they have not yet |
| **Empty seats** — under half the paid seats active | A five-seat plan one person uses will not renew |
| **Near the cap** — 85% or more, or topping up | Ask before they are blocked, not after |

Two deliberate choices. The cap signal fires at 85%, not 100%, because having
the upgrade conversation after someone has been told no is the worst moment
to ask for money. And every flag carries the sentence that explains it — a
test asserts each one is a full sentence somebody could act on, because a
number nobody can argue with is a number nobody acts on.

`cohorts()` gives sign-ups by month and how many still pay. The number worth
watching is **month five**: with the avatar build given away up front, that is
roughly where an account has repaid what it cost to win. A cohort from this
month reading 0% is a trial that has not converted yet, not a churn.

## Deploying

`DEPLOY.md` covers Fly.io: one machine, one volume for the SQLite file, TLS
at the edge. Three things the app enforces because they only fail in
production:

- **`IDENTICAL_DB`** must point at a mounted volume, or the database is
  written into the container filesystem and is gone on the next deploy.
- **`IDENTICAL_SECRET`** must be set when the site is https, and the app
  refuses to start without it. Unset, it generates a key per boot: every
  restart signs all users out, and two machines cannot read each other's
  sessions.
- **Session cookies are marked `Secure`** whenever `IDENTICAL_BASE_URL` is
  https, derived from that one setting so it cannot drift out of step with
  how the site is actually reached.

## Payments

Paystack, because it carries the rails this market uses — EFT, instant EFT,
mobile money and cards — and the same integration reaches Nigeria, Ghana and
Kenya later.

    PAYSTACK_SECRET_KEY=sk_live_...
    IDENTICAL_BASE_URL=https://app.identical.africa   # callbacks land here too
    IDENTICAL_CURRENCY=ZAR

No secret key means a stub gateway that treats every checkout as paid, which
is what development wants and production must never have.

Point Paystack's webhook at `POST /payments/webhook`.

Three rules the code enforces, each a quiet way to lose money:

- **The amount is never taken from the browser.** What a payment is for is
  written to the `payments` table before the customer is sent anywhere, and
  the gateway's amount is checked against it on the way back. A mismatch is
  refused and logged rather than credited.
- **Applying a payment is idempotent.** The callback and the webhook both
  arrive for the same transaction, and Paystack replays webhooks by design.
  `applied_at` is what makes the second one a no-op.
- **A webhook is not trusted until its signature verifies** — HMAC-SHA512 of
  the raw body, compared in constant time. Parse the JSON first and a
  re-serialised body will not match, so the raw bytes are read before
  anything else touches the request.

Moving down a plan, or to the trial, takes no payment.

### Not done yet

Recurring billing. A plan change charges once; nothing renews it next month.
Paystack Plans and subscriptions are the next piece, and until then a renewal
is a manual charge.

## Email

Sign-in and invitation links are delivered by `app/mail.py`. With no SMTP
host set it prints to the console, which is what development wants; set one
and it sends for real:

    IDENTICAL_BASE_URL=https://app.identical.africa   # links must be absolute
    IDENTICAL_SMTP_HOST=smtp.your-provider.net
    IDENTICAL_SMTP_PORT=587                           # 465 for implicit TLS
    IDENTICAL_SMTP_USER=...
    IDENTICAL_SMTP_PASSWORD=...
    IDENTICAL_MAIL_FROM="IDENTICAL <no-reply@identical.africa>"

Plain SMTP rather than a vendor SDK, so Mailgun, SES, Postmark, Brevo or your
own relay all work and changing provider is four environment variables.

`IDENTICAL_BASE_URL` is the one that bites: a relative link works in the app
and is dead in an inbox.

## Why there is a browser test as well

The unit suite tests modules, so a view can reference an attribute that no
longer exists and every test still passes. That is not hypothetical: when
plans moved to tokens, the signed-out landing page still read `plan.avatars`
and nothing failed until a browser asked for the page.

`tests/browser_preview.py` drives the real app at phone width through every
flow and screenshots each step. Run it before shipping anything that touches
a view.

## Rules the tests enforce

These are the ones that cost money or trust when they break:

- **A credit always costs more per video than any plan.** If credits undercut
  a plan nobody upgrades — they top up forever, and the tiers stop meaning
  anything. Checked against every pack and every tier.

- **Oldest credits go first**, so a batch about to expire is used, not wasted.
- **Unused allowance does not roll over; credits do.** That is what a cap
  means, and what "credits do not expire at month end" means.
- **Running out raises** rather than making something unpaid — the cap is
  the upgrade conversation, not an inconvenience to route around.
- **Trial withholds the costly features**, not just video count: no voice
  cloning (per-user compute) and no guided build, which is a paid service.
- **Team 5 carries more videos per seat than Pro**, which is what justifies
  its higher per-seat price.
- **Avatar limits are enforced on the endpoint**, not just hidden in the UI.
  A form that disappears at the limit is not a limit; the route refuses too.
- **One token pool pays for everything.** A video is 1 token, an avatar is 5.
  No separate charge for an avatar and no per-plan avatar cap: when the tokens
  run out you top up, and that one rule covers every kind of content.
- **Subscribed tokens are spent before topped-up ones**, and a spend that
  needs both uses both rather than refusing.
- **An uploaded avatar gets a consent record; a generated one does not.**
  Recording a consenting subject for a synthetic presenter would put a
  fictional name in the register an organisation shows its regulator.
- **A seat is an accepted invitation.** A pending invitation holds its seat, an
  invitation cannot be forwarded to a different address or accepted twice, and
  revoking frees the seat while leaving that person's videos attributed to them.
- **The owner cannot be removed**, or an organisation ends up with nobody able
  to manage it.
- **Nothing is reachable without signing in** except the sign-in form itself.
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
4. **Payments.** Buying tokens and changing plan still move state without
   taking money.
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
