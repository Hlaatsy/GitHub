# Launch guide

From a domain name to the first real customers paying on WhatsApp. Work through it in order. Each step says how to check it worked.

You need:
- the domain;
- a credit card for a small server;
- a Meta (Facebook) business account;
- for each business: its own WhatsApp number, and a PayFast or Paystack merchant account in its name.

---

## 1. Rent a server

Any Ubuntu 24.04 server with a public IP works. Hosting it in South Africa keeps replies quick and customer data in the country. POPIA allows hosting abroad, but local is simpler to explain to businesses.

| Size | Enough for |
| --- | --- |
| 2 vCPU, 4 GB RAM, 40 GB SSD | Your business plus a few others, comfortably |

Options with South African data centres include South African VPS providers (for example xneelo or Afrihost), Microsoft Azure *South Africa North* (Johannesburg) and AWS *af-south-1* (Cape Town). Compare current prices yourself. A local VPS is usually the cheapest for this size.

When creating it:
- choose **Ubuntu 24.04 LTS**;
- add your SSH key;
- write down the server's **public IPv4 address**.

**Check:** `ssh root@<ip>` logs you in.

## 2. Point your domain at it

At your domain registrar's DNS settings, add an **A record**:

| Type | Name | Value |
| --- | --- | --- |
| A | `app` (gives `app.yourdomain.co.za`) | the server's IPv4 address |

A sub-domain such as `app.` keeps your main website free for something else.

**Check:** `dig +short app.yourdomain.co.za` prints the IP. Changes can take up to an hour.

## 3. Set up Meta

Follow [onboarding.md A2](onboarding.md#a2-create-the-meta-app-and-a-permanent-token) to create the Meta app and a permanent system-user token. Also start these, because they take days:
- **Business verification** (Meta Business Settings → Security Centre). Unverified businesses have low messaging limits and can't go fully live.
- **Display name approval** for each WhatsApp number.

## 4. Deploy

On the server:

```sh
git clone <this repository> crm && cd crm
sudo DOMAIN=app.yourdomain.co.za ADMIN_EMAIL=you@yourdomain.co.za ./microcrm/deploy/deploy.sh
```

It asks for the Meta token and app secret. It then:
- installs everything and gets the HTTPS certificate;
- generates every other secret, including the key that encrypts businesses' payment accounts;
- tests the app end to end.

**Check:** `curl https://app.yourdomain.co.za/healthz` returns `{"status":"ok"}`.

**Back up `.env` now.** Copy `/var/www/whatsapp-crm/.env` to a password manager or another safe place off the server. Without it, a restored database can't be used: the stored payment accounts can't be decrypted.

## 5. Connect the webhook and privacy notice

1. **Webhook:** in Meta, set the callback URL and verify token that `deploy.sh` printed, and subscribe to `messages` ([onboarding.md A4](onboarding.md#a4-connect-the-webhook)).
2. **Privacy notice:** fill in [privacy-notice.md](privacy-notice.md) and publish it at an https address. Your main website is fine, as is a public Google Doc or Notion page.
3. **Wire it up:** set `PRIVACY_NOTICE_URL=` in `/var/www/whatsapp-crm/.env`, then run `docker compose up -d --force-recreate api`.

## 6. Add each business

Do [onboarding.md Part B](onboarding.md#part-b-adding-a-business-operator-per-business) for your own business first, then for each of the others:
1. register the number;
2. write the business file (shops: [example-shop.json](example-shop.json), with delivery, collection and stock);
3. **link its own PayFast or Paystack account**;
4. fund the wallet;
5. submit templates;
6. send the owner the setup link.

## 7. Test every payment path before real customers

Do this once per provider you use, with a **test** account, on a **staging** copy. Production refuses test accounts by design.

1. **Set up staging:** on a second (small) server, or the same one before launch, deploy with `NODE_ENV=development` in `.env`.
2. **Link test accounts:**
   - **PayFast:** a sandbox account from [sandbox.payfast.co.za](https://sandbox.payfast.co.za), saved with `"sandbox": true`.
   - **Paystack:** your account in **Test mode**, saved with its `sk_test_` key, with the test **Webhook URL** set to your staging domain.
3. **As a customer, from a phone that isn't the owner's:**
   - send **HI**, add two items, check out with **Delivery**, and type an address;
   - pay with the provider's test card or sandbox flow;
   - the order should turn **Paid** on the dashboard, a WhatsApp receipt should arrive, and stock should drop.
4. **Repeat with Collect,** and once more letting the link expire unpaid: after about 90 minutes the order is cancelled and its stock returns.
5. **Check the provider-specific details** I couldn't verify against current docs:
   - PayFast's checkout field order and ITN source hosts (`src/payments/payfast.ts`);
   - Paystack's webhook IPs, if you set `PAYSTACK_WEBHOOK_ALLOWED_IPS`.

   A mismatch fails safe: payments are refused, never wrongly accepted. The logs say why.

Then, in production, each owner does the **R5 test payment** on their checklist. That proves their live account end to end.

## 8. Keep it running

| What | How |
| --- | --- |
| **Off-server backups** | Nightly database dumps go to `/var/backups/whatsapp-crm` on the same server, which isn't enough. Copy them off daily, for example `rclone` to cloud storage or `scp` to another machine, and keep the `.env` copy from step 4 with them. Test a restore once. |
| **Uptime alerts** | A free monitor (UptimeRobot, Better Stack and so on) on `https://app.yourdomain.co.za/healthz` every 5 minutes, alerting your phone. |
| **Updates** | `git pull` in the checkout, then re-run `deploy.sh`. Migrations apply automatically. CI (`.github/workflows/microcrm-ci.yml`) must be green first. |
| **Logs** | `cd /var/www/whatsapp-crm && docker compose logs --tail 200 api`. |
| **Wallets** | Owners get a WhatsApp warning below R10. Top up with `wallet-topup` when they pay you. |
| **Meta limits** | Replies to customers who messaged first are not capped. Messages you start (templates) are limited per day until the business is verified and has a good quality rating. Watch quality in WhatsApp Manager. |

## Launch-day checklist

- [ ] `https://app.yourdomain.co.za/healthz` is OK and the uptime monitor is on
- [ ] `.env` is backed up off the server; backups are copied off nightly
- [ ] The Meta webhook is verified, and test messages get the menu
- [ ] The privacy notice is published and `PRIVACY_NOTICE_URL` is set
- [ ] Each business has its own payment account linked, and its owner's R5 test payment is green
- [ ] Sandbox tests passed for each provider (step 7)
- [ ] Shops: stock figures are entered and delivery fee and note are right
- [ ] Each business has signed an operator agreement with you (see [onboarding.md](onboarding.md#customer-privacy-popia))
