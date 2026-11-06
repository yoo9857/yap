#!/usr/bin/env bash
# CraftYap deploy (by hand) — build, then the zero-downtime hand-over the workflow uses.
# Run from the app dir on the server (default /srv/craftyap/app).
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/craftyap/app}"

cd "${APP_DIR}"

test -s .env || { echo "missing .env (copy from .env.example)" >&2; exit 1; }

# ensure the separate DB dir exists (bind-mount target)
DB_DIR="$(grep -E '^DB_DIR=' .env | cut -d= -f2- || true)"
DB_DIR="${DB_DIR:-/srv/craftyap/data}"
mkdir -p "${DB_DIR}"

docker compose config >/dev/null
# build while the live container serves, then hand over without downtime (backup included)
docker compose build
exec bash scripts/zero-downtime-deploy.sh
