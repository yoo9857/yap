#!/usr/bin/env bash
# Refuse a container restart while a lesson/game still has a live connection.
# Run AFTER building the replacement image so the idle check is near cutover.
set -euo pipefail

if [ -z "$(docker compose ps --status running -q app)" ]; then
  echo "No running app; initial deployment may proceed."
  exit 0
fi

for attempt in $(seq 1 24); do
  active="$(docker compose exec -T app node --input-type=commonjs <<'NODE'
const {readFileSync, existsSync} = require('node:fs');
const port = Number(process.env.PORT || 8081).toString(16).padStart(4, '0').toUpperCase();
let active = 0;
for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] === '01' && fields[1]?.split(':').at(-1) === port) active++;
  }
}
process.stdout.write(String(active));
NODE
)"
  if [ "$active" = "0" ]; then
    echo "App is idle; deployment may proceed."
    exit 0
  fi
  echo "Waiting for $active live app connection(s) to finish ($attempt/24)."
  sleep 5
done

echo "App is still in use. Keeping the existing container running; retry deployment when idle." >&2
exit 1
