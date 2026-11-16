#!/usr/bin/env bash
# The site's PostgreSQL (teachers' accounts, inquiries — docs/ACCOUNTS.md) is there before the app
# starts. Called by scripts/zero-downtime-deploy.sh at preflight; safe to run any number of times.
#
#   1. the docker network both app colours and the database share (craftyap-data) exists
#      — the ONLY step that may fail the deploy: without it the app container cannot start at all
#   2. first time only: a database password is made (.env.db), and the app's .env gets
#      DATABASE_URL and AUTH_PEPPER (never changed afterwards: every password is keyed with it)
#   3. the database's own compose project (docker-compose.db.yml) is up and healthy
#
# Steps 2–3 failing is a WARNING, not a failed deploy: the games must ship whatever the database
# does. The app then finds DATABASE_URL unreachable and answers 503 on /api (never an empty
# in-memory store that would lose accounts at the next restart) — and the workflow's smoke test
# reports it.
#
# ADMIN_PASSWORD is NOT made here: the operator chooses it (add ADMIN_PASSWORD=… to .env, at least
# 10 characters, then deploy or restart). Until then /admin/ is closed.
set -euo pipefail

cd "$(dirname "$0")/.."
NET="craftyap-data"
DB_CONTAINER="craftyap-db"

if ! docker network inspect "${NET}" >/dev/null 2>&1; then
  docker network create "${NET}" >/dev/null
  echo "site database: network ${NET} created"
fi

rand_hex() { # bytes → hex, with or without openssl
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"; else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

db_up() {
  umask 077
  if [[ ! -s .env.db ]]; then
    printf 'POSTGRES_PASSWORD=%s\n' "$(rand_hex 24)" > .env.db
    echo "site database: password made (.env.db)"
  fi
  chmod 600 .env.db .env
  local pw
  pw="$(grep -E '^POSTGRES_PASSWORD=' .env.db | head -n1 | cut -d= -f2-)"
  [[ -n "${pw}" ]] || { echo "site database: .env.db has no POSTGRES_PASSWORD" >&2; return 1; }
  if ! grep -qE '^DATABASE_URL=' .env; then
    printf '\n# the site'"'"'s PostgreSQL (docs/ACCOUNTS.md); written once by scripts/ensure-site-db.sh\nDATABASE_URL=postgres://craftyap:%s@%s:5432/craftyap\n' "${pw}" "${DB_CONTAINER}" >> .env
    echo "site database: DATABASE_URL added to .env"
  fi
  if ! grep -qE '^AUTH_PEPPER=' .env; then
    printf '# keyed into every password before hashing — NEVER change or lose it (keep a copy off the server)\nAUTH_PEPPER=%s\n' "$(rand_hex 32)" >> .env
    echo "site database: AUTH_PEPPER added to .env"
  fi
  docker compose -f docker-compose.db.yml --env-file .env.db up -d </dev/null
  for _ in $(seq 1 30); do
    if [[ "$(docker inspect -f '{{.State.Health.Status}}' "${DB_CONTAINER}" 2>/dev/null || true)" == "healthy" ]]; then return 0; fi
    sleep 2
  done
  echo "site database: ${DB_CONTAINER} did not become healthy in 60 s" >&2
  docker logs --tail=20 "${DB_CONTAINER}" >&2 2>/dev/null || true
  return 1
}

if db_up; then
  echo "site database: up"
else
  echo "WARNING: the site database is not ready — accounts, inquiries and the admin will answer 503; the games deploy as usual" >&2
fi
