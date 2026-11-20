#!/usr/bin/env bash
# Nightly backup of a Zentico Workspace server: mail (Stalwart), workspace data (SQLite),
# config files and, when present, Nextcloud AIO files + database. Optionally uploads the
# archive to any rclone remote (an encrypted Google Drive "crypt" remote is the recommended one).
#
#   sudo ./backup.sh                 # run from the deploy dir (where compose.yaml lives)
#
# Settings come from the environment or from ./backup.env next to this script:
#   BACKUP_DIR=/var/backups/zentico-workspace  local archives (root-only)
#   KEEP_LOCAL=7                                local archives to keep
#   RCLONE_REMOTE=gcrypt:                       rclone remote, empty = local only
#   KEEP_DAYS=30                                days to keep on the remote
#   SERVICES="workspace"                        compose services whose /app/data is copied
#   EXCLUDE="downloads"                         top-level data entries to skip (rebuildable)
#   NEXTCLOUD=auto                              auto | no
#   EXTRA_PATHS=""                              more host paths to include
#   ALERT_EMAIL=you@example.com                 mailed on failure through the local Stalwart (port 25)
#   ALERT_FROM=backup@example.com
set -Eeuo pipefail

DEPLOY_DIR=${DEPLOY_DIR:-$(cd "$(dirname "$0")" && pwd)}
[ -f "$DEPLOY_DIR/backup.env" ] && . "$DEPLOY_DIR/backup.env"
BACKUP_DIR=${BACKUP_DIR:-/var/backups/zentico-workspace}
KEEP_LOCAL=${KEEP_LOCAL:-7}
RCLONE_REMOTE=${RCLONE_REMOTE:-}
KEEP_DAYS=${KEEP_DAYS:-30}
SERVICES=${SERVICES:-workspace}
EXCLUDE=${EXCLUDE:-downloads}
NEXTCLOUD=${NEXTCLOUD:-auto}
EXTRA_PATHS=${EXTRA_PATHS:-}
ALERT_EMAIL=${ALERT_EMAIL:-}
ALERT_FROM=${ALERT_FROM:-backup@$(hostname -f 2>/dev/null || hostname)}

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
cd "$DEPLOY_DIR"
umask 077
TS=$(date -u +%Y%m%d-%H%M)
STAGE=$(mktemp -d /var/tmp/zw-backup.XXXXXX)
STALWART_STOPPED=0
log() { echo "$(date -u +%FT%TZ) $*"; }

alert() {
  [ -n "$ALERT_EMAIL" ] || return 0
  local domain=${ALERT_FROM#*@}
  # Full headers and a real EHLO domain: Stalwart rejects bare hostnames and spam-scores headerless mail.
  printf 'From: %s\r\nTo: %s\r\nDate: %s\r\nMessage-ID: <backup-%s-%s@%s>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nSubject: [backup] FAILED on %s\r\n\r\n%s\r\n' \
    "$ALERT_FROM" "$ALERT_EMAIL" "$(date -R)" "$(date +%s)" "$$" "$domain" "$(hostname)" "$1" |
    curl -s --max-time 30 --url "smtp://127.0.0.1:25/$domain" --mail-from "$ALERT_FROM" \
      --mail-rcpt "$ALERT_EMAIL" --upload-file - || true
}

cleanup() {
  [ "$STALWART_STOPPED" = 1 ] && docker compose start stalwart >/dev/null 2>&1 || true
  rm -rf "$STAGE"
}
trap cleanup EXIT
trap 'rc=$?; log "FAILED (line $LINENO, exit $rc)"; alert "Backup failed at line $LINENO (exit $rc). See the backup log."; exit $rc' ERR

# Host path of a container's mount, e.g. mount_src workspace-workspace-1 /app/data
mount_src() {
  docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}" "$1" 2>/dev/null
}

# SQLite files go through .backup (consistent while the app runs); the rest is copied.
copy_data_dir() {
  local src=$1 dst=$2 skip
  mkdir -p "$dst"
  (cd "$src" && find . -type f ! -name '*-wal' ! -name '*-shm' ! -name '*-journal') | while read -r f; do
    for skip in $EXCLUDE; do case "$f" in ./"$skip"|./"$skip"/*) continue 2 ;; esac; done
    mkdir -p "$dst/$(dirname "$f")"
    case "$f" in
      *.sqlite|*.sqlite3|*.db) sqlite3 "$src/$f" ".backup '$dst/$f'" ;;
      *) cp -p "$src/$f" "$dst/$f" ;;
    esac
  done
}

log "backup start"

# 1. Config: compose, Caddyfile, env files, service configs (secrets included: keep the archive private).
mkdir -p "$STAGE/config"
find . -maxdepth 1 -type f \( -name 'compose.yaml' -o -name 'Caddyfile' -o -name '*.env' -o -name '.env' \
  -o -name '*.yaml' -o -name '*.sh' -o -name '*.json' \) -exec cp -p {} "$STAGE/config/" \;

# 2. App data of each compose service (SQLite-safe).
for svc in $SERVICES; do
  cid=$(docker compose ps -q "$svc" 2>/dev/null || true)
  [ -n "$cid" ] || { log "skip $svc (not running)"; continue; }
  src=$(mount_src "$cid" /app/data)
  [ -n "$src" ] || { log "skip $svc (no /app/data mount)"; continue; }
  copy_data_dir "$src" "$STAGE/data/$svc"
  log "copied $svc data"
done

# 3. Mail: Stalwart's RocksDB store needs a stopped server for a consistent copy (a few seconds;
#    senders retry anything that arrives meanwhile).
if [ -d ./stalwart ] && docker compose ps -q stalwart >/dev/null 2>&1 && [ -n "$(docker compose ps -q stalwart)" ]; then
  docker compose stop -t 20 stalwart >/dev/null 2>&1
  STALWART_STOPPED=1
  cp -a ./stalwart "$STAGE/stalwart"
  rm -rf "$STAGE/stalwart/logs"
  docker compose start stalwart >/dev/null 2>&1
  STALWART_STOPPED=0
  log "copied mail store"
fi

# 4. Nextcloud AIO (optional): database dump + data directory.
if [ "$NEXTCLOUD" != no ] && docker inspect nextcloud-aio-database >/dev/null 2>&1; then
  mkdir -p "$STAGE/nextcloud"
  docker exec nextcloud-aio-database sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$STAGE/nextcloud/database.sql.gz"
  ncdata=$(mount_src nextcloud-aio-nextcloud /mnt/ncdata)
  if [ -n "$ncdata" ]; then
    # Exit 1 = "file changed as we read it": acceptable for a live copy.
    tar -C "$ncdata" -cf "$STAGE/nextcloud/data.tar" . || [ $? -eq 1 ]
  fi
  log "copied nextcloud"
fi

# 5. Extra paths.
for p in $EXTRA_PATHS; do
  mkdir -p "$STAGE/extra$(dirname "$p")"
  cp -a "$p" "$STAGE/extra$p"
done

# 6. Archive.
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
ARCHIVE="$BACKUP_DIR/zw-backup-$TS.tar.gz"
tar -C "$STAGE" -czf "$ARCHIVE" .
log "archive $(du -h "$ARCHIVE" | cut -f1) $ARCHIVE"
ls -1t "$BACKUP_DIR"/zw-backup-*.tar.gz | tail -n +"$((KEEP_LOCAL + 1))" | xargs -r rm -f

# 7. Off-site copy.
if [ -n "$RCLONE_REMOTE" ]; then
  rclone copy "$ARCHIVE" "$RCLONE_REMOTE"
  rclone delete --min-age "${KEEP_DAYS}d" "$RCLONE_REMOTE"
  log "uploaded to $RCLONE_REMOTE"
fi

date -u +%FT%TZ > "$BACKUP_DIR/last-success"
log "backup done"
