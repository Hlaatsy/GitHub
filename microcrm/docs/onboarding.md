# Onboarding guide

Setting up the WhatsApp micro-CRM for a business, from an empty server to the owner's first real payment.

Two people are involved:

| Who | Does what |
| --- | --- |
| **Platform operator** (you, running the server) | Deploys the app once, connects it to Meta and Ozow, then adds each business |
| **Business owner** (the salon, decor hire or shop) | Follows a setup checklist link, makes a R5 test payment, then runs the business from the dashboard |

Admin commands in this guide are run on the server from the app directory (`/var/www/whatsapp-crm`):

```sh
docker compose exec api node dist/cli/admin.js <command> …
```

---

## Part A: Platform setup (operator, once)

### A1. Before you start

- **Server:** Ubuntu 22.04 or 24.04 with a public IP address.
- **Domain:** an A record (for example `app.yourdomain.co.za`) pointing at that IP. The deploy script refuses to continue until it does.
- **Meta:** a Meta Business account that has completed business verification (in Meta Business Settings).
- **Ozow:** a merchant account, to take deposits. Without one the app runs, but with payments switched off.

### A2. Create the Meta app and a permanent token

1. **Create the app:** at [developers.facebook.com](https://developers.facebook.com), choose **My Apps → Create app**, select the **Business** type, then add the **WhatsApp** product.
2. **Copy the app secret:** under **App settings → Basic**, copy the **App secret**. It becomes `WA_APP_SECRET` and is what proves each webhook really came from Meta.
3. **Create a permanent token:** in [business.facebook.com](https://business.facebook.com), open **Business settings → Users → System users** and:
   - Add a system user with the **Admin** role.
   - **Assign assets:** give it your app, plus each WhatsApp Business Account you'll manage, with full control.
   - **Generate token:** pick your app, set expiry to **Never**, and tick `whatsapp_business_messaging` and `whatsapp_business_management`. This token becomes `WA_ACCESS_TOKEN`.

   Don't use the temporary token on the app's **API Setup** page: it expires after 24 hours.

### A3. Deploy

On the server, clone the repository and run:

```sh
sudo ./microcrm/deploy/deploy.sh
```

It asks for your domain, an email for certificate expiry notices, the system-user token and the app secret. It then:
- installs Docker, nginx and certbot;
- locks the firewall down to SSH, 80 and 443;
- gets a TLS certificate;
- generates the database password and **webhook verify token**;
- starts the app.

It only reports success after checking the app over HTTPS, including Meta's webhook handshake. Note the verify token it prints; it's also stored as `WA_VERIFY_TOKEN` in `/var/www/whatsapp-crm/.env`.

To deploy updates later, pull the repository and run the same command again. Secrets, data and certificates are kept.

### A4. Connect the webhook

In the Meta app, open **WhatsApp → Configuration → Webhook**:

1. **Callback URL:** `https://app.yourdomain.co.za/webhooks/whatsapp`
2. **Verify token:** the value printed by the deploy script.
3. Click **Verify and save**.
4. Under **Webhook fields**, subscribe to:
   - **`messages`**: customer messages and delivery statuses.
   - **`message_template_status_update`**: Meta's template approval decisions.

### A5. Payments

The app supports three gateways. Configure any combination in `/var/www/whatsapp-crm/.env`, then run `docker compose up -d --force-recreate api`. Each provider's settings are all-or-nothing, and the app refuses to start with a half-configured provider.

| Provider | Customers pay with | Settlement endpoint | You configure |
| --- | --- | --- | --- |
| **Ozow** | Instant EFT | `/webhooks/payments` | `OZOW_SITE_CODE`, `OZOW_API_KEY`, `OZOW_PRIVATE_KEY`, `OZOW_IS_TEST=false` |
| **PayFast** | Card, EFT and more | `/api/payments/payfast-itn` | `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE` (the same passphrase set in PayFast's developer settings), `PAYFAST_SANDBOX=false` |
| **Paystack** | Card, Capitec Pay | `/api/payments/callback` | `PAYSTACK_SECRET_KEY` (`sk_live_…`), **and** the webhook URL `https://app.yourdomain.co.za/api/payments/callback` in the Paystack dashboard |

- **Which provider a business uses:** new payment links use `PAYMENT_DEFAULT_PROVIDER`, or the first one configured. A business can override this with `"paymentProvider"` in its config file (B2). If a business names a provider that isn't configured, its customers' bookings fall back to manual confirmation instead of failing.
- **Notification URLs:**
  - **Ozow and PayFast:** the app sends each its own settlement URL with every payment.
  - **Paystack:** the URL is set once in Paystack's dashboard.
- **Test first:**
  - **Ozow:** `OZOW_BASE_URL=https://stagingapi.ozow.com` with `OZOW_IS_TEST=true`.
  - **PayFast:** `PAYFAST_SANDBOX=true`.
  - **Paystack:** an `sk_test_…` key.

  The app refuses all three in production (`NODE_ENV=production`), so a test account can never confirm real bookings.
- **How a payment is accepted:** a booking is only confirmed after the provider's own record confirms the payment. This is in addition to the notification's signature:
  - **Ozow:** `GetTransactionByReference`.
  - **Paystack:** `/transaction/verify`.
  - **PayFast:** the ITN must also come from a PayFast address and pass PayFast's `validate` check.
- **PayFast and missed notifications.** PayFast has no lookup the app can use without extra credentials, so a PayFast ITN that never arrives is not recovered automatically: the unpaid hold expires and the slot is released. Ozow and Paystack payments are re-checked every 2 minutes.
- **Paystack and customer email.** Paystack requires one, and WhatsApp doesn't provide it, so each payment uses a placeholder such as `pay-wa3apvxkekrb@app.yourdomain.co.za`. It contains no personal information. Paystack may send receipts to it, so expect mail to that domain to bounce, or route it to a catch-all.
- **Where the money goes.** Every business's deposits settle into the platform's merchant accounts, and paying businesses out isn't built into the app. Holding customer money for other businesses may bring payment-regulation obligations in South Africa, so take advice before launch. Ask your providers whether a split or sub-merchant setup fits better.

Optional: **SMS fallback.** Set `BULKSMS_TOKEN_ID` and `BULKSMS_TOKEN_SECRET`, and an unpaid pay link that WhatsApp reports as undeliverable is re-sent once by SMS.

---

## Part B: Adding a business (operator, per business)

### B1. Register the business's WhatsApp number

The business needs its own WhatsApp number, in a WhatsApp Business Account that your system user can manage:

1. **Add the number:** in [WhatsApp Manager](https://business.facebook.com/wa/manage/), add the phone number and verify it with the SMS or voice code.
2. **Free it up if needed:** a number currently active in the WhatsApp or WhatsApp Business app must be removed from that app first. Meta's coexistence onboarding is an alternative, but this guide doesn't cover it.
3. **Write down:**
   - the **Phone number ID** and **WhatsApp Business Account ID**, shown in the app's **WhatsApp → API Setup** page;
   - the number as customers see it, for example `+27 11 000 0001`;
   - the **owner's personal WhatsApp number**. This must be a different number: the owner uses it to message the business number to log in.

### B2. Describe the business in a file

Copy [`example-business.json`](example-business.json) and fill it in:

| Field | Meaning |
| --- | --- |
| `businessName` | Shown to customers in messages |
| `industry` | `SALON` (time slots), `DECOR_HIRE` or `PRODUCT_SELLER` (catalog and orders) |
| `waPhoneNumberId`, `waBusinessAccountId`, `waDisplayPhone` | From B1 |
| `ownerWaId` | Owner's WhatsApp number in international digits, for example `27821234567` (not `082…`) |
| `workingHours` | Opening windows per day; `[]` means closed |
| `bookingCapacity` | How many customers can book the same slot (chairs) |
| `depositPercent` | Share paid upfront by instant EFT: `0` turns payments off, `100` means pay in full |
| `paymentProvider` | Optional: `OZOW`, `PAYFAST` or `PAYSTACK`; omit it to use the platform default |
| `services` / `products` | Name, price in rand, and duration for services |
| `openingWalletBalance` | Starting message credit in rand (first creation only) |

Apply it:

```sh
docker compose exec -T api node dist/cli/admin.js tenant-apply - < glow-studio.json
```

The command prints the business's **tenant ID**; keep it for the steps below. To change hours, prices or the deposit later, edit the file and run the same command again:
- Services and products are matched by name.
- Items removed from the file are switched off, not deleted, so past bookings keep their history.

### B3. Fund the message wallet

Every WhatsApp reply is paid for from the business's prepaid wallet.

```sh
docker compose exec api node dist/cli/admin.js wallet-topup <tenantId> 200 EFT-2026-10-12
```

When the balance drops below R10, the owner gets a WhatsApp warning and the dashboard shows it.

### B4. Submit the WhatsApp templates

Messages sent outside WhatsApp's 24-hour reply window need templates that Meta has approved:

```sh
docker compose exec api node dist/cli/admin.js templates-submit <tenantId>
```

- **Checked before submitting:** templates are checked against Meta's rules first.
- **Approval time:** usually within a day. The result arrives through the webhook (A4).
- **Safe to re-run:** only rejected templates are resubmitted.
- **Status:** shown on the owner's checklist. If Meta moves a template from utility to marketing, which is billed higher, that's shown too.

### B5. Send the owner their setup link

```sh
docker compose exec api node dist/cli/admin.js onboarding-link <tenantId>
```

Send the printed link to the owner, and only to the owner. It's valid for 7 days, and issuing a new link cancels the old one.

---

## Part C: For the business owner

### C1. Your setup checklist

Open the link from your platform operator. It shows seven steps and updates itself as each one completes:

1. **Connect your WhatsApp number:** from your own phone, send **HI** to your business number. When the bot's menu comes back, everything is connected.
2. **Opening hours:** check they're right.
3. **Services or products, with prices**
4. **Message wallet:** needs at least R10.
5. **WhatsApp templates approved by Meta:** usually within a day.
6. **Deposits on:** shows the share customers pay upfront.
7. **First test payment:**
   - Press **Send me a test payment link**.
   - A real **R5.00** link arrives in your WhatsApp; pay it from your banking app, just as a customer would.
   - The page turns green once the bank has confirmed it and your WhatsApp receipt has arrived.

   The test isn't counted as revenue. Ask your operator how the R5 is settled.

### C2. Your dashboard

From your own phone, send **LOGIN** to your business number. You'll get an **Open dashboard** button:
- The link works once, for 10 minutes; don't forward it.
- A session lasts up to 12 hours, and ends after an hour of inactivity.
- The dashboard is at `https://app.yourdomain.co.za/dashboard/`.

What you can do:
- **See today at a glance:** money paid today, bookings today, anything waiting for you, and your wallet balance.
- **Bookings** (salons) or **Orders** (decor and shops):
  - **Confirm** or **Cancel** requests. The customer gets a WhatsApp message if they've written to you in the last 24 hours. If they haven't, the dashboard says so, and you should contact them yourself (the **Chat** link opens WhatsApp).
  - Mark bookings **done** or a **no-show**, and orders **fulfilled**.
- **Payments:** every payment and its status. Payments marked **Review** need attention, for example a booking you cancelled after the customer paid, which needs a refund. Refunds are handled by your platform operator.
- **Wallet:** balance and what each message cost.

### C3. Good to know

- **How customers start:** they send **HI**, **Book** or **Price** to your number and get buttons: Book, Prices, Location/Hours.
- **Deposits:** customers who pick a time get a **Pay** button. The slot is held for 30 minutes. If they don't pay, the slot is released automatically.
- **Opt-outs:** customers can send **STOP** at any time, and the bot stops messaging them. Sending **HI** starts things again.
- **Changes:** for opening hours, prices, the deposit or new services, ask your operator.

---

## Troubleshooting

| Problem | Check |
| --- | --- |
| Meta's **Verify and save** fails | The callback URL is reachable over HTTPS, and the verify token matches `WA_VERIFY_TOKEN` exactly. |
| Customers get no reply | The webhook is subscribed to **`messages`**; `waPhoneNumberId` in the business file matches Meta's Phone number ID; the wallet has credit. Logs: `docker compose logs --tail 100 api` |
| **LOGIN** gets the normal menu instead of a link | It must come from the owner number in the business file (`ownerWaId`). After 5 links in an hour, wait. |
| A template is stuck or rejected | Run `admin templates-sync <tenantId>`; the reason shows on the checklist. Fix the wording in `src/whatsapp/templates/definitions.ts` and run `templates-submit` again. |
| A payment was made but the booking isn't confirmed | The app re-checks unsettled payments with Ozow every 2 minutes. If it still shows **Review** on the dashboard, the amount or booking didn't match and needs a person to look. |
