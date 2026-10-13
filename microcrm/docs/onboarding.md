# Onboarding guide

Setting up the WhatsApp micro-CRM for a business, from an empty server to the owner's first real payment.

Two people are involved:

| Who | Does what |
| --- | --- |
| **Platform operator** (you, running the server) | Deploys the app once, connects it to Meta, then adds each business and links its payment account |
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

**Recommended: each business is paid into its own account.** A business that has its own PayFast or Paystack merchant account gets its customers' money directly, and handles its own refunds. You never hold its money. Set this up per business in **B3** below. All it needs on the server is `CREDENTIALS_ENCRYPTION_KEY`, which `deploy.sh` generates. Back up `/var/www/whatsapp-crm/.env` somewhere safe: without that key, the stored accounts can't be read.

The settings below are only needed for a **platform-wide** fallback account, used by businesses without their own.

The app supports three gateways. Configure any combination in `/var/www/whatsapp-crm/.env`, then run `docker compose up -d --force-recreate api`. Each provider's settings are all-or-nothing, and the app refuses to start with a half-configured provider.

| Provider | Customers pay with | Settlement endpoint | You configure |
| --- | --- | --- | --- |
| **Ozow** | Instant EFT | `/webhooks/payments` | `OZOW_SITE_CODE`, `OZOW_API_KEY`, `OZOW_PRIVATE_KEY`, `OZOW_IS_TEST=false` |
| **PayFast** | Card, EFT and more | `/api/payments/payfast-itn` | `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE` (the same passphrase set in PayFast's developer settings), `PAYFAST_SANDBOX=false` |
| **Paystack** | Card, Capitec Pay | `/api/payments/callback` | `PAYSTACK_SECRET_KEY` (`sk_live_…`), **and** the webhook URL `https://app.yourdomain.co.za/api/payments/callback` in the Paystack dashboard |

- **Which provider a business uses:**
  - Its own account (B3), if it has one.
  - Otherwise `PAYMENT_DEFAULT_PROVIDER`, or the first platform provider configured.
  - `"paymentProvider"` in its config file (B2) overrides both. If a business names a provider that isn't configured, its customers' bookings fall back to manual confirmation instead of failing.
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
- **Where the money goes.**
  - A business with its own account (B3) is paid directly.
  - Otherwise its payments settle into the platform-wide account above, and paying businesses out isn't built into the app. Holding customer money for other businesses may bring payment-regulation obligations in South Africa, so take advice before relying on this.

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

Copy [`example-business.json`](example-business.json) (a salon) or [`example-shop.json`](example-shop.json) (a product shop with delivery and stock) and fill it in:

| Field | Meaning |
| --- | --- |
| `businessName` | Shown to customers in messages |
| `industry` | `SALON` (time slots), `DECOR_HIRE` or `PRODUCT_SELLER` (catalog and orders) |
| `waPhoneNumberId`, `waBusinessAccountId`, `waDisplayPhone` | From B1 |
| `ownerWaId` | Owner's WhatsApp number in international digits, for example `27821234567` (not `082…`) |
| `workingHours` | Opening windows per day; `[]` means closed |
| `bookingCapacity` | How many customers can book the same slot (chairs) |
| `depositPercent` | Share paid upfront: `0` turns payments off, `100` means pay in full (usual for shops) |
| `paymentProvider` | Optional: `PAYFAST`, `PAYSTACK` or `OZOW`. Omit it to use the business's own account (B3), or else the platform default |
| `services` / `products` | Name, price in rand, and duration for services. Keep names to 24 characters: WhatsApp lists cut longer ones |
| `products[].stock` | Optional units on hand. Sold-out products are hidden, and orders can't oversell. Applied only when a product is first added; after that the owner updates stock on the dashboard. Omit it for items you don't count |
| `deliveryEnabled`, `deliveryFee`, `deliveryNote` | Shops: offer delivery, its flat fee in rand, and a short note shown at checkout (for example `"Gauteng only, 2-3 working days"`) |
| `collectionEnabled` | Shops: offer collection from `addressLine` (on by default). At least one of delivery and collection must be on |
| `openingWalletBalance` | Starting message credit in rand (first creation only) |

Apply it:

```sh
docker compose exec -T api node dist/cli/admin.js tenant-apply - < glow-studio.json
```

The command prints the business's **tenant ID**; keep it for the steps below. To change hours, prices or the deposit later, edit the file and run the same command again:
- Services and products are matched by name.
- Items removed from the file are switched off, not deleted, so past bookings keep their history.

### B3. Link the business's payment account

Ask the owner for their merchant details:
- **PayFast:** **Settings → Integration** shows the merchant ID and merchant key. The owner must set a **passphrase** under **Settings → Developer settings** first.
- **Paystack:** the **live secret key** from **Settings → API Keys & Webhooks**. The owner must also set the **Webhook URL** on that page to `https://app.yourdomain.co.za/api/payments/callback`.

Save it from stdin, so the secret never lands in a file or your shell history:

```sh
docker compose exec -T api node dist/cli/admin.js payment-account-set <tenantId> PAYFAST - <<'JSON'
{"merchantId":"10000100","merchantKey":"46f0cd694581a","passphrase":"the-owners-passphrase","sandbox":false}
JSON

docker compose exec -T api node dist/cli/admin.js payment-account-set <tenantId> PAYSTACK - <<'JSON'
{"secretKey":"sk_live_…"}
JSON
```

- **Encrypted:** keys are stored encrypted and never shown again. To change them, run the command again; `payment-account-remove <tenantId> PAYFAST` deletes them.
- **Test accounts:** a PayFast sandbox account (`"sandbox":true`) or a Paystack `sk_test_` key is refused in production.
- **Two accounts:** if a business has both, PayFast is used unless its file sets `"paymentProvider"`.
- **Check it:** the owner's checklist (step 6) says where their money goes, and the R5 test payment (step 7) proves it end to end.

### B4. Fund the message wallet

Every WhatsApp reply is paid for from the business's prepaid wallet.

```sh
docker compose exec api node dist/cli/admin.js wallet-topup <tenantId> 200 EFT-2026-10-12
```

When the balance drops below R10, the owner gets a WhatsApp warning and the dashboard shows it.

### B5. Submit the WhatsApp templates

Messages sent outside WhatsApp's 24-hour reply window need templates that Meta has approved:

```sh
docker compose exec api node dist/cli/admin.js templates-submit <tenantId>
```

- **Checked before submitting:** templates are checked against Meta's rules first.
- **Approval time:** usually within a day. The result arrives through the webhook (A4).
- **Safe to re-run:** only rejected templates are resubmitted.
- **Status:** shown on the owner's checklist. If Meta moves a template from utility to marketing, which is billed higher, that's shown too.

### B6. Send the owner their setup link

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
6. **Online payments on:** shows the share customers pay upfront, and whether the money goes straight to your own PayFast or Paystack account.
7. **First test payment:**
   - Press **Send me a test payment link**.
   - A real **R5.00** link arrives in your WhatsApp; pay it just as a customer would.
   - The page turns green once the bank has confirmed it and your WhatsApp receipt has arrived.

   The test isn't counted as revenue. With your own payment account, the R5 lands in it like any other payment.

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
  - Shop orders show **🚚 Deliver to** with the customer's address, or **🏪 Collection**.
- **Products** (shops): set how many of each item you have. Orders take stock off as they're placed. Cancelled and unpaid orders put it back. Items at 0 are hidden from customers. Leave the box empty for items you don't count.
- **Payments:** every payment and its status. Payments marked **Review** need attention, for example an order you cancelled after the customer paid, which needs a refund:
  - **Paid into your own PayFast or Paystack account:** refund it from that provider's dashboard.
  - **Paid into the platform's account:** your operator handles the refund.
- **Wallet:** balance and what each message cost.

### C3. Good to know

- **How customers start:** they send **HI**, **Book** or **Price** to your number and get buttons: Book (or Shop Now), Prices, Location/Hours. Their first menu links your privacy notice.
- **How a shop order works:**
  1. The customer taps items to add them to a cart. Tapping again adds another.
  2. They tap **Checkout** and choose **Delivery** or **Collect**.
  3. For delivery, they type their address once. It's remembered for next time.
  4. They get one **Pay** button for the total, including the delivery fee.
  5. Stock is held for them until the link expires.
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
| A shop customer can't find an item | It's sold out (stock 0) or switched off. Check the **Products** tab. |
| A business's PayFast payments aren't confirming | The passphrase saved with `payment-account-set` must match the one in their PayFast developer settings exactly. Logs show `PayFast ITN signature mismatch` when it doesn't. |
| A business's Paystack payments aren't confirming | Its Paystack **Webhook URL** must be `https://app.yourdomain.co.za/api/payments/callback`, and the saved key must be the live secret key for that same account. |
| A payment was made but the booking isn't confirmed | The app re-checks unsettled Ozow and Paystack payments every 2 minutes. If it still shows **Review** on the dashboard, the amount or booking didn't match and needs a person to look. |

---

## Customer privacy (POPIA)

Each business is the **responsible party** for its customers' information; you, the platform operator, are its **operator** under POPIA. Before launch:

1. **Publish a privacy notice.** Fill in [`privacy-notice.md`](privacy-notice.md), publish it at an https address, and set `PRIVACY_NOTICE_URL` in `.env`. Each customer's first menu message links to it.
2. **Sign an operator agreement with each business** (section 21). It should say what you process, that you keep it secure, and that you tell them about any breach.
3. **Answer requests within a reasonable time.** When a customer asks a business what's held about them, or asks for it to be deleted:

```sh
# Everything held about the customer, as JSON, to send to them
docker compose exec api node dist/cli/admin.js customer-export <tenantId> 27821234567

# Delete: removes their number, name and addresses. Orders and payments stay
# without them, because financial records must be kept for five years.
docker compose exec api node dist/cli/admin.js customer-erase <tenantId> 27821234567
```

Erasing is refused while the customer has an open order or booking. Fulfil or cancel it first.

Message content isn't stored. The app keeps only who was messaged, when, and the cost.
