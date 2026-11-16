#!/usr/bin/env bash
# A dump of the site's PostgreSQL (teachers' accounts, inquiries — docs/ACCOUNTS.md).
#
#   bash scripts/backup-site-db.sh <out-dir> <name> [keep]
#     → <out-dir>/<name>.sql.gz, the newest <keep> (default 10) site-*.sql.gz kept
#
# Called by scripts/pre-deploy-backup.sh (the rollback point before every deploy) and by
# scripts/backup-db.sh (daily). pg_dump runs INSIDE the database's container (the database has no
# published port), reads a consistent snapshot while the site keeps running, and is checked: a
# dump that is cut short or empty is an error, not a backup.
#
# No database container (accounts not set up yet): nothing to back up, exit 0.
# The dumps hold personal data: they are written 0600, like the directory they share with the
# classroom snapshots — keep that directory off any public path.
set -euo pipefail

OUT_DIR="${1:?out dir}"
NAME="${2:?file name without extension}"
KEEP="${3:-10}"
DB_CONTAINER="craftyap-db"

if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "${DB_CONTAINER}"; then
  echo "site db backup: ${DB_CONTAINER} is not running — nothing to back up"
  exit 0
fi

umask 077
mkdir -p "${OUT_DIR}"
DEST="${OUT_DIR}/${NAME}.sql.gz"
# </dev/null: under the deploy's `ssh 'bash -se'` the script itself is on stdin, and exec would read it
docker exec "${DB_CONTAINER}" pg_dump -U craftyap --no-owner --no-privileges craftyap </dev/null | gzip > "${DEST}"

gzip -t "${DEST}"
if ! gzip -dc "${DEST}" | tail -n 5 | grep -q "PostgreSQL database dump complete"; then
  echo "site db backup: the dump is incomplete" >&2
  rm -f "${DEST}"
  exit 1
fi
echo "site db backup → ${DEST} ($(du -h "${DEST}" | cut -f1))"

ls -1t "${OUT_DIR}"/site-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
