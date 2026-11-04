# Server scaling: shards, the room directory, load tests

Status (2026-11-04): implemented; production still runs `SHARDS=1` until the
container's CPU limit is raised (see *Turning it on*).

## Why

One Node process is one core. Measured with `tools/load-server.mjs` (real
WebSockets, walking + building students, 10 Hz snapshots) on an 8-core laptop:

| users | process | event loop busy | snapshot gap p99 (ideal 100 ms) | brick → classmate p99 |
|---|---|---|---|---|
| 520 | 1 | 93 % | 194 ms | 245 ms |
| 1 040 | 1 | **100 %** | **702 ms** | **4.2 s** |
| 1 040 | 4 shards | 48–50 % each | 196 ms | 201 ms |
| 1 560 | 6 shards | 40–44 % each | 235 ms | 210 ms (p50 20 ms) |

A single process stops being playable at ~500 concurrent users on a fast core.
Production's container is capped at `cpus: "0.50"`, i.e. roughly half that.
(The p99 floor of ~200 ms in the sharded runs is the bot processes competing for
the same 8 cores, not the server: its loops are half idle.)

## Shape

```
            ┌──────────── primary (one) ─────────────┐
 client ──► │ HTTP/static · /healthz · /metrics       │
            │ connection limits (per address, total)  │
            │ party hub (room list, seats)            │
            │ directory: route → shard                │
            └───┬───────────┬───────────┬─────────────┘
     raw socket │ over IPC  │           │   + roster mirror, party-open
            ┌───▼───┐   ┌───▼───┐   ┌───▼───┐
            │shard 0│   │shard 1│   │shard N│  classes, party fields, tower rooms
            └───────┘   └───────┘   └───────┘  (each opens the same SQLite, WAL)
```

- **The primary relays no game traffic.** It reads the HTTP upgrade, picks the
  shard, and passes the TCP socket itself (`worker.send(msg, socket)`) with the
  upgrade request; the shard completes the WebSocket handshake. After that the
  socket talks to its shard only.
- **Routes** (`cluster/directory.ts` `routeOf`): every socket names its game in
  its URL — `?mode=class&room=<class>` (also `party:CODE` fields), `?party=CODE`
  for a party's tower room, nothing for the public tower, `?mode=party` for the
  hub (which stays on the primary). The client sockets were changed to send
  these (`classClient.ts`, `socket.ts`); a page from before that change reaches
  shard 0 without a room and is answered `bad-version`, which reloads it routed.

## The directory (`LiveDirectory` + `RouteLedger`)

- **Sticky, load-aware.** A live route keeps its shard. A new route goes to the
  shard with the least load (its last reported game sockets + hand-offs since).
  Hashing was tried first: it evens out the *number* of classes, not their
  size, and left one shard at 100 % while another idled at 22 %.
- **Release is a compare-and-delete.** The primary counts sockets it handed to
  a route (`handed`), the shard counts sockets it received (`seen`). A shard
  offers a route back when it has no socket and no game for it (every 5 s);
  the primary only deletes the mapping if `handed === seen`, then acks. A
  socket still in the IPC pipe therefore keeps the mapping — a class can never
  be open on two shards. Failed hand-offs are taken back (`cancelNow`).
- **Shard ownership guard**: `ClassManager.owns` / the hub's `ownsTower` refuse
  a game the ledger does not hold (`bad-version` → reload), so a misrouted
  socket cannot open a second copy.
- **The seam for more machines**: callers only use `place`/`release` (async).
  A multi-node version keeps the same protocol on a shared store (Redis:
  route → node with the hand-off counter as a CAS) and moves the hub and the
  connection limits there too.

## Known trade-offs

- A party start cannot fail in cluster mode (`PartyGames.prepare` is answered
  by the primary, which does not know a shard's party-field cap). The cap is
  per shard (300 each); past it, players get `no-class` on join instead of
  `too-many-rooms` on start.
- A tower link whose party room is gone is routed to the public tower (as a
  single process would have seated it), decided by the primary's hub.

## Lifecycle

- Nothing is placed until every shard has booted (≤5 s): placing earlier
  pinned every reconnecting class of a deploy to one fallback shard.
- A shard that cannot open the database exits and is restarted — it never
  runs on the in-memory fallback, which would hide saved classes. (`SHARDS=1`
  keeps the old fallback.) SQLite waits up to 10 s for another shard's write.
- Upgrades for a shard that is still booting wait up to 5 s (a deploy brings
  every client back in the same second). `/healthz` is 503 until all shards
  are ready.
- A shard that dies is restarted after 1 s; its routes are forgotten and its
  connection-limit slots freed. Its classes reload from the database on the
  next join (up to 15 s of unsaved edits are lost — same as a single-process
  crash).
- SIGTERM → the primary closes the hub and tells every shard to shut down;
  each saves its classes (`ClassManager.shutdown`, never "lesson over") and
  the primary exits once all are gone. A shard whose primary disappears exits.
- Party hub ↔ games: the primary pushes the full roster to every shard on
  any seat change (same tick, before a page can navigate); shards report
  players per party code once a second for the hub's "game still running".

## Turning it on

`SHARDS` (env): `1` (default — exactly the old single process), `N`, or `auto`
(cores − 1, max 8). It only helps with cores to run on: raise the compose
`cpus` limit first, e.g. `cpus: "3"` + `SHARDS=2`, and `mem_limit` by ~70 MiB
per process. Read the numbers from inside the container:
`docker compose exec -T app curl -s localhost:8081/metrics` (`/metrics` answers
loopback only — through nginx or docker's port map it is a 404, and
`tools/smoke-prod.mjs` checks that). `SHARDS=auto` also caps itself by the
container's memory limit (80 MiB primary + 150 MiB per shard).

## Measuring

```bash
node tools/load-server.mjs --classes 20 --students 25 --shards 1
node tools/load-server.mjs --classes 40 --students 25 --shards 4 --bot-procs 3 --out tmp/load/x.json
```

It boots its own server on :8090 with a throw-away database (never point it at
production), joins teachers then students, walks them at 10 Hz, places and
removes bricks, and reports the server's `/metrics` (CPU, event-loop
utilisation, timer lag, memory per process) next to what the students saw
(snapshot gaps, brick echo latency, bandwidth).
