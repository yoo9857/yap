#!/usr/bin/env bash
# Zero-downtime deploy: the new release starts BESIDE the running one, nginx switches over, and only
# then does the old container save every classroom and close. Nobody has to leave first.
#
#   0. preflight: the other port is free (a stale container of the other colour is removed), memory
#   1. start the new container on the other port (blue 8082 ↔ green 8083), wait for /healthz
#   2. snapshot the DB from the still-running old container (the rollback point)
#   3. hand over — a few seconds:
#      - the hand-over lock (data/handoff.lock, apps/server/src/net/handoff.ts) makes BOTH
#        containers refuse NEW game sockets with 1013 "busy" (clients retry by themselves; pages
#        and assets keep serving) — so no class can open on the new container before the old one
#        has saved it
#      - nginx's upstream is pointed at the new port, validated, reloaded (graceful), and a request
#        THROUGH nginx must come back from the new container (/healthz x-instance) — otherwise
#        nginx is put back as it was and the new container removed: the old one never stopped
#      - the old container gets SIGTERM: it saves every class and drops its sockets (never
#        "class over"); those clients reconnect — to the new container
#      - the lock is lifted
#   4. remember which one is live (/srv/craftyap/active-project: "<compose project> <port>")
#
# Every failure before the old container is stopped leaves it serving exactly as before (the new
# container is removed, nginx restored). The lock ignores itself after 60 s, so even a deploy
# killed mid-hand-over cannot lock the games out.
#
# The image must already be built (`docker compose build` → craftyap-app:latest). Run from the app
# dir; takes </dev/null when it runs inside the workflow's `ssh 'bash -se'` heredoc.
set -euo pipefail

cd "$(dirname "$0")/.."

STATE="${ACTIVE_FILE:-/srv/craftyap/active-project}"
UPSTREAM="${UPSTREAM_FILE:-/etc/nginx/craftyap-upstream.conf}"
ENABLED="${NGINX_ENABLED:-/etc/nginx/sites-enabled/craftyap.com.conf}"
# write the vhost where nginx actually reads it: the sites-available file the enabled link points
# to, or the enabled file itself when it is a plain copy (a copy would never see sites-available)
if [[ -f "${ENABLED}" && ! -L "${ENABLED}" ]]; then
  VHOST="${ENABLED}"
else
  VHOST="${NGINX_VHOST:-/etc/nginx/sites-available/craftyap.com.conf}"
fi

test -s .env || { echo "missing .env (copy from .env.example)" >&2; exit 1; }
DB_DIR="$(grep -E '^DB_DIR=' .env | cut -d= -f2- || true)"
DB_DIR="${DB_DIR:-/srv/craftyap/data}"
mkdir -p "${DB_DIR}"
LOCK="${DB_DIR}/handoff.lock"

OLD_PROJECT="craftyap"
OLD_PORT="8082"
if [[ -s "${STATE}" ]]; then read -r OLD_PROJECT OLD_PORT < "${STATE}"; fi
if [[ "${OLD_PROJECT}" == "craftyap-green" ]]; then
  NEW_PROJECT="craftyap"; NEW_PORT="8082"
else
  NEW_PROJECT="craftyap-green"; NEW_PORT="8083"
fi
old() { HOST_PORT="${OLD_PORT}" docker compose -p "${OLD_PROJECT}" "$@"; }
new() { HOST_PORT="${NEW_PORT}" docker compose -p "${NEW_PROJECT}" "$@"; }
echo "live: ${OLD_PROJECT} :${OLD_PORT} → new: ${NEW_PROJECT} :${NEW_PORT}"

# ---------------------------------------------------------------- failure paths
SWITCHED=""   # nginx points at the new container (from here on, never undo by removing it)
abort_new() {
  # before the switch: the old container still serves everything; just remove the new one
  echo "deploy aborted — ${OLD_PROJECT} :${OLD_PORT} keeps serving" >&2
  new logs --tail=40 app >&2 2>/dev/null || true
  new down >/dev/null 2>&1 || true
}
restore_nginx() {
  if [[ -f "${UPSTREAM}.prev" ]]; then mv -f "${UPSTREAM}.prev" "${UPSTREAM}"; else rm -f "${UPSTREAM}"; fi
  if [[ -f "${VHOST}.prev" ]]; then mv -f "${VHOST}.prev" "${VHOST}"; fi
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || echo "WARNING: nginx could not be restored — check it by hand" >&2
}
on_exit() {
  local code=$?
  rm -f "${LOCK}"
  if [[ ${code} -ne 0 && -z "${SWITCHED}" ]]; then abort_new; fi
}
trap on_exit EXIT

# ---------------------------------------------------------------- 0. preflight
new down >/dev/null 2>&1 || true   # a leftover of the other colour from an earlier failed run
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE "[:.]${NEW_PORT}[[:space:]]"; then
  echo "port ${NEW_PORT} is taken by something else" >&2
  exit 1
fi
avail_mb="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
echo "memory available: ${avail_mb} MB"
if [[ "${avail_mb}" -gt 0 && "${avail_mb}" -lt 250 ]]; then
  echo "under 250 MB free: not starting a second container now" >&2
  exit 1
fi

# ---------------------------------------------------------------- 1. the new container beside it
new config >/dev/null
new up -d --no-build --force-recreate
healthy=""
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${NEW_PORT}/healthz"; then healthy=1; break; fi
  sleep 2
done
[[ -n "${healthy}" ]] || { echo "new container never became healthy" >&2; exit 1; }
NEW_ID="$(docker inspect -f '{{.Config.Hostname}}' "$(new ps -q app)")"
echo "new container healthy on :${NEW_PORT} (${NEW_ID})"

# ---------------------------------------------------------------- 2. rollback point
if old ps --status running -q app 2>/dev/null | grep -q .; then
  COMPOSE_PROJECT_NAME="${OLD_PROJECT}" HOST_PORT="${OLD_PORT}" bash scripts/pre-deploy-backup.sh </dev/null
else
  COMPOSE_PROJECT_NAME="${NEW_PROJECT}" HOST_PORT="${NEW_PORT}" bash scripts/pre-deploy-backup.sh </dev/null
fi

# ---------------------------------------------------------------- 3. hand-over
touch "${LOCK}"
if [[ -f "${UPSTREAM}" ]]; then cp -f "${UPSTREAM}" "${UPSTREAM}.prev"; else rm -f "${UPSTREAM}.prev"; fi
if [[ -f "${VHOST}" ]]; then cp -f "${VHOST}" "${VHOST}.prev"; else rm -f "${VHOST}.prev"; fi
printf 'upstream craftyap_app {\n    server 127.0.0.1:%s;\n}\n' "${NEW_PORT}" > "${UPSTREAM}"
cp ops/nginx/craftyap.com.conf "${VHOST}"
if ! nginx -t || ! systemctl reload nginx; then
  echo "nginx rejected the new config — putting it back" >&2
  restore_nginx
  exit 1
fi
# prove a request through nginx reaches the NEW container before the old one goes
through=""
for _ in $(seq 1 10); do
  got="$(curl -fsS -D - -o /dev/null --resolve "craftyap.com:443:127.0.0.1" "https://craftyap.com/healthz" 2>/dev/null \
    | awk 'tolower($1) == "x-instance:" {gsub("\r", "", $2); print $2}' || true)"
  if [[ "${got}" == "${NEW_ID}" ]]; then through=1; break; fi
  sleep 1
done
if [[ -z "${through}" ]]; then
  echo "nginx does not reach the new container (got '${got:-nothing}', want ${NEW_ID}) — putting it back" >&2
  restore_nginx
  exit 1
fi
SWITCHED=1
echo "nginx now serves :${NEW_PORT}"

# the old one saves every class and closes its sockets; its clients reconnect to the new one
if [[ "${OLD_PROJECT}" != "${NEW_PROJECT}" ]]; then
  old stop -t 20 app || old kill app || true
  if old ps --status running -q app 2>/dev/null | grep -q .; then
    echo "the old container is still running: two servers would share the classes" >&2
    exit 1
  fi
  old rm -f app >/dev/null 2>&1 || true
fi
echo "${NEW_PROJECT} ${NEW_PORT}" > "${STATE}"
rm -f "${LOCK}" "${UPSTREAM}.prev" "${VHOST}.prev"
echo "deploy complete: $(git rev-parse --short HEAD) on ${NEW_PROJECT} :${NEW_PORT}"
