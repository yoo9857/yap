#!/usr/bin/env bash
# Snapshot the live SQLite DB (daily leaderboard + saved classrooms) right
# before a deploy restarts the server — the rollback point if a release ever
# mishandles saved data. Called by .github/workflows/deploy.yml after the pull
# and BEFORE `docker compose up`; a failed backup aborts the deploy.
#
# Hot and consistent (SQLite's own online backup, WAL included):
#   - with the sqlite3 CLI on the host if it is installed,
#   - otherwise from inside the still-running container, which always has
#     better-sqlite3 (its .backup() is the same online-backup API).
# Keeps the newest KEEP snapshots in ${DB_DIR}/pre-deploy/.
set -euo pipefail

cd "$(dirname "$0")/.."

DB_DIR="$(grep -E '^DB_DIR=' .env 2>/dev/null | cut -d= -f2- || true)"
DB_DIR="${DB_DIR:-/srv/craftyap/data}"
DB="${DB_DIR}/records.db"
OUT_DIR="${DB_DIR}/pre-deploy"
KEEP="${KEEP:-10}"
REV="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
STAMP="$(date +%F_%H%M%S)"
NAME="records-${STAMP}-before-${REV}.db"

if [[ ! -f "${DB}" ]]; then
  echo "pre-deploy backup: no db at ${DB} yet — nothing to protect"
  exit 0
fi
mkdir -p "${OUT_DIR}"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "${DB}" ".backup '${OUT_DIR}/${NAME}'"
elif docker compose ps --status running --services 2>/dev/null | grep -qx app; then
  # paths as the container sees the bind mount (compose: DB_DIR → apps/server/data)
  docker compose exec -T -w /app/apps/server app node -e '
    const Database = require("better-sqlite3");
    const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
    db.backup(process.argv[2]).then(() => { db.close(); }, (err) => { console.error(err); process.exit(1); });
  ' "/app/apps/server/data/records.db" "/app/apps/server/data/pre-deploy/${NAME}"
else
  echo "pre-deploy backup: no sqlite3 on the host and the app container is not running — refusing to deploy unprotected" >&2
  exit 1
fi

# a snapshot that is empty or fails SQLite's own check is not a rollback point
SNAP="${OUT_DIR}/${NAME}"
[[ -s "${SNAP}" ]] || { echo "pre-deploy backup: empty snapshot" >&2; exit 1; }
gzip -f "${SNAP}"
echo "pre-deploy backup → ${SNAP}.gz ($(du -h "${SNAP}.gz" | cut -f1))"

# keep only the newest ${KEEP}
ls -1t "${OUT_DIR}"/records-*.db.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
