#!/usr/bin/env bash
# One-command setup of Zentico Workspace on a fresh Ubuntu 22.04/24.04 server (see README →
# Self-hosting). Run from a clone of the repository:
#
#   sudo ./deploy/install.sh                                   # asks for the domain and e-mail
#   sudo ./deploy/install.sh --domain example.com --email admin@example.com --yes [--office] [--whisper]
#
# Options (or the environment variable in brackets):
#   --domain <domain>   base domain; the app is team.<domain>                      [DOMAIN]
#   --email <address>   Let's Encrypt e-mail and first workspace admin             [ADMIN_EMAIL]
#   --ip <address>      public IPv4 of this server (default: detected)             [PUBLIC_IP]
#   --office            also run Collabora Online (Docs) at office.<domain>        [WITH_OFFICE=1]
#   --whisper           also run a Whisper server for meeting transcripts          [WITH_WHISPER=1]
#   --yes               non-interactive: never prompt                              [ASSUME_YES=1]
#   --skip-dns-check    don't wait for the DNS records to resolve to this server   [SKIP_DNS_CHECK=1]
#   --sync-certs        only copy Caddy's mail.<domain> certificate to Stalwart (run daily by cron)
#
# Safe to re-run: existing secrets and config files are never overwritten (delete a rendered file to
# regenerate it from its .example). Secrets are written to files readable by root only and are
# never printed.
set -euo pipefail

# Root is needed for Docker, apt, ufw and file ownership.
[ "$(id -u)" -eq 0 ] || exec sudo -E bash "$0" "$@"

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DEPLOY_DIR"

DOMAIN="${DOMAIN:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
PUBLIC_IP="${PUBLIC_IP:-}"
WITH_OFFICE="${WITH_OFFICE:-0}"
WITH_WHISPER="${WITH_WHISPER:-0}"
ASSUME_YES="${ASSUME_YES:-0}"
SKIP_DNS_CHECK="${SKIP_DNS_CHECK:-0}"
SYNC_CERTS_ONLY=0
STALWART_UID=2000

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --ip) PUBLIC_IP="${2:-}"; shift 2 ;;
    --office) WITH_OFFICE=1; shift ;;
    --whisper) WITH_WHISPER=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --skip-dns-check) SKIP_DNS_CHECK=1; shift ;;
    --sync-certs) SYNC_CERTS_ONLY=1; shift ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# ---------- helpers ----------

# get_kv <file> <key>: value of KEY=value (empty when missing).
get_kv() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | tail -n1 || true; }

# set_kv <file> <key> <value>: replace or append KEY=value (values here never contain "|" or newlines).
set_kv() {
  if grep -q "^$2=" "$1"; then sed -i "s|^$2=.*|$2=$3|" "$1"; else printf '%s=%s\n' "$2" "$3" >>"$1"; fi
}

# A placeholder or empty value needs a generated secret.
unset_secret() { [ -z "$1" ] || [[ "$1" == CHANGE_ME_* ]] || [[ "$1" == *:CHANGE_ME_* ]]; }

ask() { # ask <prompt> <default> → answer on stdout
  local answer
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then printf '%s' "$2"; return; fi
  read -r -p "$1${2:+ [$2]}: " answer
  printf '%s' "${answer:-$2}"
}

confirm() { # confirm <prompt> → 0 for yes
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  local answer
  read -r -p "$1 [y/N]: " answer
  [[ "$answer" =~ ^[Yy] ]]
}

valid_domain() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]]; }
valid_email() { [[ "$1" =~ ^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$ ]]; }

# Copies Caddy's certificate for mail.<domain> to stalwart/certs (readable by Stalwart's user) and
# restarts Stalwart when it changed. Point Stalwart's TLS certificate at
# /opt/stalwart/certs/fullchain.pem and /opt/stalwart/certs/privkey.pem.
sync_certs() {
  local domain crt key
  domain="$(get_kv .env DOMAIN)"
  [ -n "$domain" ] || die "DOMAIN is not set in $DEPLOY_DIR/.env"
  crt="$(find caddy/data/caddy/certificates -path "*/mail.$domain/mail.$domain.crt" 2>/dev/null | head -n1 || true)"
  key="${crt%.crt}.key"
  if [ -z "$crt" ] || [ ! -f "$key" ]; then
    warn "no certificate for mail.$domain from Caddy yet (DNS and ports 80/443 must work first)"
    return 0
  fi
  mkdir -p stalwart/certs
  if cmp -s "$crt" stalwart/certs/fullchain.pem && cmp -s "$key" stalwart/certs/privkey.pem; then return 0; fi
  install -o "$STALWART_UID" -g "$STALWART_UID" -m 644 "$crt" stalwart/certs/fullchain.pem
  install -o "$STALWART_UID" -g "$STALWART_UID" -m 600 "$key" stalwart/certs/privkey.pem
  log "Updated Stalwart's copy of the mail.$domain certificate"
  if docker compose ps --status running --services 2>/dev/null | grep -qx stalwart; then
    docker compose restart stalwart >/dev/null
  fi
}

if [ "$SYNC_CERTS_ONLY" = 1 ]; then sync_certs; exit 0; fi

# ---------- 1. prerequisites ----------

log "Checking the system"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:22.04|ubuntu:24.04) ;;
    *) warn "tested on Ubuntu 22.04/24.04, this is ${PRETTY_NAME:-unknown}"; confirm "Continue anyway?" || exit 1 ;;
  esac
fi
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
[ "$mem_mb" -ge 3500 ] || warn "only ${mem_mb} MB of RAM; 4 GB or more is recommended (8 GB with Collabora and Whisper)"

missing=()
for cmd in curl openssl dig awk; do command -v "$cmd" >/dev/null || missing+=("$cmd"); done
if [ ${#missing[@]} -gt 0 ]; then
  log "Installing ${missing[*]}"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl openssl dnsutils gawk >/dev/null
fi

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  log "Installing Docker Engine and the Compose plugin from Docker's apt repository"
  # The method from https://docs.docker.com/engine/install/ubuntu/ (no third-party script is run).
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker >/dev/null
fi
docker compose version >/dev/null || die "docker compose is not available"

# ---------- 2. inputs ----------

[ -f .env ] || { install -m 600 .env.example .env; log "Created deploy/.env"; }
chmod 600 .env

existing_domain="$(get_kv .env DOMAIN)"
[ "$existing_domain" = example.com ] && existing_domain=""
if [ -z "$DOMAIN" ]; then DOMAIN="$(ask "Base domain (the app will be team.<domain>)" "$existing_domain")"; fi
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
valid_domain "$DOMAIN" || die "invalid domain: '$DOMAIN' (pass --domain example.com)"
if [ -n "$existing_domain" ] && [ "$existing_domain" != "$DOMAIN" ]; then
  die "deploy/.env is already set up for $existing_domain; changing the domain is not automated"
fi

existing_email="$(get_kv .env ACME_EMAIL)"
[ "$existing_email" = admin@example.com ] && existing_email=""
if [ -z "$ADMIN_EMAIL" ]; then ADMIN_EMAIL="$(ask "Admin e-mail (Let's Encrypt notices)" "${existing_email:-admin@$DOMAIN}")"; fi
valid_email "$ADMIN_EMAIL" || die "invalid e-mail: '$ADMIN_EMAIL' (pass --email you@example.com)"

profiles="$(get_kv .env COMPOSE_PROFILES)"
[[ ",$profiles," == *,office,* ]] && WITH_OFFICE=1
[[ ",$profiles," == *,whisper,* ]] && WITH_WHISPER=1
if [ "$ASSUME_YES" != 1 ] && [ -t 0 ]; then
  [ "$WITH_OFFICE" = 1 ] || { confirm "Run Collabora Online for office documents (office.$DOMAIN)?" && WITH_OFFICE=1 || true; }
  [ "$WITH_WHISPER" = 1 ] || { confirm "Run a Whisper server for meeting transcripts (CPU heavy)?" && WITH_WHISPER=1 || true; }
fi
profiles=""
[ "$WITH_OFFICE" = 1 ] && profiles="office"
[ "$WITH_WHISPER" = 1 ] && profiles="${profiles:+$profiles,}whisper"

if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -4 -fsS --max-time 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
fi
[[ "$PUBLIC_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "could not detect the public IPv4; pass --ip <address>"

# ---------- 3. secrets and config files ----------

log "Writing configuration for $DOMAIN"
set_kv .env DOMAIN "$DOMAIN"
set_kv .env ACME_EMAIL "$ADMIN_EMAIL"
set_kv .env COMPOSE_PROFILES "$profiles"
unset_secret "$(get_kv .env STALWART_RECOVERY_ADMIN)" && set_kv .env STALWART_RECOVERY_ADMIN "admin:$(openssl rand -hex 16)"
unset_secret "$(get_kv .env LIVEKIT_API_KEY)" && set_kv .env LIVEKIT_API_KEY "ZW$(openssl rand -hex 8)"
unset_secret "$(get_kv .env LIVEKIT_API_SECRET)" && set_kv .env LIVEKIT_API_SECRET "$(openssl rand -hex 32)"
unset_secret "$(get_kv .env SESSION_SECRET)" && set_kv .env SESSION_SECRET "$(openssl rand -hex 32)"
unset_secret "$(get_kv .env OIDC_CLIENT_SECRET)" && set_kv .env OIDC_CLIENT_SECRET "$(openssl rand -hex 32)"

# render <template> <target> <mode>: fill in the domain, e-mail and secrets; never overwrites.
render() {
  if [ -f "$2" ]; then log "Keeping existing deploy/$2"; return; fi
  local tmp
  tmp="$(mktemp)"
  sed -e "s/admin@example\.com/$ADMIN_EMAIL/g" \
      -e "s/example\.com/$DOMAIN/g" \
      -e "s/CHANGE_ME_LIVEKIT_API_KEY/$(get_kv .env LIVEKIT_API_KEY)/g" \
      -e "s/CHANGE_ME_LIVEKIT_API_SECRET/$(get_kv .env LIVEKIT_API_SECRET)/g" \
      -e "s/CHANGE_ME_SESSION_SECRET/$(get_kv .env SESSION_SECRET)/g" \
      -e "s/CHANGE_ME_OIDC_CLIENT_SECRET/$(get_kv .env OIDC_CLIENT_SECRET)/g" \
      "$1" >"$tmp"
  install -m "$3" "$tmp" "$2"
  rm -f "$tmp"
  log "Created deploy/$2"
}

new_workspace_env=0
[ -f workspace.env ] || new_workspace_env=1
render workspace.env.example workspace.env 600
if [ "$new_workspace_env" = 1 ]; then
  # Only an account on the workspace domain can be an app admin.
  [[ "$ADMIN_EMAIL" == *@"$DOMAIN" ]] || set_kv workspace.env WORKSPACE_ADMINS ""
  [ "$WITH_OFFICE" = 1 ] && set_kv workspace.env COLLABORA_URL "https://office.$DOMAIN"
  [ "$WITH_WHISPER" = 1 ] && set_kv workspace.env WHISPER_URL "http://whisper:8000"
else
  [ "$WITH_OFFICE" = 1 ] && [ -z "$(get_kv workspace.env COLLABORA_URL)" ] && set_kv workspace.env COLLABORA_URL "https://office.$DOMAIN"
  [ "$WITH_WHISPER" = 1 ] && [ -z "$(get_kv workspace.env WHISPER_URL)" ] && set_kv workspace.env WHISPER_URL "http://whisper:8000"
fi
chmod 600 workspace.env

render livekit.yaml.example livekit.yaml 600
render egress.yaml.example egress.yaml 600
if [ ! -f Caddyfile ]; then
  render Caddyfile.example Caddyfile 644
  [ "$WITH_OFFICE" = 1 ] || sed -i '/^# BEGIN office/,/^# END office/d' Caddyfile
elif [ "$WITH_OFFICE" = 1 ] && ! grep -q "office\.$DOMAIN" Caddyfile; then
  printf '\noffice.%s {\n\treverse_proxy localhost:9980\n}\n' "$DOMAIN" >>Caddyfile
  log "Added office.$DOMAIN to deploy/Caddyfile"
fi

mkdir -p stalwart/etc stalwart/data stalwart/logs stalwart/certs caddy/data caddy/config
[ -f stalwart/etc/config.json ] || install -m 600 stalwart-config.json stalwart/etc/config.json
chown -R "$STALWART_UID:$STALWART_UID" stalwart

# ---------- 4. DNS ----------

hosts=(team mail meet)
[ "$WITH_OFFICE" = 1 ] && hosts+=(office)
cat <<EOF

DNS records to create at your DNS provider for $DOMAIN (server IP $PUBLIC_IP):

  Type  Name                 Value
EOF
for h in "${hosts[@]}"; do printf '  A     %-20s %s\n' "$h.$DOMAIN" "$PUBLIC_IP"; done
cat <<EOF
  MX    $DOMAIN$(printf '%*s' $((20 - ${#DOMAIN})) '') 10 mail.$DOMAIN
  TXT   $DOMAIN$(printf '%*s' $((20 - ${#DOMAIN})) '') "v=spf1 mx -all"
  TXT   _dmarc.$DOMAIN$(printf '%*s' $((13 - ${#DOMAIN})) '') "v=DMARC1; p=quarantine; rua=mailto:postmaster@$DOMAIN"
  DKIM  the record Stalwart's admin shows for $DOMAIN after you add the domain

Also ask your hosting provider to set the reverse DNS (PTR) of $PUBLIC_IP to mail.$DOMAIN
and to allow outbound port 25.

EOF

dns_ok() {
  local h ip
  for h in "${hosts[@]}"; do
    ip="$(dig +short A "$h.$DOMAIN" @1.1.1.1 | tail -n1)"
    [ "$ip" = "$PUBLIC_IP" ] || { printf '  %s.%s → %s\n' "$h" "$DOMAIN" "${ip:-no record}"; return 1; }
  done
}
if [ "$SKIP_DNS_CHECK" != 1 ]; then
  log "Checking the A records (needed for the HTTPS certificates)"
  waited=0
  until dns_ok; do
    if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then
      [ "$waited" -ge 900 ] && die "DNS still doesn't point at $PUBLIC_IP after 15 minutes; re-run later or pass --skip-dns-check"
      sleep 30; waited=$((waited + 30))
    else
      confirm "DNS doesn't point at this server yet. Check again? (No = continue anyway)" || break
    fi
  done
fi

# ---------- 5. firewall ----------

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  log "Opening ports in ufw"
  for p in 22/tcp 80/tcp 443/tcp 443/udp 25/tcp 465/tcp 587/tcp 993/tcp 7881/tcp 7882/udp; do ufw allow "$p" >/dev/null; done
else
  log "ufw is not active; make sure your provider's firewall allows TCP 80, 443, 25, 465, 587, 993, 7881 and UDP 7882"
fi

# ---------- 6. start ----------

log "Building the app image and starting the services (the first build takes a few minutes)"
docker compose build workspace
docker compose up -d

wait_for() { # wait_for <name> <url> <seconds>
  local i=0
  until curl -fsS -o /dev/null --max-time 5 "$2"; do
    i=$((i + 5)); [ "$i" -ge "$3" ] && { warn "$1 is not answering at $2 yet (docker compose logs $1)"; return 1; }
    sleep 5
  done
  log "$1 is up"
}
health=0
wait_for stalwart http://127.0.0.1:8081/healthz/live 180 || health=1
wait_for workspace http://127.0.0.1:3100/api/workspace-info 180 || health=1
wait_for livekit http://127.0.0.1:7880/ 120 || health=1
if [ "$SKIP_DNS_CHECK" != 1 ]; then wait_for "HTTPS (team.$DOMAIN)" "https://team.$DOMAIN/api/workspace-info" 240 || health=1; fi

sync_certs
cron=/etc/cron.d/zentico-workspace-certs
if [ ! -f "$cron" ]; then
  printf '# Copy renewed mail.%s certificates to Stalwart.\n17 4 * * * root %s --sync-certs >/dev/null 2>&1\n' "$DOMAIN" "$DEPLOY_DIR/install.sh" >"$cron"
  chmod 644 "$cron"
fi

# ---------- 7. next steps ----------

cat <<EOF

$( [ "$health" = 0 ] && echo "All services are running." || echo "Some checks failed; see the warnings above and 'docker compose ps'." )

Next steps (README → Self-hosting has the details):

1. Stalwart admin: https://mail.$DOMAIN/admin
   user "admin"; password: sudo grep STALWART_RECOVERY_ADMIN $DEPLOY_DIR/.env   (after "admin:")
   - set the server hostname to mail.$DOMAIN and add the domain $DOMAIN
   - TLS certificate: /opt/stalwart/certs/fullchain.pem and /opt/stalwart/certs/privkey.pem
     (copied from Caddy; renewed daily by $cron)
   - publish the DKIM record it shows for $DOMAIN
   - create the user accounts (e.g. ${ADMIN_EMAIL%@*}@$DOMAIN)

2. In Stalwart, create the OAuth (OIDC) client for the app:
   client ID      zentico-workspace
   client secret  sudo grep OIDC_CLIENT_SECRET $DEPLOY_DIR/workspace.env
   redirect URI   https://team.$DOMAIN/api/auth/callback
   scopes         openid, offline_access, mail, contacts, calendars, files and the "security" scope

3. Sign in at https://team.$DOMAIN with a Stalwart account.

Re-running this script is safe; it keeps every secret and file it already wrote.
EOF
