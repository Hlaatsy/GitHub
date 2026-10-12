# WhatsApp Micro-CRM

Multi-tenant WhatsApp booking and ordering for South African SMEs, with prepaid
message billing and Ozow pay-by-bank deposits.

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

## WhatsApp templates to submit for approval

The code fills these by position, so keep the parameter order.

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

