#!/usr/bin/env bash
# Control-flow test for scripts/zero-downtime-deploy.sh without a server: docker, nginx, systemctl,
# curl, ss and git are stand-ins that keep their state in files, so every path — first deploy,
# flipping back, nginx rejecting the config, nginx not picking the change up, a new container that
# never gets healthy, an old container that will not stop — runs exactly as the script would on
# the host. Run: bash tools/test-zero-downtime-deploy.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }

setup() {
  rm -rf "${WORK:?}"/*
  mkdir -p "${WORK}/app/scripts" "${WORK}/app/ops/nginx" "${WORK}/bin" "${WORK}/mock" "${WORK}/data" "${WORK}/nginx/enabled" "${WORK}/nginx/available"
  cp "${REPO}/scripts/zero-downtime-deploy.sh" "${WORK}/app/scripts/"
  echo 'exit 0' > "${WORK}/app/scripts/pre-deploy-backup.sh"
  echo 'exit 0' > "${WORK}/app/scripts/ensure-site-db.sh"   # the site's database and network (its own stand-in)
  printf 'DB_DIR=%s\n' "${WORK}/data" > "${WORK}/app/.env"
  echo "include upstream; proxy_pass http://craftyap_app;" > "${WORK}/app/ops/nginx/craftyap.com.conf"
  echo "old vhost (proxy_pass 127.0.0.1:8082)" > "${WORK}/nginx/available/craftyap.com.conf"
  ln -s "${WORK}/nginx/available/craftyap.com.conf" "${WORK}/nginx/enabled/craftyap.com.conf" 2>/dev/null \
    || cp "${WORK}/nginx/available/craftyap.com.conf" "${WORK}/nginx/enabled/craftyap.com.conf"
  # the live site before the first zero-downtime deploy: project craftyap on 8082, nginx → 8082
  echo "8082" > "${WORK}/mock/run-craftyap"
  echo "8082" > "${WORK}/mock/nginx-live"
  M="${WORK}/mock"
  cat > "${WORK}/bin/docker" <<EOF
#!/usr/bin/env bash
M="${M}"
if [[ "\$1" == inspect ]]; then echo "host-\${@: -1}"; exit 0; fi
shift # compose
proj=""; if [[ "\$1" == -p ]]; then proj="\$2"; shift 2; fi
cmd="\$1"; shift
case "\$cmd" in
  config) exit 0 ;;
  up) [[ -f "\$M/never-healthy-\$proj" ]] && { echo "\$HOST_PORT" > "\$M/run-\$proj"; touch "\$M/sick-\$proj"; exit 0; }
      echo "\$HOST_PORT" > "\$M/run-\$proj"; exit 0 ;;
  down) rm -f "\$M/run-\$proj" "\$M/sick-\$proj"; exit 0 ;;
  ps) [[ -f "\$M/run-\$proj" ]] && echo "\$proj"; exit 0 ;;
  stop) [[ -f "\$M/stuck-\$proj" ]] && exit 1; rm -f "\$M/run-\$proj"; exit 0 ;;
  kill) [[ -f "\$M/stuck-\$proj" ]] && exit 1; rm -f "\$M/run-\$proj"; exit 0 ;;
  rm) exit 0 ;;
  logs) echo "(logs of \$proj)"; exit 0 ;;
esac
exit 0
EOF
  cat > "${WORK}/bin/curl" <<EOF
#!/usr/bin/env bash
M="${M}"
url="\${@: -1}"
# which port answers: a direct 127.0.0.1:PORT, or whatever nginx last loaded for https
if [[ "\$url" == https://* ]]; then port="\$(cat "\$M/nginx-live")"; else port="\$(echo "\$url" | sed -E 's#.*:([0-9]+)/.*#\1#')"; fi
for f in "\$M"/run-*; do
  [[ -f "\$f" ]] || continue
  proj="\${f##*/run-}"
  if [[ "\$(cat "\$f")" == "\$port" ]]; then
    [[ -f "\$M/sick-\$proj" ]] && exit 22
    # the pre-change server sends no x-instance; a new one names itself
    if [[ " \$* " == *" -D - "* && "\$proj" != craftyap-old ]]; then printf 'HTTP/1.1 200 OK\r\nx-instance: host-%s\r\n\r\n' "\$proj"; fi
    exit 0
  fi
done
exit 7
EOF
  cat > "${WORK}/bin/nginx" <<EOF
#!/usr/bin/env bash
[[ -f "${M}/nginx-bad" ]] && { echo "nginx: [emerg] bad" >&2; exit 1; }
exit 0
EOF
  cat > "${WORK}/bin/systemctl" <<EOF
#!/usr/bin/env bash
# reload: nginx now proxies to what the upstream file names — unless the vhost is not the one loaded
[[ -f "${M}/reload-noop" ]] && exit 0
sed -nE 's/.*127\.0\.0\.1:([0-9]+).*/\1/p' "${WORK}/upstream.conf" > "${M}/nginx-live" 2>/dev/null
[[ -s "${M}/nginx-live" ]] || echo 8082 > "${M}/nginx-live"
exit 0
EOF
  printf '#!/usr/bin/env bash\nexit 0\n' > "${WORK}/bin/ss"
  printf '#!/usr/bin/env bash\necho abc1234\n' > "${WORK}/bin/git"
  printf '#!/usr/bin/env bash\nexit 0\n' > "${WORK}/bin/sleep"
  chmod +x "${WORK}"/bin/* "${WORK}/app/scripts/"*.sh
}

run() {
  PATH="${WORK}/bin:${PATH}" ACTIVE_FILE="${WORK}/active-project" UPSTREAM_FILE="${WORK}/upstream.conf" \
    NGINX_ENABLED="${WORK}/nginx/enabled/craftyap.com.conf" NGINX_VHOST="${WORK}/nginx/available/craftyap.com.conf" \
    bash "${WORK}/app/scripts/zero-downtime-deploy.sh" </dev/null >"${WORK}/out.log" 2>&1
}
live() { cat "${WORK}/mock/nginx-live"; }
running() { [[ -f "${WORK}/mock/run-$1" ]]; }

# A. the first deploy from today's state: blue (craftyap :8082) → green (craftyap-green :8083)
setup
if run && [[ "$(live)" == 8083 ]] && running craftyap-green && ! running craftyap \
  && [[ "$(cat "${WORK}/active-project")" == "craftyap-green 8083" ]] && [[ ! -e "${WORK}/data/handoff.lock" ]]; then
  pass "first deploy: green serves through nginx, blue stopped, state recorded, lock lifted"
else fail "first deploy"; cat "${WORK}/out.log"; fi

# B. the next deploy flips back to blue
if run && [[ "$(live)" == 8082 ]] && running craftyap && ! running craftyap-green \
  && [[ "$(cat "${WORK}/active-project")" == "craftyap 8082" ]]; then
  pass "second deploy flips back: blue serves, green stopped"
else fail "second deploy"; cat "${WORK}/out.log"; fi

# C. nginx rejects the config: nothing changes for players
setup; touch "${WORK}/mock/nginx-bad"
if ! run && [[ "$(live)" == 8082 ]] && running craftyap && ! running craftyap-green \
  && [[ ! -e "${WORK}/upstream.conf" ]] && grep -q "old vhost" "${WORK}/nginx/available/craftyap.com.conf" \
  && [[ ! -e "${WORK}/active-project" ]] && [[ ! -e "${WORK}/data/handoff.lock" ]]; then
  pass "nginx -t fails: vhost/upstream restored, new removed, old serving, no lock left"
else fail "nginx -t failure"; cat "${WORK}/out.log"; fi

# D. nginx reloads but does not pick the change up (e.g. a stale copy is the enabled file)
setup; touch "${WORK}/mock/reload-noop"
if ! run && [[ "$(live)" == 8082 ]] && running craftyap && ! running craftyap-green \
  && grep -q "old vhost" "${WORK}/nginx/available/craftyap.com.conf"; then
  pass "nginx still on the old container: caught before the old one stops, everything put back"
else fail "reload no-op"; cat "${WORK}/out.log"; fi

# E. the new container never becomes healthy
setup; touch "${WORK}/mock/never-healthy-craftyap-green"
if ! run && [[ "$(live)" == 8082 ]] && running craftyap && ! running craftyap-green && [[ ! -e "${WORK}/upstream.conf" ]]; then
  pass "new container unhealthy: removed, nginx untouched, old serving"
else fail "unhealthy new container"; cat "${WORK}/out.log"; fi

# F. the old container will not stop: the deploy fails loudly (never two servers silently)
setup; touch "${WORK}/mock/stuck-craftyap"
if ! run && grep -q "still running" "${WORK}/out.log" && [[ ! -e "${WORK}/data/handoff.lock" ]]; then
  pass "old container stuck: reported as a failure, lock lifted"
else fail "stuck old container"; cat "${WORK}/out.log"; fi

# G. a regular-file enabled vhost (not a link) is the file that gets written
setup; rm -f "${WORK}/nginx/enabled/craftyap.com.conf"; echo "old vhost copy" > "${WORK}/nginx/enabled/craftyap.com.conf"
if run && grep -q "craftyap_app" "${WORK}/nginx/enabled/craftyap.com.conf"; then
  pass "a plain-copy enabled vhost is updated in place"
else fail "plain-copy enabled vhost"; cat "${WORK}/out.log"; fi

# H. the site database's network cannot be made: the deploy stops before anything is started
setup; echo 'echo "no network" >&2; exit 1' > "${WORK}/app/scripts/ensure-site-db.sh"
if ! run && [[ "$(live)" == 8082 ]] && running craftyap && ! running craftyap-green && [[ ! -e "${WORK}/upstream.conf" ]] \
  && [[ ! -e "${WORK}/active-project" ]] && [[ ! -e "${WORK}/data/handoff.lock" ]]; then
  pass "site database preflight fails: nothing started, nginx untouched, old serving"
else fail "site database preflight failure"; cat "${WORK}/out.log"; fi

# ---------------------------------------------------------------- scripts/ensure-site-db.sh
# The site's database before the app starts, against a stand-in docker: the first run makes the
# secrets and starts it, a second run changes nothing, a database that never gets healthy is a
# warning (exit 0), a network that cannot be made is the only failure.
db_setup() {
  rm -rf "${WORK:?}"/*
  mkdir -p "${WORK}/app/scripts" "${WORK}/bin" "${WORK}/mock"
  cp "${REPO}/scripts/ensure-site-db.sh" "${WORK}/app/scripts/"
  printf 'DB_DIR=/srv/data
LOG_LEVEL=info' > "${WORK}/app/.env"   # no newline at its end, as hand-edited files often are
  M="${WORK}/mock"
  cat > "${WORK}/bin/docker" <<EOF
#!/usr/bin/env bash
M="${M}"
echo "\$*" >> "\$M/calls"
case "\$1 \$2" in
  "network inspect") [[ -f "\$M/net" ]] ;;
  "network create") [[ -f "\$M/net-fails" ]] && exit 1; touch "\$M/net" ;;
  "compose -f") touch "\$M/db-started" ;;
  "inspect -f") [[ -f "\$M/db-started" && ! -f "\$M/db-sick" ]] && echo healthy || echo starting ;;
  *) exit 0 ;;
esac
EOF
  printf '#!/usr/bin/env bash
exit 0
' > "${WORK}/bin/sleep"
  chmod +x "${WORK}"/bin/* "${WORK}/app/scripts/"*.sh
}
db_run() { PATH="${WORK}/bin:${PATH}" bash "${WORK}/app/scripts/ensure-site-db.sh" </dev/null >"${WORK}/out.log" 2>&1; }

db_setup
if db_run && [[ -f "${WORK}/mock/net" && -f "${WORK}/mock/db-started" ]]   && grep -qE '^POSTGRES_PASSWORD=[0-9a-f]{48}$' "${WORK}/app/.env.db"   && grep -qE '^DATABASE_URL=postgres://craftyap:[0-9a-f]{48}@craftyap-db:5432/craftyap$' "${WORK}/app/.env"   && grep -qE '^AUTH_PEPPER=[0-9a-f]{64}$' "${WORK}/app/.env" && grep -qx 'LOG_LEVEL=info' "${WORK}/app/.env"   && [[ "$(grep -E '^POSTGRES_PASSWORD=' "${WORK}/app/.env.db" | cut -d= -f2)" == "$(sed -nE 's#^DATABASE_URL=postgres://craftyap:([0-9a-f]+)@.*#\1#p' "${WORK}/app/.env")" ]]; then
  pass "site database, first run: network, password, DATABASE_URL and AUTH_PEPPER made, the old .env lines kept, database started"
else fail "site database first run"; cat "${WORK}/out.log" "${WORK}/app/.env"; fi

before="$(cat "${WORK}/app/.env" "${WORK}/app/.env.db")"
if db_run && [[ "$(cat "${WORK}/app/.env" "${WORK}/app/.env.db")" == "${before}" ]] && ! grep -q "network create" <(tail -n 4 "${WORK}/mock/calls"); then
  pass "site database, second run: no secret is changed, the network is not made twice"
else fail "site database second run"; cat "${WORK}/out.log"; fi

db_setup; touch "${WORK}/mock/db-sick"
if db_run && grep -q "WARNING" "${WORK}/out.log" && grep -qE '^DATABASE_URL=' "${WORK}/app/.env"; then
  pass "site database never healthy: a warning, not a failed deploy — and DATABASE_URL is set, so the app answers 503 rather than keeping accounts in memory"
else fail "site database unhealthy"; cat "${WORK}/out.log"; fi

db_setup; touch "${WORK}/mock/net-fails"
if ! db_run && [[ ! -f "${WORK}/mock/db-started" ]]; then
  pass "site database network cannot be made: the script fails (the deploy stops before starting anything)"
else fail "site database network failure"; cat "${WORK}/out.log"; fi

echo "---"
if [[ ${fails} -eq 0 ]]; then echo "all passed"; else echo "${fails} FAILED"; exit 1; fi
