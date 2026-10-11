#!/usr/bin/env bash
# ==============================================================================
# WhatsApp micro-CRM: server deployment for Ubuntu 22.04 / 24.04 LTS
#
# Run from a checkout of this repository, as root:
#   sudo ./microcrm/deploy/deploy.sh
#
# Re-running is safe and is how you deploy updates: code is synced and the
# containers rebuilt, while existing secrets (.env), data and certificates
# are kept.
#
# Non-interactive use: export DOMAIN, ADMIN_EMAIL, WA_ACCESS_TOKEN and
# WA_APP_SECRET (and optionally OZOW_SITE_CODE, OZOW_API_KEY,
# OZOW_PRIVATE_KEY) before running.
# ==============================================================================

set -Eeuo pipefail

APP_DIR="${APP_DIR:-/var/www/whatsapp-crm}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGINX_SITE=/etc/nginx/sites-available/whatsapp-crm
ACME_ROOT=/var/www/certbot
BACKUP_DIR=/var/backups/whatsapp-crm
BACKUP_RETENTION_DAYS=7
APP_PORT=5000

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

step() { echo -e "\n${YELLOW}[$1/8] $2${NC}"; }
ok() { echo -e "${GREEN}✔ $*${NC}"; }
warn() { echo -e "${YELLOW}! $*${NC}" >&2; }
die() {
  echo -e "${RED}✘ $*${NC}" >&2
  exit 1
}
trap 'die "Failed at line ${LINENO}: ${BASH_COMMAND}"' ERR

# Reads a value from the environment, or prompts for it (silently for secrets).
ask() {
  local name=$1 message=$2 secret=${3:-}
  if [[ -z "${!name:-}" ]]; then
    [[ -t 0 ]] || die "$name is not set and there is no terminal to prompt on"
    if [[ -n "$secret" ]]; then
      read -rsp "$message: " "${name?}"
      echo
    else
      read -rp "$message: " "${name?}"
    fi
  fi
  [[ -n "${!name:-}" ]] || die "$name cannot be empty"
}

# Sets KEY=value in the app's .env without sed, so secrets with / + = & survive intact.
set_env() {
  local file="$APP_DIR/.env" tmp
  tmp=$(mktemp)
  KEY=$1 VALUE=$2 awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"] }
    index($0, k "=") == 1 { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" >"$tmp"
  cat "$tmp" >"$file" # keeps the file's 0600 mode
  rm -f "$tmp"
}

echo -e "${YELLOW}==================================================================${NC}"
echo -e "${GREEN}   🇿🇦 WhatsApp CRM deployment${NC}"
echo -e "${YELLOW}==================================================================${NC}"

# --- Preflight -----------------------------------------------------------------

[[ $EUID -eq 0 ]] || die "Run as root: sudo $0"
[[ -f "$SRC_DIR/docker-compose.yml" && -f "$SRC_DIR/deploy/nginx.conf" ]] ||
  die "Run this script from a checkout of the repository (expected files next to $SRC_DIR)"

# shellcheck source=/dev/null
. /etc/os-release
if [[ "${ID:-}" != ubuntu || ! "${VERSION_ID:-}" =~ ^(22|24)\.04$ ]]; then
  warn "Tested on Ubuntu 22.04/24.04; this is ${PRETTY_NAME:-unknown}. Continuing."
fi

ask DOMAIN "Domain name (e.g. app.yourdomain.co.za)"
DOMAIN=${DOMAIN,,}
# Validated because it is written into nginx config and certbot arguments.
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "'$DOMAIN' is not a valid domain name"

ask ADMIN_EMAIL "Admin email (Let's Encrypt expiry notices)"
[[ "$ADMIN_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "'$ADMIN_EMAIL' is not a valid email address"

FIRST_INSTALL=false
if [[ ! -f "$APP_DIR/.env" ]]; then
  FIRST_INSTALL=true
  ask WA_ACCESS_TOKEN "Meta WhatsApp system-user access token" secret
  ask WA_APP_SECRET "Meta app secret (signs webhooks)" secret
fi

# --- 1. Packages ---------------------------------------------------------------

step 1 "Installing system updates, Docker, nginx and certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold
apt-get install -yq ca-certificates curl openssl rsync ufw nginx certbot
# Leave an existing Docker (e.g. docker-ce from Docker's own repo) alone: docker.io conflicts with it.
command -v docker &>/dev/null || apt-get install -yq docker.io

# Compose v2 (`docker compose`); the apt `docker-compose` package is the retired v1.
if ! docker compose version &>/dev/null; then
  apt-get install -yq docker-compose-v2 || apt-get install -yq docker-compose-plugin ||
    die "Could not install Docker Compose v2"
fi
systemctl enable --now docker nginx
ok "$(docker --version), $(docker compose version)"

# --- 2. Firewall ---------------------------------------------------------------

step 2 "Configuring the firewall"
# Allow whichever port(s) sshd really listens on, so a custom port cannot lock you out.
mapfile -t SSH_PORTS < <(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' | sort -u)
[[ ${#SSH_PORTS[@]} -gt 0 ]] || SSH_PORTS=(22)
ufw default deny incoming
ufw default allow outgoing
for port in "${SSH_PORTS[@]}"; do
  ufw limit "${port}/tcp" comment 'ssh (rate limited)'
done
ufw allow 80/tcp comment 'http (ACME + redirect)'
ufw allow 443/tcp comment 'https'
ufw --force enable
# Docker publishes ports through its own iptables chains, bypassing UFW. The
# compose file binds the API to 127.0.0.1 only; this is re-checked in step 7.
ok "SSH allowed on port(s) ${SSH_PORTS[*]}; only 80/443 open otherwise"

# --- 3. Application code -------------------------------------------------------

step 3 "Syncing application code to $APP_DIR"
mkdir -p "$APP_DIR"
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  rsync -a --delete --exclude node_modules --exclude dist --exclude .env --exclude .git "$SRC_DIR/" "$APP_DIR/"
fi
ok "Code in place"

# --- 4. Secrets ----------------------------------------------------------------

step 4 "Preparing secrets"
if [[ "$FIRST_INSTALL" == true ]]; then
  install -m 600 -o root -g root "$APP_DIR/.env.example" "$APP_DIR/.env"
  # Hex keeps the password URL-safe inside DATABASE_URL.
  POSTGRES_PASSWORD=$(openssl rand -hex 24)
  set_env POSTGRES_USER crm_user
  set_env POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
  set_env POSTGRES_DB whatsapp_crm
  set_env DATABASE_URL "postgresql://crm_user:${POSTGRES_PASSWORD}@postgres:5432/whatsapp_crm?schema=public"
  set_env WA_VERIFY_TOKEN "$(openssl rand -hex 24)"
  set_env WA_ACCESS_TOKEN "$WA_ACCESS_TOKEN"
  set_env WA_APP_SECRET "$WA_APP_SECRET"
  set_env OZOW_IS_TEST false
  for key in OZOW_SITE_CODE OZOW_API_KEY OZOW_PRIVATE_KEY; do
    if [[ -n "${!key:-}" ]]; then set_env "$key" "${!key}"; fi
  done
  ok "Generated .env with random database password and webhook verify token"
else
  ok "Keeping existing .env (database password must not change once the volume exists)"
fi
set_env NODE_ENV production
set_env PORT "$APP_PORT"
set_env PUBLIC_BASE_URL "https://$DOMAIN"
chmod 600 "$APP_DIR/.env"
VERIFY_TOKEN=$(awk -F= '$1 == "WA_VERIFY_TOKEN" { print substr($0, index($0, "=") + 1) }' "$APP_DIR/.env")

# --- 5. TLS certificate ----------------------------------------------------------

step 5 "Obtaining the TLS certificate"
CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
mkdir -p "$ACME_ROOT"
rm -f /etc/nginx/sites-enabled/default

if [[ ! -f "$CERT" ]]; then
  # Bootstrap: plain-HTTP site that only serves ACME challenges, so nginx can
  # start before any certificate exists.
  cat >"$NGINX_SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $ACME_ROOT; }
    location / { return 404; }
}
EOF
  ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/whatsapp-crm
  nginx -t
  systemctl reload nginx

  # Fail early with a clear message instead of burning Let's Encrypt rate limits.
  RESOLVED=$(getent ahostsv4 "$DOMAIN" | awk '{ print $1 }' | sort -u | tr '\n' ' ' || true)
  PUBLIC_IP=$(curl -fsS4 --max-time 5 https://api.ipify.org || true)
  [[ -n "$RESOLVED" ]] || die "$DOMAIN does not resolve. Create an A record pointing to ${PUBLIC_IP:-this server} first."
  if [[ -n "$PUBLIC_IP" && " $RESOLVED " != *" $PUBLIC_IP "* ]]; then
    die "$DOMAIN resolves to ${RESOLVED% } but this server's public IP is $PUBLIC_IP. Fix DNS first."
  fi

  # Webroot (not --standalone): renewals then work while nginx keeps running.
  certbot certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" \
    --email "$ADMIN_EMAIL" --agree-tos --non-interactive --no-eff-email \
    --deploy-hook "systemctl reload nginx"
fi
ok "Certificate present at $CERT"

# --- 6. nginx ------------------------------------------------------------------

step 6 "Configuring nginx"
# The template's ACME root is /var/www/certbot, the same as ACME_ROOT here.
sed "s/yourdomain\.co\.za/${DOMAIN}/g" "$APP_DIR/deploy/nginx.conf" >"$NGINX_SITE"
ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/whatsapp-crm
nginx -t
systemctl reload nginx
if certbot renew --dry-run --cert-name "$DOMAIN" &>/dev/null; then
  ok "nginx serving https://$DOMAIN; automatic renewal verified"
else
  warn "Renewal dry run failed; check 'certbot renew --dry-run' before the certificate expires"
fi

# --- 7. Application --------------------------------------------------------------

step 7 "Building and starting the application"
cd "$APP_DIR"
docker compose up -d --build --remove-orphans

healthy=false
for _ in $(seq 1 45); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT}/healthz" &>/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  docker compose logs --tail 60 api >&2 || true
  die "The API did not become healthy (logs above)"
fi

if ss -Hltn "sport = :${APP_PORT}" | awk '{ print $4 }' | grep -Evq '^(127\.0\.0\.1|\[::1\]):'; then
  die "Port ${APP_PORT} is listening on a public interface; Docker bypasses UFW. Bind it to 127.0.0.1 in docker-compose.yml."
fi

# End-to-end through nginx/TLS, including Meta's verification handshake.
curl -fsS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz" >/dev/null ||
  die "https://$DOMAIN/healthz is not reachable through nginx"
CHALLENGE=$RANDOM$RANDOM
ECHO=$(curl -fsS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" \
  "https://$DOMAIN/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${CHALLENGE}" || true)
[[ "$ECHO" == "$CHALLENGE" ]] || die "WhatsApp webhook verification handshake failed"
ok "API healthy, private to localhost, and answering Meta's handshake over TLS"

# --- 8. Backups ----------------------------------------------------------------

step 8 "Scheduling nightly database backups"
cat >/etc/cron.daily/whatsapp-crm-backup <<EOF
#!/bin/sh
# Nightly dump of the CRM database, readable by root only, kept ${BACKUP_RETENTION_DAYS} days
# (POPIA s14: do not retain personal information longer than needed).
set -eu
umask 077
mkdir -p "${BACKUP_DIR}"
cd "${APP_DIR}"
docker compose exec -T postgres sh -c 'pg_dump -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" --format=custom' \\
  > "${BACKUP_DIR}/crm-\$(date +%F).dump"
find "${BACKUP_DIR}" -name 'crm-*.dump' -mtime +${BACKUP_RETENTION_DAYS} -delete
EOF
chmod 700 /etc/cron.daily/whatsapp-crm-backup
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
ok "Backups go to $BACKUP_DIR (copy them off this server too)"

# --- Done ------------------------------------------------------------------------

echo -e "\n${GREEN}==================================================================${NC}"
echo -e "${GREEN}   Deployment complete and verified${NC}"
echo -e "${GREEN}==================================================================${NC}"
echo -e "Configure the webhook in Meta (App Dashboard → WhatsApp → Configuration):"
echo -e "  Callback URL:  ${GREEN}https://$DOMAIN/webhooks/whatsapp${NC}"
if [[ "$FIRST_INSTALL" == true ]]; then
  echo -e "  Verify token:  ${GREEN}${VERIFY_TOKEN}${NC}  (also stored in $APP_DIR/.env)"
else
  echo -e "  Verify token:  WA_VERIFY_TOKEN in $APP_DIR/.env"
fi
echo -e "  Subscribe to:  messages"
echo -e "Payments webhook (sent to Ozow per payment): https://$DOMAIN/webhooks/payments"
echo -e "Next: get the WhatsApp templates in README.md approved, then send HI to the business number."
