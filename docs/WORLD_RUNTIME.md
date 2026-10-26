# Player, chunk and classroom runtime audit (2026-10-26)

## Fixed failures

- Mode teardown left BGM/SFX unlock listeners and the game loop's visibility
  listener alive, retaining game objects. Craft teardown now aborts owned input
  and visibility listeners, stops audio, cancels pending graphics preparation,
  terminates the water worker, clears chunk queues, removes HUD/debug hooks and
  releases its WebGL context. Repeated disposal is safe; a disposed mode cannot
  restart. Shared character geometry and texture caches retain their ownership.
- Field scrolling preserved boundary geometry built against the old outside
  column. Retained chunks next to unloaded/restored neighbours now rebuild,
  including stable water whose simulation has no pending changes. Field edits
  use compact coordinate keys; filling a window advances the world version.
- A restored classroom retained the old local player ID, so snapshots could
  create a second copy of the player's robot. Resync replaces identity and the
  HUD's self marker, frees old avatars/labels and applies the authoritative world.
  World reset/resync also moves players and pets out of newly solid terrain.
- Initial loading dropped edits arriving between world batches or during module
  setup. The client now replays reliable messages in order after the full initial
  world and handlers are ready. Snapshot movement is disposable while loading.
- Repeated rejected edits could roll back to an obsolete local value. Build
  refusals and rate-limited edits now include the server's current cell values.
- Closed socket callbacks retained an entire classroom. Close now clears their
  room reference, releases stream generators/queues, and clears member peers.

## Transfer and lifecycle invariants

Classroom protocol is **5**. Older classroom tabs must refresh. SavedClass JSON
and persisted block IDs are unchanged; a saved-class round trip was verified
with the previous production server (`07d6872`), preserving water IDs 19–28,
furniture, settings, class/student names and credential keys in both directions.

Large initial transfers share a soft eight-millisecond scheduler budget per
16-millisecond timer, with at most two milliseconds per visited transport. A
socket pauses world serialization at 256 KiB of native WebSocket backlog and
keeps at most 1 MiB of queued reliable application messages. Slow movement
snapshots are skipped; terminal class events discard queued world data. Excess
reliable backlog closes the transport so the client can resync.

Joining peers share a frozen prefix of the room's key log instead of making a
copy of every cell. Values are read as batches are sent; live updates replay
after initial load. Removed cells use pristine values, and historical keys are
compacted. The active save cap stays 300,000 cells; the wire prefix may include
up to 600,000 rows with tombstones/repeated keys. Saved files contain only active
edits, never the key log.

Client loading expires after ten seconds without progress or 120 seconds total.
Early reliable messages are bounded at 1,024 messages/65,536 edit rows. Retired
socket messages are ignored; explicit leave clears handlers and all timers.
Returning teachers retry a temporarily occupied old transport; returning
students retry briefly while their teacher restores the saved room. New join
errors remain immediate. Client outgoing backlog is also bounded at 256 KiB.

## Repeatable verification

Use isolated browser profiles and temporary classrooms, never production bulk
traffic. Start `pnpm dev`, and build the server before the restart probe:

```powershell
node tools/stress-world.mjs tmp/world-load-final
pnpm --filter @robo/server exec node --expose-gc --max-old-space-size=256 --import tsx ../../tools/stress-classroom.mjs
node tools/e2e-classroom-recovery.mjs
```

Observed on the Windows/Edge test machine:

- Six field round trips keep 100 chunks, 52 geometries, 31 textures and 26
  programs after settling. Post-GC heap growth after warmup is 0.29 MiB.
- Six mode create/prepare/start/dispose cycles leave zero chunks, HUD elements
  and canvases, with lost WebGL contexts and unchanged global listener counts.
  Post-GC heap growth after warmup is 0.60 MiB. Disposal during preparation
  settles promptly. No browser exceptions occurred.
- One teacher plus 40 simultaneous students each receive a 300,000-cell field
  through simulated buffered transports, including a concurrent edit. Peak
  process RSS is 339.5 MiB; post-shutdown heap falls from 15.3 to 9.9 MiB even
  when the closed fake sockets remain referenced. Completion takes 38.7 seconds
  in this simulation; this is not a real network/production latency benchmark.
- Two real browsers recover after an isolated server restart with fresh IDs and
  the saved block intact. Four more student reconnects preserve one self row,
  exclude the self avatar and keep label GPU resources stable (5/5 checks).
- 406 unit tests, classroom 45/45, field 11/11, furniture 58/58, water 16/16 and
  production 9/9 checks pass; type checking, ESLint and build pass. The water
  unit-test settling helper now advances deterministic simulation steps rather
  than treating a zero-change time slice as completed work.

These measurements cover the stated scenarios. Exposed geometry, simultaneous
rooms and user hardware still determine resource cost. Saving a whole large
classroom remains synchronous JSON/SQLite work; the transport change does not
turn persistence into a background task. RSS can remain reserved by the memory
allocator after objects are collected. Deployment keeps the live DB backup and
idle-connection guard documented in `DEPLOY_KO.md`.
