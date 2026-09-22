# Deploying to Fly.io

Fly runs a plain Python process and gives you a persistent volume without a
separate database service, which is what this app needs: it is standard
library only and stores everything in one SQLite file.

Nothing here has been run against a real Fly account — the app, the Dockerfile
settings and the safety checks below were tested locally, but the deploy
itself is yours to run.

## Before you start

You need a Fly account, the `flyctl` CLI, and a domain you control. The
domain is not optional: `IDENTICAL_BASE_URL` is used for sign-in links,
invitation links and Paystack callbacks, and all three break if it is wrong.

    curl -L https://fly.io/install.sh | sh
    fly auth signup        # or: fly auth login

## 1. Create the app and its volume

    cd projects/identical/app
    fly apps create identical            # or edit `app` in fly.toml
    fly volumes create identical_data --region jnb --size 1

One gigabyte is far more than this needs — SQLite plus a few thousand
accounts is megabytes — but it is the smallest Fly sells and it is cheap.

## 2. Set the secrets

    fly secrets set \
      IDENTICAL_SECRET="$(python -c 'import secrets;print(secrets.token_hex(32))')" \
      IDENTICAL_BASE_URL="https://app.yourdomain.co.za" \
      IDENTICAL_SMTP_HOST="smtp.your-provider.net" \
      IDENTICAL_SMTP_PORT="587" \
      IDENTICAL_SMTP_USER="..." \
      IDENTICAL_SMTP_PASSWORD="..." \
      IDENTICAL_MAIL_FROM="IDENTICAL <no-reply@yourdomain.co.za>" \
      PAYSTACK_SECRET_KEY="sk_live_..."

**`IDENTICAL_SECRET` is not optional.** The app refuses to start over https
without it, on purpose: unset, it generates a new key on every boot, which
signs every user out on each deploy and makes a second machine unable to read
the first's sessions. Generate it once and keep it.

Leave `PAYSTACK_SECRET_KEY` out and the app runs against a stub gateway that
treats every checkout as paid. Fine for a staging app. Catastrophic on a
production one, so set it.

## 3. Deploy

    fly deploy
    fly certs create app.yourdomain.co.za     # then add the DNS records it prints

`force_https` is on and session cookies are marked `Secure`, so the site must
be reached over https. That is handled by Fly's edge; you do not terminate TLS
yourself.

## 4. Point Paystack at it

In the Paystack dashboard, set the webhook URL to:

    https://app.yourdomain.co.za/payments/webhook

The endpoint verifies Paystack's HMAC-SHA512 signature and rejects anything
unsigned, so there is nothing else to configure — but it will silently do
nothing until the URL is set, and payments will then only settle on the
customer's return rather than on the webhook.

## 5. Check it came up

    fly status
    fly logs
    curl https://app.yourdomain.co.za/healthz      # expects: ok

Then sign in with a real address and confirm the email arrives. That single
test exercises the database, the volume, the base URL and SMTP at once.

## One machine, deliberately

`fly.toml` mounts one volume and runs one machine. That is not a placeholder:
SQLite is a single file on a single volume, so a second machine would be a
second database rather than a second copy of the same one, and customers
would see different data depending on which machine answered.

Scaling past one machine means moving to Postgres first. The schema was
written with that in mind — no SQLite-only types, explicit foreign keys, UTC
ISO-8601 timestamps — so it is a migration rather than a rewrite. Do it when
one machine is genuinely the constraint, which for a pilot it will not be.

    auto_stop_machines = "suspend"
    min_machines_running = 0

The machine suspends when idle and wakes on the next request, so an overnight
pilot costs almost nothing. First request after a suspend is slower.

## Backups

Fly volumes are snapshotted daily by default, but a snapshot is not a backup
you have tested. The whole database is one file:

    fly ssh console -C "cat /data/identical.db" > backup-$(date +%F).db

Run that before any deploy that touches `db.py`, and once you have paying
customers, run it on a schedule that is not your memory.

## What is still missing before real customers

- **Recurring billing.** A plan change charges once; nothing renews it next
  month. See the payments section in `README.md`.
- **A real video provider.** `app/provider.py` is a stub — the app runs end to
  end but renders nothing. This is the gap that makes the deployment a demo
  rather than a product.
- **Async rendering.** Rendering is synchronous, which is fine against a stub
  and wrong against a provider that takes forty seconds.
