# WhatsApp Micro-CRM

Multi-tenant WhatsApp booking and ordering for South African SMEs, with prepaid
message billing and Ozow pay-by-bank deposits.

## Run

```sh
cp .env.example .env   # fill in secrets
docker compose up -d --build
```

Put `deploy/nginx.conf` in front of it (TLS on 443, app on 127.0.0.1:5000).

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
