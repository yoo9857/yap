# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CraftYap — a Roblox-style blocky 3D web game collection (English UI, crayon-doodle brand), one page with four modes chosen at startup. Live at **https://craftyap.com** (GitHub `yoo9857/yap`).

- **Daily Tower (tower)**: multiplayer obby. A new deterministic tower every day (KST midnight), client-authoritative movement with server sanity validation, persisted daily leaderboard.
- **Robo Builder (builder)**: idle game. Blocky workers construct real-scale voxel world landmarks (Eiffel 330 m, pyramid 230 m base…); no physics, no server dependency, localStorage save with offline settlement.
- **Craft Island (craft)**: single-player voxel sandbox (mine / craft / place). NO rapier — the voxel grid itself is the collider (`craft/voxelBody.ts` AABB sweeps, `voxelWorld.ts` DDA raycast). World regenerates from its seed; the save stores only the edit diff + inventory (zod-validated, hostile-safe). Desktop-only (pointer lock). Press **B** for the **machine lab** — a Besiege-style build-and-test-drive mode that *does* use rapier (see below).
- **Blast Royale (battle)**: arcade solo battle royale — you vs 7 bots (who also fight each other) on a random voxel island, hitscan blasters, 3-phase shrinking storm, last robot standing. Client-only (no server); reuses craft's world/physics/camera. Pure logic in `battle/{zone,combat,bots}.ts`; a 4 s weapons-free grace after the drop keeps spawns fair.

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
node tools/e2e-craft.mjs          # craft: island boot, mine/craft/place, physics, save round-trip
node tools/e2e-machines.mjs       # machine lab: build shortcuts, library/share, drive, cameras, flight, wings
node tools/e2e-battle.mjs         # battle: bots live/roam, storm shrink, win & lose paths
node tools/e2e-builder-vr.mjs     # builder VR: rig placement, comfort contract, teardown (needs no headset)
node tools/e2e-production.mjs     # built dist on a single port (no dev server needed)
node tools/builder-gallery.mjs <outdir> [i]   # screenshot each landmark for visual review
node tools/builder-shots.mjs <outdir> [i]     # screenshot each camera shot type
node tools/vr-shots.mjs <outdir> [i] [fraction]  # screenshot each VR viewpoint station
node tools/vr-tour.mjs <outdir> [i] [fraction]   # ...plus a self-contained HTML page of them (headset-free "what VR looks like")
```

## Architecture

pnpm monorepo. `packages/shared` is consumed **as TypeScript source** (`"exports": "./src/index.ts"`) — no build step; Vite/tsx/vitest resolve it directly, and the production server bundles it via tsup `noExternal`. All packages are `noEmit` with `moduleResolution: bundler`. shared and server exclude the DOM lib so browser APIs there fail typecheck.

- `packages/shared` — zod wire protocol (single discriminated union on `t`, `PROTOCOL_VERSION` gate), deterministic level generator (`generateLevel(seed)` — identical output on client and server), daily-tower math (`daily.ts`: seed = f(date in KST), day boundaries), gameplay constants ported from the legacy prototype at 40 px/m (`constants.ts` — these define game feel, don't tweak casually).
- `apps/client/src/main.ts` — mode selector first; each mode lazy-loads. Rapier WASM (~2 MB) loads only for tower mode (craft/battle use the rapier-free voxel physics). `?mode=tower|builder|craft|battle` deep-links skip the selector (all E2E relies on this); `&reset=1` wipes a mode's localStorage save.
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

#### Builder VR (`vrDirector.ts` + `vrView.ts`) — the comfort contract

Builder is the only mode with WebXR (PC VR target). An "Enter VR" button appears automatically when `navigator.xr` reports an immersive-vr device, and only *after* `warmupGpu` (a shader compile inside a live session is a felt frame drop). `?vr=1` force-mounts the button for debugging. There is no controller input by design — it's an idle game, so head-look is the whole interaction.

In a session the **headset owns `camera.position/quaternion`**, so the viewer is placed by moving `GameRenderer.attachXrRig()`'s Group instead. `GameLoop` takes a swappable `FrameScheduler` because only `renderer.setAnimationLoop` frames carry a current head pose. VR lowers the flat grade's `near = 1.5 m` (it would clip the plaque and the blinder) but must **leave `far` alone** — the sky dome has a 1900 m radius, so a nearer far plane slices its back half off and the sky ends in a hard edge.

Four rules in `vrDirector.ts` are load-bearing and unit-tested. The flat-screen `CameraDirector`'s dollies and spirals are exactly what makes people sick, so VR gets its own director:

- The viewpoint **never moves while visible**; every change is a cut.
- Every cut is hidden behind a full-black blinder sphere parented to the camera (a visible teleport still reads as a lurch).
- **Yaw only.** Pitch/roll on the rig tilts the horizon against gravity; the viewer looks up with their own neck.
- A station's pose is **frozen on entry** — following the climbing build frontier would be slow vertical drift.

Because pitch is forbidden, a station's *height* is the only lever for what lands at eye level, and three non-obvious consequences shape the four stations (`plaza`, `yard`, `frontier`, `overlook`):

- **Elevated stations must stand well back.** The deck underfoot occludes everything steeper than ~58° below the horizon, and the build runs bottom-up, so a viewpoint near the build edge has all its placed blocks hidden beneath the deck with only unbuilt ghost left above. `frontier` therefore sits at *half* the build height and far enough out to keep the base above −55°.
- **There is no "above the summit" station** for the same reason: above the frontier is unbuilt ghost for most of a run.
- **Clearance comes from the blueprint, not `radiusM`.** `radiusProfile()` buckets the blueprint into height bands, because these landmarks run from a 96 m-wide ring 48 m tall (Colosseum) to a 331 m tower ending in a single 1.1 m voxel (Eiffel) — using the base radius at altitude parks you 130 m from a needle.

Mid-air stations get a railed platform, or height vertigo makes the view unwatchable; the deck is **set back** so the viewer stands at its front edge rather than over its middle, and the plaque sits down-and-left so it never covers the monument.

**The wrist shop panel** (`vrPanel.ts` + `render/vrInput.ts`) is the one part of VR that is input. Without it a headset gets a static-rate diorama — the idle loop *is* earn gold → hire crew → build faster, so a viewer who cannot spend watches the same rate forever. Layout and `hitTestPanel()` are pure and unit-tested, because a headless browser has no controller poses and that is the only way to know the buttons line up with what a ray hits (note `v` is bottom-up from the raycast, flipped into canvas space).

- Hand assignment comes from the runtime's `handedness`, never the controller index — a session that connects the right hand first would otherwise put the panel on the pointing hand.
- Handedness arrives *asynchronously*, so the panel starts mounted on the rig and moves to the wrist when a left hand appears. The always-on info plaque is hidden while the panel holds the rig slot (it shows the same numbers) and returns with the wrist mount.
- **Anything mounted on the rig lives or dies by its height.** At 0.42 m out and 0.68 m below eye level a panel sits 58° below the horizon — outside even a 100° fov, i.e. invisible and the shop unreachable. ~30° down, offset left of the monument's centreline, is the workable window.

`__roboBuilder.vrPreview(true)` runs the entire VR presentation on the flat screen (at a headset-like 100° fov) — that is how the viewpoints are checked and how `tools/e2e-builder-vr.mjs` tests them without a device. Also `vrStatus()`, `vrSkip()`, `vrPress(action)`, `vrPanelState()`, `blueprintProbe(i)`.

### Voxel modes (`craft` + `battle`)

`craft/` is the base voxel world; `battle/` reuses its world/physics/camera/rig and adds combat. All pure and unit-tested:

- `craft/voxelWorld.ts` — a `Uint8Array` grid (block ids, 0 = air), deterministic `generateIsland(seed)`, DDA `raycast`, and `stampCastle` (the central landmark, in both modes). `craft/voxelBody.ts` — AABB-vs-grid physics (axis-separated sweeps, bisected contact, NO auto-step: full-block ledges need a jump). `craft/blocks.ts` — data-driven block catalog (numeric ids persisted in saves — never reorder).
- `craft/voxelView.ts` — the LEGO/toy-brick look: rounded-box instances **oversized slightly** so neighbours overlap (no rounded-edge grooves) + one textured stud per top-exposed brick (stud shares the brick's material so the crayon texture continues onto it). Renders EXPOSED cells only; rebuilds on a dirty flag.
- `battle/{zone,combat,bots}.ts` — shrinking storm (pure time fn), hitscan ray-vs-AABB, bot FSM (rng injected for deterministic tests). Bots and the player obey the same `resolveShot`. Void falls kill (bots too, or the match never ends).

#### Machine lab (`craft/machines/`) — build, test drive, missions

Craft's one rapier user: a connected blueprint becomes **one compound rigid body** in its own `World`, with the surrounding voxels baked into merged box colliders (3×3 chunks, refreshed as it moves). Full operating standard — units, approximations, exception table, what is deliberately NOT simulated — in `docs/MACHINE_PHYSICS.md`; keep it true when you change anything here.

- Layering is strict: `physicsRules.ts`/`aero.ts` (constants + pure force math) → `blueprint.ts` (parts, validation, stats) → `machinePhysics.ts` (rapier) → `workshop.ts` (3D + state) → `workshopUi.ts` (all DOM). `missions.ts` and `library.ts` are pure/storage-only and unit-tested without a browser; `library.ts` is the **only** file in the mode that touches localStorage, and everything read back out goes through `validateBlueprint` first.
- **Everything is a force at a mounting point** — thrusters, wings and balloons all call `addForceAtPoint`, which is why an off-centre nozzle spins the machine and a tail surface damps a spin. Nothing is special-cased per part name.
- Wings are **flat-plate normal force** (`F = -½ρAC·|v|·(v·n)·n`) evaluated with the *point* velocity `v + ω × r`, not the body velocity. No camber, no stall curve — an edge-on wing produces exactly zero, which is the behaviour the unit test pins.
- The **gyro only damps**, it never levels. So any residual thrust offset settles at a constant `torque / damping` spin rate; the presets are laid out mass-symmetric about the thrust line for that reason, and a redesign that ignores it will tip over on take-off.
- The test ground at (79.5, 18.5) is the island's only genuinely flat run (~48 m of level ground straight ahead). It was chosen by scanning the generated world — anywhere near the castle stops a build against a step within seconds, and a sloped spawn tips a wide machine onto a wingtip before the player touches a key.
- `PART_ORDER` must match the GLB: `machineVisual.ts` requires a mesh for every part kind, so a new part means editing `tools/generate-machine-assets.mjs` and re-running `pnpm assets:machines`.
- The build UI is keyboard-first (1‒8 parts, `R` rotate, `M` mirror, `X` erase, `F` frame, `Ctrl+Z`/`Ctrl+Y`) and the drive HUD is its own thing (`C` cycles chase/orbit/cockpit, `R` respawns without ending the run). Chase camera follows **yaw only** — same reason as builder VR: following pitch and roll makes a flying build unwatchable, so the attitude ball carries that instead.
- Leaving the test bounds **respawns** rather than kicking the player back to the editor; only a non-finite state aborts the run.
- **Pilot assist is an autopilot, not physics** (`ASSIST` in `physicsRules.ts`, `G` to toggle, on by default). It drives the machine's *own* gyro torque and lift-thruster throttle and invents no force, so a build that cannot carry its weight still sinks and a build with no gyro cannot level itself. With assist off, `lift` takes the original raw path — the model this doc describes is exactly what you get. Keep that separation: tuning difficulty must never land in `PHYSICS_RULES`.
- The panel's **quick-play** buttons load an example *and start the test drive*, because the first thing a new player needs is to feel the thing move, not to learn a part palette.

### Client rendering & assets

- `player/rig.ts` — every character in every mode is the CC0 **RobotExpressive** glTF (`/models/robot.glb`), loaded once and skeleton-cloned per instance with its own `AnimationMixer`. Gotchas baked in: set `frustumCulled = false` on skinned meshes (stale bounding sphere culls the body but not its shadow), and CLONE materials before fading opacity (the glTF shares materials across clones).
- `render/textures.ts` — central texture registry (one cached instance per URL) + `warmupGpu` (upload every texture and `renderer.compile` every shader during the boot overlay). This is why mid-gameplay never pays a first-sight upload/compile hitch — route ALL texture loads through `loadTexture`, not `new TextureLoader()`.
- `ui/perf.ts` — `?perf=1` overlay (fps / worst-frame ms / draw calls / geo·tex·program counts / JS heap); `__robo*.perf()` exposes the same sample for soak/leak checks.
- Landing assets are size-capped: banner/paper are WebP, logo is a resized PNG; renderer caps `pixelRatio` at 1.5.

### Deployment

Runs on the same host as the `C:\poke` project, fully isolated (own port 8082, `/srv/craftyap`, separate SQLite). Deploy kit at repo root: `Dockerfile` (node:22-slim, only the server's 4 external deps — shared is bundled), `docker-compose.yml`, `ops/nginx/craftyap.com.conf` (+ bootstrap variant), `scripts/{deploy,backup-db}.sh`, and `.github/workflows/deploy.yml` (push to main → test → SSH deploy). Full runbook in `DEPLOY_KO.md`. Verify a running server with `node tools/smoke-prod.mjs <url>`.

### E2E harness conventions

Dev builds expose debug hooks per mode: `window.__robo` (tower), `__roboBuilder`, `__roboCraft` (give/mineAt/placeAt/craft/teleport), `__roboBattle` (killBot/damagePlayer/skipTime/snapshot). Two rules learned the hard way:

- Raw test teleports are **correctly rejected** by the server anti-cheat. Physics-only suites call `__robo.offline()` first; online movement must be kinematically plausible (`glideTo` micro-steps in e2e-multiplayer).
- Background tabs pause rAF (render + fixed loop), so cross-tab comparisons must read data updated by WS handlers, not mesh positions; bring a tab to front before reading its rendered state.

## Known limitations (see README for the user-facing list)

Mid-run reconnect resets server-side checkpoint progress; nickname = identity (no accounts); all rooms share the daily seed by design; sustained within-envelope speed passes validation (records still bounded by min-finish-time + checkpoint order).
