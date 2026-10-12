# WhatsApp Micro-CRM

Multi-tenant WhatsApp booking and ordering for South African SMEs, with prepaid
message billing and Ozow pay-by-bank deposits.

**Setting up a server or a new business? Follow [docs/onboarding.md](docs/onboarding.md).**

## Deploy (Ubuntu 22.04 / 24.04)

Point an A record at the server, clone this repository onto it, then run:

```sh
sudo ./microcrm/deploy/deploy.sh
```

The script does the following:
- Installs Docker (Compose v2), nginx and certbot.
- Locks the firewall down to SSH, 80 and 443.
- Generates `.env` with a random database password and webhook verify token.
- Gets a Let's Encrypt certificate using the webroot method, so renewals work without stopping nginx.
- Starts the stack.
- Schedules nightly database backups.

It finishes by checking the app end to end over TLS, including Meta's webhook handshake.
Re-run it to deploy updates. Existing secrets, data and certificates are kept.

Local development: `cp .env.example .env`, then `docker compose up -d --build`.

Register these webhooks:

| Provider | URL |
| --- | --- |
| Meta (WhatsApp) | `https://yourdomain.co.za/webhooks/whatsapp` |
| Ozow notify URL | sent per payment as `https://yourdomain.co.za/webhooks/payments` |

## WhatsApp templates

The templates are defined in `src/whatsapp/templates/definitions.ts`. They're checked locally against
Meta's rules, then submitted per WhatsApp Business Account (set `waBusinessAccountId` on the tenant first):

```sh
docker compose exec api node dist/cli/admin.js templates-submit <tenantId>   # safe to re-run
docker compose exec api node dist/cli/admin.js templates-sync <tenantId>     # pull current status
```

Meta's decisions arrive on the WhatsApp webhook. In Meta's dashboard, subscribe the webhook to
**message_template_status_update** as well as **messages**. A rejected template is resubmitted on the
next `templates-submit` once its definition is fixed. If Meta changes a template's category (for
example utility to marketing, which is billed higher), it's flagged both when you submit and on the
owner checklist.

The code fills the parameters by position:

| Name | Category | Body parameters | Button |
| --- | --- | --- | --- |
| `payment_confirmed` | Utility | `{{1}}` business, `{{2}}` booking/order, `{{3}}` amount, `{{4}}` reference | none |
| `payment_request` | Utility | `{{1}}` business, `{{2}}` booking/order, `{{3}}` amount, `{{4}}` expiry time | URL: `https://yourdomain.co.za/pay/{{1}}` |
| `wallet_low_balance` | Utility | `{{1}}` business, `{{2}}` balance, `{{3}}` threshold | none |

Example `payment_confirmed` body: *"{{1}}: payment of {{3}} received for {{2}}. You're confirmed ✅ Ref {{4}}."*

## Payments

- A tenant's `depositBps` (basis points of the total; `10000` means pay in full) turns on payment collection.
  Bookings are then held as `PENDING_DEPOSIT` until paid or until the link expires.
- Every settlement notification is checked against its SHA512 hash, then confirmed server-to-server with
  `GetTransactionByReference` before the booking or order moves to `CONFIRMED`.
- A background reconciler settles payments whose webhook never arrived and expires abandoned links,
  which releases their holds. It also retries undelivered confirmations.
- Before go-live, confirm the hash field orders in `src/payments/ozow.ts` against Ozow's current docs,
  and run a staging payment (`OZOW_BASE_URL=https://stagingapi.ozow.com`, `OZOW_IS_TEST=true`).

## SMS fallback

If Meta reports a pay-link message as undeliverable (error 131026: the number isn't on WhatsApp, or the
app is too old), the link is re-sent once by SMS through BulkSMS. For example: *"Glow Studio: pay
R125.00 to confirm Wash & Blow Mon 12 Oct 08:00: https://…/pay/… (valid until 02:31)"*.

- No SMS is sent for other failure codes, if the payment is no longer pending, if the customer has
  opted out, or if the wallet can't cover it.
- Each SMS is billed per segment (`SMS_COST_PER_SEGMENT_CENTS`).
- It's enabled when `BULKSMS_TOKEN_ID` and `BULKSMS_TOKEN_SECRET` are set and payments are enabled.
- Before go-live, confirm the auth scheme and response format in `src/sms/bulksms.ts` against BulkSMS's
  current docs, and register your sender ID with BulkSMS.

## Owner onboarding checklist

```sh
docker compose exec api node dist/cli/admin.js onboarding-link <tenantId>
```

This prints a private link, valid for 7 days, to send to the business owner. Issuing a new link
invalidates the old one, and only a hash of the link is stored. The page reads live status for seven
steps:
1. WhatsApp number connected (the owner sends HI)
2. Opening hours
3. Catalog
4. Wallet funded
5. Templates approved
6. Deposits on
7. A real test payment

For the test payment, a button sends a real `ONBOARDING_TEST_AMOUNT_CENTS` (R5 by default) pay link to
the owner's WhatsApp. The owner pays it like a customer, and the page refreshes itself until the bank
settlement and the WhatsApp confirmation have both landed. Test orders carry `isTest` so they can be
kept out of revenue figures. The page shows only the business's own setup state, never customer data.

## Owner dashboard

`https://<domain>/dashboard/`. Owners log in by sending **LOGIN** to their business WhatsApp number from
the owner number on file, and get back a single-use link that's valid for 10 minutes. There are no passwords.

- **Bookings or orders:** confirm, cancel, mark done or no-show. The customer is notified on WhatsApp
  if they messaged in the last 24 hours.
- **Payments:** including review flags.
- **Wallet:** balance and ledger.

The JSON API is under `/api/dashboard/*`.

**Security**
- **Session cookie:** `__Host-` prefixed, HttpOnly, Secure and SameSite=Strict, with a 12-hour lifetime
  and 60-minute idle timeout. Only token hashes are stored.
- **State changes:** require the same origin and a JSON body.
- **Tenant scoping:** every query is scoped to the session's business.

Cancelling a booking or order that was already paid flags its payment for a refund. Payments settle
into the platform's merchant account, so refunds are the platform team's job.

