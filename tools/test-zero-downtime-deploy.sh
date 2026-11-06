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

echo "---"
if [[ ${fails} -eq 0 ]]; then echo "all passed"; else echo "${fails} FAILED"; exit 1; fi
