# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CraftYap — a Roblox-style blocky 3D web game collection (English UI, crayon-doodle brand), one page with two modes chosen at startup:

- **오늘의 타워 (tower)**: multiplayer obby. A new deterministic tower every day (KST midnight), client-authoritative movement with server sanity validation, persisted daily leaderboard.
- **로보 빌더 (builder)**: idle game. Blocky workers construct real-scale voxel world landmarks (Eiffel 330 m, pyramid 230 m base…); no physics, no server dependency, localStorage save with offline settlement.

## Commands

```bash
pnpm install                 # pnpm 10 workspace; esbuild/better-sqlite3 builds are pre-approved in root package.json
pnpm dev                     # server :8081 (tsx watch) + client :5173 (vite, /ws proxy) via concurrently
pnpm typecheck && pnpm lint && pnpm test   # static gates + all unit tests
pnpm build                   # vite build (client) + tsup (server)
SERVE_STATIC=1 node apps/server/dist/index.js   # single-port production (static + WS on :8081)
```

Run a single test file from inside its package (vitest is per-package, not hoisted to root):

```bash
cd apps/client && npx vitest run test/builder-core.test.ts
```

E2E suites (need `pnpm dev` running; drive headless **Edge** via puppeteer-core at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` with `--enable-unsafe-swiftshader`):

```bash
node tools/e2e-mechanics.mjs      # tower: platform riding/crumble/checkpoints/goal (runs offline — see below)
node tools/e2e-multiplayer.mjs    # tower: two tabs, shared platform timeline, persisted daily board
node tools/e2e-robustness.mjs     # tower: cheat snapback/kick, server-restart reconnect, record persistence
node tools/e2e-builder.mjs        # builder: economy, goals, offline settlement exact-match
node tools/e2e-production.mjs     # built dist on a single port (no dev server needed)
node tools/builder-gallery.mjs <outdir> [i]   # screenshot each landmark for visual review
node tools/builder-shots.mjs <outdir> [i]     # screenshot each camera shot type
```

## Architecture

pnpm monorepo. `packages/shared` is consumed **as TypeScript source** (`"exports": "./src/index.ts"`) — no build step; Vite/tsx/vitest resolve it directly, and the production server bundles it via tsup `noExternal`. All packages are `noEmit` with `moduleResolution: bundler`. shared and server exclude the DOM lib so browser APIs there fail typecheck.

- `packages/shared` — zod wire protocol (single discriminated union on `t`, `PROTOCOL_VERSION` gate), deterministic level generator (`generateLevel(seed)` — identical output on client and server), daily-tower math (`daily.ts`: seed = f(date in KST), day boundaries), gameplay constants ported from the legacy prototype at 40 px/m (`constants.ts` — these define game feel, don't tweak casually).
- `apps/client/src/main.ts` — mode selector first; each mode lazy-loads. Rapier WASM (~2 MB) loads only for tower mode. `?mode=tower|builder` deep-links skip the selector (all E2E relies on this).
- `apps/server` — `ws` + pino. `Room` per ≤8 players on today's seed; `game/validation.ts` is the pure anti-cheat (unit-tested); `game/records.ts` persists daily bests in SQLite (better-sqlite3, falls back to in-memory if the native module is broken).

### Tower mode invariants (the anti-jitter contract)

Per-tick order in `app/game.ts` is load-bearing: input sample → moving platforms teleport (`setTranslation`, **not** `setNextKinematicTranslation`) → player KCC with explicit platform-delta carry → exactly one `world.step()` → triggers/NaN watchdog → interpolation commit. Everything rendered lerps from the same prev/curr pair (`physics/interpolation.ts`).

- **Do not switch moving platforms back to `setNextKinematicTranslation`**: it gives the body internal velocity that Rapier's KinematicCharacterController partially and unreliably applies to riders, double-carrying against our explicit delta (verified by tick traces; riders get flung).
- Moving-platform positions are analytic functions of the **shared server-time timeline** (`timelineSeconds`, slew-limited monotonic in `app/timeline.ts`) — never integrated incrementally, so all clients agree (~1 ms measured) and the server could recompute them.
- Sensors (checkpoints/hazards/goal) are analytic checks in `world/triggers.ts`, not physics events.
- Networking: client reports at 20 Hz; server validates displacement between **accepted** states against wall clock (lag bursts don't false-positive), respawn teleports are only accepted near the **anchor** (spawn/reached checkpoint — this is what blocks respawn-spam flight). Progress messages (`c-checkpoint`/`c-finish`) queue in `net/client.ts` and flush **after** the next `c-move` so the server always validates them against a position at the pad.
- Client `c-finish` carries a tick-precise time; server adopts it only within a tolerance window of its own wall-clock measurement.

### Builder mode (`apps/client/src/builder/`)

Pure logic (`state/sim/goals/save`) is DOM-free and unit-tested; the render layer reuses the tower's renderer/rig/sfx/effects. Key ideas:

- Landmarks are procedurally generated voxel blueprints at real-world scale with per-landmark voxel size (`landmarks.ts`); a bake pass adds AO/noise/weathering, `sealMicroGaps` fills pinholes. Blueprints are sorted bottom-up = build order. Keep each under ~80k blocks (test-enforced; ghost cap in `landmarkView.ts`).
- Economy is in **deliveries** (one worker trip = `deliverySize` voxels ≈ total/250), so pacing is constant regardless of detail. `settleOffline` must stay exactly consistent with live `tick` — there are unit tests and an E2E that assert equality to the gold.
- `landmarkView` batches instances by surface finish (masonry/metal/glass/emissive) and reveals them by count only; the "pour" runs at the economy's voxel rate (big catch-ups recap evenly over ~8 s).
- `cameraDirector.ts` guarantees the whole monument is always in frame (bounding-sphere fit distance recomputed per frame); shots are a shuffled deck, pinnable via `__roboBuilder.pinShot()` for screenshots.
- On landmark completion the **view** parades (finish pour + dwell on a pinned shot) while the sim already builds the next blueprint; HUD must describe the *view* landmark during the parade (`hud.update(state, view)`).

### E2E harness conventions

Dev builds expose debug hooks: `window.__robo` (tower: snapshot/teleport/startRun/debugSend/offline/…) and `window.__roboBuilder` (builder: snapshot/jumpTo/addGold/pinShot/landmarks/…). Two rules learned the hard way:

- Raw test teleports are **correctly rejected** by the server anti-cheat. Physics-only suites call `__robo.offline()` first; online movement must be kinematically plausible (`glideTo` micro-steps in e2e-multiplayer).
- Background tabs pause rAF (render + fixed loop), so cross-tab comparisons must read data updated by WS handlers, not mesh positions; bring a tab to front before reading its rendered state.

## Known limitations (see README for the user-facing list)

Mid-run reconnect resets server-side checkpoint progress; nickname = identity (no accounts); all rooms share the daily seed by design; sustained within-envelope speed passes validation (records still bounded by min-finish-time + checkpoint order).
