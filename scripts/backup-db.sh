#!/usr/bin/env bash
# Back up CraftYap's SEPARATE SQLite leaderboard (independent of poke).
# Safe hot backup via sqlite3 .backup (handles the WAL). Keeps 14 days.
# Cron example (daily 04:30):
#   30 4 * * * /srv/craftyap/app/scripts/backup-db.sh >> /srv/craftyap/logs/backup.log 2>&1
set -euo pipefail

DB_DIR="${DB_DIR:-/srv/craftyap/data}"
DB="${DB_DIR}/records.db"
OUT_DIR="${OUT_DIR:-/srv/craftyap/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "${OUT_DIR}"
if [[ ! -f "${DB}" ]]; then
  echo "no db at ${DB} (nothing to back up yet)"
  exit 0
fi

STAMP="$(date +%F_%H%M%S)"
DEST="${OUT_DIR}/records-${STAMP}.db"
sqlite3 "${DB}" ".backup '${DEST}'"
gzip -f "${DEST}"
echo "backed up → ${DEST}.gz"

# prune old backups
find "${OUT_DIR}" -name 'records-*.db.gz' -mtime "+${KEEP_DAYS}" -delete
