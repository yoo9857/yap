#!/usr/bin/env bash
# Back up CraftYap's SEPARATE SQLite db — daily leaderboard + saved classrooms
# (independent of poke).
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
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "${DB}" ".backup '${DEST}'"
else
  # no host sqlite3 (pre-deploy-backup.sh allows for this too): back up through
  # better-sqlite3 in the running app, into the bind-mounted data dir, then move
  cd "$(dirname "$0")/.."
  TMP_NAME=".daily-backup-${STAMP}.db"
  docker compose exec -T -w /app/apps/server app node -e '
    const Database = require("better-sqlite3");
    const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
    db.backup(process.argv[2]).then(() => { db.close(); }, (err) => { console.error(err); process.exit(1); });
  ' "/app/apps/server/data/records.db" "/app/apps/server/data/${TMP_NAME}" </dev/null
  mv "${DB_DIR}/${TMP_NAME}" "${DEST}"
fi
[[ -s "${DEST}" ]] || { echo "backup failed: empty snapshot" >&2; exit 1; }
gzip -f "${DEST}"
echo "backed up → ${DEST}.gz"

# prune old backups
find "${OUT_DIR}" -name 'records-*.db.gz' -mtime "+${KEEP_DAYS}" -delete
