#!/usr/bin/env bash
# CraftYap deploy — build + (re)start the container, then health-check.
# Run from the app dir on the server (default /srv/craftyap/app).
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/craftyap/app}"
HOST_PORT="${HOST_PORT:-8082}"
HEALTH_URL="http://127.0.0.1:${HOST_PORT}/healthz"

cd "${APP_DIR}"

test -s .env || { echo "missing .env (copy from .env.example)" >&2; exit 1; }

# ensure the separate DB dir exists (bind-mount target)
DB_DIR="$(grep -E '^DB_DIR=' .env | cut -d= -f2- || true)"
DB_DIR="${DB_DIR:-/srv/craftyap/data}"
mkdir -p "${DB_DIR}"

docker compose config >/dev/null
docker compose up -d --build
docker compose ps

for attempt in $(seq 1 20); do
  if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "Health check passed (attempt ${attempt}). Deploy complete."
    exit 0
  fi
  sleep 3
done

echo "Health check failed after 60s: ${HEALTH_URL}" >&2
docker compose logs --tail=50 app >&2
exit 1
