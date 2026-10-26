# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CraftYap — a Roblox-style blocky 3D web game collection (English UI, crayon-doodle brand), one page whose start screen first asks **교육 모드 (education) / 게임 모드 (games)**: education goes straight into the endless field, games lists the four modes below. Live at **https://craftyap.com** (GitHub `yoo9857/yap`).

- **Daily Tower (tower)**: multiplayer obby. A new deterministic tower every day (KST midnight), client-authoritative movement with server sanity validation, persisted daily leaderboard.
- **Robo Builder (builder)**: idle game. Blocky workers construct real-scale voxel world landmarks (Eiffel 330 m, pyramid 230 m base…); no physics, no server dependency, localStorage save with offline settlement.
- **Craft Island (craft)**: single-player voxel sandbox (mine / craft / place). NO rapier — the voxel grid itself is the collider (`craft/voxelBody.ts` AABB sweeps, `voxelWorld.ts` DDA raycast). World regenerates from its seed; the save stores only the edit diff + inventory (zod-validated, hostile-safe). A blocky **pet** tags along (`craft/petCompanion.ts`) — dog, cat, elephant, giraffe or panda, swapped from the 🐾 **입양** chip under the machine-lab chip; **P** toggles sit/follow, and the choice is saved. The 🛋️ **가구** chip below it opens the furniture catalog (~50 pieces in 7 categories, colour variants, search — free and unlimited); **G** enters furniture mode without releasing the mouse (the hotbar becomes the category's furniture bar: **Q/E** category, **1‒9**/wheel piece, **X** colour, **R** turn, right-click place, hold left click to put away, **G** back to blocks). See `docs/FURNITURE.md`. Desktop-only (pointer lock). Press **B** for the **machine lab** — a Besiege-style build-and-test-drive mode that *does* use rapier (see below).
- **Education field (field)**: Craft Island's sandbox (and machine lab) on an endless, empty flat field with 999 of every hotbar block. `craft/fieldWorld.ts` scrolls the usual 160×160 grid under the player in 16-cell steps (= 1 render chunk), banking edits by absolute coordinate, and sets `VoxelWorld.outsideColumn` so physics, rays and machines have ground beyond the grid; a big grass plane carries the view to the fog and the sky is fog-coloured so the far-plane cut never shows. Own save key, separate from the island. `O` cycles the render distance (fog is opaque exactly where chunks stop drawing; a gradient `skyDome.ts` makes the horizon the fog colour).
- **Classroom (education, live)**: the education lobby (`app/classLobby.ts`) offers 선생님 반 만들기 / 학생 반 참여하기 / 혼자 하기. A teacher opens a class under a **class name** (반 이름) + their own name; students type the class name + their own name, are shown **whose class it is** (`k-peek`) and confirm, then land in the same shared field. See *Classroom* below.
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
node tools/e2e-pet.mjs            # pet: spawns, comes to heel, sits on P, recalled when walled off, adopt every species + reload
node tools/e2e-furniture.mjs [png]  # furniture: panel tabs/search/swatches, keyboard bar, floor/rug/surface/wall rules, held-click pickup, cascades, field scroll, reload
node tools/e2e-field.mjs          # education: category screen, endless field, scrolling window keeps edits, save
node tools/e2e-classroom.mjs      # classroom: teacher + 2 students in separate browsers — join/errors, shared building, late join, locks, chat, gather, kick, reconnect, end
node tools/e2e-machines.mjs       # machine lab: build shortcuts, library/share, drive, cameras, flight, wings
node tools/e2e-battle.mjs         # battle: bots live/roam, storm shrink, win & lose paths
node tools/e2e-builder-vr.mjs     # builder VR: rig placement, comfort contract, teardown (needs no headset)
node tools/e2e-production.mjs     # built dist on a single port (no dev server needed)
node tools/perf-craft.mjs [--profile|--alloc|--no-soak]  # field: frame time / camera judder / garbage per scenario (open, wall slide, back-to-wall, corner) + 10-round leak soak
node tools/builder-gallery.mjs <outdir> [i]   # screenshot each landmark for visual review
node tools/builder-shots.mjs <outdir> [i]     # screenshot each camera shot type
node tools/vr-shots.mjs <outdir> [i] [fraction]  # screenshot each VR viewpoint station
node tools/vr-tour.mjs <outdir> [i] [fraction]   # ...plus a self-contained HTML page of them (headset-free "what VR looks like")
node tools/shot-pets.mjs <outdir> [species]   # pose every pet (lineup + six angles each) — this is how proportions get judged
node tools/shot-furniture.mjs <outdir> [category|kind]  # close-up contact sheet per furniture category — how a new piece gets judged
```

## Architecture

pnpm monorepo. `packages/shared` is consumed **as TypeScript source** (`"exports": "./src/index.ts"`) — no build step; Vite/tsx/vitest resolve it directly, and the production server bundles it via tsup `noExternal`. All packages are `noEmit` with `moduleResolution: bundler`. shared and server exclude the DOM lib so browser APIs there fail typecheck.

- `packages/shared` — zod wire protocol (single discriminated union on `t`, `PROTOCOL_VERSION` gate), deterministic level generator (`generateLevel(seed)` — identical output on client and server), daily-tower math (`daily.ts`: seed = f(date in KST), day boundaries), gameplay constants ported from the legacy prototype at 40 px/m (`constants.ts` — these define game feel, don't tweak casually).
- `apps/client/src/main.ts` — mode selector first; each mode lazy-loads. Rapier WASM (~2 MB) loads only for tower mode (craft/battle use the rapier-free voxel physics). `?mode=tower|builder|craft|battle|field` deep-links skip the selector (all E2E relies on this); `&reset=1` wipes a mode's localStorage save.
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
- `craft/voxelView.ts` — the LEGO/toy-brick look: rounded-box instances **oversized slightly** so neighbours overlap (no rounded-edge grooves) + studs on top-exposed bricks (studs share the brick's material so the crayon texture continues onto it). Renders EXPOSED cells only, in **16×16 chunks**, Minecraft-style. Load-bearing rules, don't undo them:
  - **Edits rebuild one chunk** (`markCellDirty`, plus the neighbour on a border) — a full-world `markDirty` rescan was 33–67 ms per placed block.
  - **LOD by chunk distance (altitude included)**: within ~22 m of the focus a chunk is instanced 108-tri LEGO bricks; beyond it collapses into ONE face-culled merged mesh (2 tris per visible face, round/slope bricks baked in). Both forms are cached so a LOD flip is a visibility swap.
  - **Rebuilds go through a nearest-first queue with a 4 ms/frame budget** (the very first fill is synchronous so nothing appears half-built).
  - **Focus = the robot or the driven machine, never the camera**: the orbit camera swings metres when turned, which re-rang studs/LOD every frame.
  - Studs only within 32 m (3D) and they cast no shadows (they were 41% of the island's triangles and doubled the shadow pass).
  - Field scrolling calls `shift(dx, dz)`: chunks still in the window are slid, only the new strip is built.
  - Measured on the island at ground level: 3.7M → 1.6M triangles; field from the air 85k.
- Saves only serialise when something changed (`VoxelWorld.version` + position/inventory signature) and the island's pristine cells are cached per seed — the 5 s autosave used to regenerate the whole island, a hitch every few seconds.
- **Water (released on `main`)**: block ids 19–28 are water states (never renumber), flowed by `packages/shared/src/fluid.ts` — locally in solo play, by the SERVER in classrooms. Design, limits and release verification: `docs/WATER.md`.
- `battle/{zone,combat,bots}.ts` — shrinking storm (pure time fn), hitscan ray-vs-AABB, bot FSM (rng injected for deterministic tests). Bots and the player obey the same `resolveShot`. Void falls kill (bots too, or the match never ends).
- `player/pet.ts` (pure brain) + `craft/petCompanion.ts` (glue) — the puppy. It is a `Body` with its own `w`/`h`/`jumpSpeed`, so it collides through the same sweep as the player and cannot pass anything the player cannot. Four things are load-bearing and unit-tested:
  - **Two separate progress timers.** `blocked` (near-zero displacement) drives hop-then-sidestep; `noGain` (no new best distance to the owner) drives the give-up recall. Merging them fails both ways round: displacement alone says a dog skating along a wall is progressing and it slides forever, closing-distance alone says a dog hopping a ledge is stuck. Neither may be reset by the hop itself, or the escalation ladder never climbs past its first rung.
  - **The hop must clear a full block** — rise is `v²/2g`, so against voxelBody's 24 m/s² anything under ~7 m/s leaves the pet rattling against every 1 m step on the island.
  - **It goes round, then gives up.** Two-block walls exist and the pet has no pathfinding; after `LOST_TIME` of no gain it asks to be recalled. A companion that can be permanently lost behind a wall is worse than one that occasionally reappears.
  - **The step probe lives in the caller.** `PetCompanion` reads the voxel ahead and passes a boolean in, so the brain stays world-free and testable.
- **Furniture** (`craft/furniture/`, full standard in `docs/FURNITURE.md`): the catalog is **data** (`catalog/*.ts`, parts lists built with `kit.ts`) checked entry by entry by `test/furniture-catalog.test.ts`; rules are pure (`layout.ts`, `footprint.ts`, tested in `test/furniture-layout.test.ts`); `CraftGame` only talks to `FurnitureController`. Load-bearing:
  - **Collision is whole cells, through `VoxelWorld.propSolid`.** Bodies (`isBlocked`) and the player's aim (`raycast(..., true)`) hit solid furniture; **`isSolid` must not** — the renderer culls faces with it, so a chair beside a wall would punch a hole in the wall.
  - **Four layers per cell** (solid / rug / surface / wall) are what let a rug lie under a sofa, a vase stand on a table and a clock hang over a bed. Placement is all-or-nothing; a piece goes when its *last* support is mined, and takes what stood on it.
  - **The layout holds ABSOLUTE cells**, so a field scroll never touches it.
  - **One `InstancedMesh` per (kind, colour) in use** — 400 chairs cost 3 draw calls. Geometry is built once per kind as an indexed **shape** (1–2 corner segments, `mergeVertices`; ~83k vertices for all 53 kinds — un-indexed bricks once made a bookshelf 175k) and each colour **shares its buffers**, owning only a colour attribute (`paintFurniture`; never dispose one look alone). `model.ts` clones its cached source shapes before transforming them. Default looks pre-build in idle time; the boot warm-up draws a furniture instance, the ghost and the cell highlight (all `frustumCulled = false`) so no furniture shader compiles mid-game.
  - **Keys and palette indices are persisted**: never rename a kind, only append palettes. Categories hold ≤ 9 pieces (the bar is 1‒9).
  - **Depth is built, not painted.** Parts are `box`/`ball`/`cyl` (tapered: shades, an open parasol)/`dome`, each optionally rotated; a tub or basin is `hollow()` with the water below the rim. Floor-level slabs must be ≥ `RUG_TOP` (0.14 m) or the floor studs poke through.
  - **Shared in classrooms**: the server validates and persists furniture; initial join, reconnect, edits and rejection restore the authoritative layout. Machines collide with solid furniture (the rapier terrain bake uses `isBlocked`).
  - **Doors/gates/curtains** (`openParts`): right-click toggles in any mode, middle-click picks a piece's kind+colour; an open door is not solid; aiming is per part (`rayPiece`) so an open doorway can be clicked through and still shut again.
  - **Seats** (`seat` height): right-click outside furniture mode sits the robot (rig `"sit"` pose) facing the seat's front; physics is suspended while seated (the body is inside the piece's solid cells) and any move key, or the seat disappearing, stands it up in front. **Ctrl+Z / Ctrl+Y** undo/redo the player's own place/put-away steps (block-mining cascades are deliberately not undoable).

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

### Classroom (`packages/shared/src/protocol/classroom.ts`, `apps/server/src/classroom/`, client `net/classClient.ts` + `craft/class{Sync,Hud}.ts`)

Live multiplayer for the education field, deliberately separate from the tower protocol (own `k-`/`s-k-` messages and `CLASS_PROTOCOL_VERSION`); it rides the same `/ws` endpoint, selected by `?mode=class`, so nginx/vite need nothing new.

- **Rooms are keyed by the CLASS NAME** (`classKey`, case/space-insensitive), not the teacher's name — two teachers with the same name can run differently named classes. A class name owned by another teacher (live or saved) is `room-taken`; the same teacher opening their live class twice is `teacher-taken`; a student name already online is `name-taken`; nobody may use the teacher's name as a student. `k-peek {room}` answers `s-k-room {exists, open, teacher}` and closes the socket — the student's confirm card. Protocol v5 (paced initial streaming and reliable replay; v4 added water).
  - **Classes saved before named classes** have no `roomName`: their key was the teacher's name, so that name IS their class name (`ClassRoom` defaults `roomName` to it). Re-open such a class with class name = teacher name.
- **Keys, not accounts.** The welcome hands out a key (teacher: host key, student: seat key) kept in localStorage per class. A refresh/reconnect re-takes the same seat; the teacher seat is only re-taken with its host key, so typing a teacher's name never grants teacher powers.
- **Everything on the wire is in ABSOLUTE field coordinates.** Each client scrolls its own voxel window, so grid coords differ per machine; `ClassSync` is the only place that converts.
- The server keeps the shared field as an edit diff vs the flat field (bedrock immutable, 300k-cell cap) and streams it to late joiners under a shared CPU budget and bounded transport queues; `ClassClient.connect()` resolves only once the whole field has arrived. Reliable updates received during loading replay after handlers are installed. Reconnect replaces the field and local identity, releases old remote avatars and moves embedded players out of restored terrain. See `docs/WORLD_RUNTIME.md` for invariants and repeatable resource checks.
- Teacher-only actions (`k-kick`, `k-gather`, `k-settings` build/chat locks, `k-end`) are role-checked server-side; `s-k-reject` carries authoritative cell values, including rate-limited edits, so repeated optimistic writes return to the last accepted server value.
- `ClassRoom` is socket-free (talks to a `ClassPeer`) so its rules are unit-tested in `apps/server/test/classroom.test.ts`.
- **Classes are saved** (`classStore.ts`, table `classes` in the SAME `records.db`, so the bind-mount and the daily backup already cover it): field edits, settings, teacher key and every student's name + seat key. Written every 15 s when dirty, on 수업 종료, on idle collection (30 min empty) and on shutdown; classes untouched for 180 days are purged at boot. Re-opening a saved class needs the host key (same browser) **or the class password** (any PC) — a new class can't be opened without a ≥4-char password, stored only as scrypt hash + salt. Students can only join a class the teacher has opened. `k-reset-world` (🧹 들판 비우기) wipes the saved field.
- Deep links for testing: `?mode=field&room=<class>&host=<teacher>&pass=<password>` and `?mode=field&room=<class>&student=<s>` (old links without `room` use the teacher name as the class name). Debug hooks: `__roboCraft.classroom()`, `classSend(msg)`, `absolute()`. E2E runs each participant in its own browser (background tabs pause rAF, which is the game loop).

### Client rendering & assets

- **Characters are built from code, not modelled.** `player/blockParts.ts` is the shared toolkit — cached rounded boxes, one crayon-grain canvas, and an inverted-hull shader that gives every part the same 2 cm ink line. `player/rig.ts` is the biped cast (one cube body with a face decal, per-variant topper); `player/creatureRig.ts` is every quadruped pet. Both put feet at the origin and the face at +z, and expose `update(anim, speed, dt)` / `pop(impulse)`, so callers place them identically. Put new creatures through `blockParts` — a second grain canvas is a second GPU upload and the two casts drift apart in look.
- **`creatureRig.ts` is one skeleton, five species.** A chest-pivot spine, four legs in diagonal pairs, hinged head and tail, plus a per-species builder for the head, ears and extras (the elephant's trunk is a four-link chain; the giraffe's neck is its own raked group). Five separately-written gaits would drift apart the moment one was tuned. `SPECIES` is a three.js-free registry (collider, hop, pace, panel copy) that the physics, the save and the DOM all read — the adoption panel never imports a renderer.
  - **The ink line is drawn in SCREEN SPACE** (`render/inkOutline.ts`), not per brick. Each part used to carry an inverted-hull shell, which rings every *brick* — so the head's shell cut a band across the neck, the tail's across the rump, and no line-weight tuning could remove them, because they were lines that should not exist. The pass renders characters (`INK_LAYER`) into a silhouette mask, finds the mask's edges, and inks those: one line per creature, none inside it, and a constant pixel weight at any distance. The hull shells still exist on `HULL_LAYER` as the WebXR fallback (a headset owns the framebuffer; render targets do not survive it) and `?ink=0` forces them for comparison. Measured incremental cost: 51 draw calls and 40k triangles a frame.
    - Three traps, all hit: the mask needs **its own depth buffer** (re-rasterising the same triangles does not reproduce the scene's depth bit-for-bit, so `LESS_EQUAL` punches holes the edge detector faithfully inks — occlusion is a depth *comparison* in the composite instead); the composite must do its **own sRGB conversion** (a raw `ShaderMaterial` gets none of three's output chunks); and the extra passes must **freeze the shadow map**, which otherwise rebuilds per `render()` ignoring camera layers.
  - **That pass is what lets bodies be curved.** Torsos are chains of overlapping ellipsoids (`torso()`), with a deep chest, a tucked waist and a tapering rump — impossible while every extra brick added its own ring. Space the lumps at about a quarter of their depth: ripple is `R - sqrt(R² - (S/2)²)`, and the first attempt at nearly a full radius produced a caterpillar.
  - **The ink line scales with the part** for the fallback hulls (`outlineWidth` in `blockParts.ts`). A flat 2 cm is right for a 1 m body and ruinous for a 6 cm eye: the hull was wider than the brick inside it, so every face rendered as black blobs.
  - **Faces carry no ink line at all.** Eyes, noses and animal markings are spheres (`blob`). A rounded box at 5 cm still shows corners and a border, so an eye became a white tile, a nose a crate on the muzzle, and the panda's patches a pair of spectacle frames wider than its skull. The eye's dark rim is drawn as another sphere.
  - **Depth is the other half of a face.** Every layer must sit clearly in front of the last or the surfaces interleave into z-fighting stripes — and the eye must still stay ON the skull: pushed too far forward the panda's eyes floated off its silhouette in profile.
  - **`soft` is a fraction of the smallest dimension**, so the same value on two bricks of different depth gives two different corner radii, and a join that should be invisible shows as a groove. Matching a neighbour means computing the fraction, not copying it.
  - **Ground contact is derived, never configured.** `legs()` computes the leg length from `shoulderY` so the paw's underside lands on y = 0. When the two were independent numbers every pet hovered — the panda by 20 cm — and it survived a dozen screenshot reviews unnoticed. Unit-tested.
  - **Limbs need a shoulder.** A torso brick with four leg bricks bolted under it is a table: the join is a hard step ringed by two ink outlines. `legs()` adds a rounded hip/shoulder mass at each root overlapping both, and the limb reads as growing out of the body.
  - **Stride is in radians and is smaller than it looks.** Legs running shoulder-to-ground throw the foot much further per radian than stubs do; the pre-grounding values left every animal doing the splits.
  - Other rules worth keeping: a shape is **one brick or it is two things** (a point comes from a square turned 45° and half-buried, never a stacked taper); markings sit **on** a surface, never in front of it or inside it; anything animated over a rest pose must **add** to it, not overwrite it (writing `rotation.x` straightened the trunk every frame).
  - Judge every change with `tools/shot-pets.mjs`, which shoots a lineup, six body angles and **two face close-ups** per species. Reasoning about rounded boxes does not work and whole-body framing hides faces — the first cat was a rabbit, the first elephant wore solar panels, and the panda went through war paint, a scowl and a cardboard box.
- `apps/client/src/app/charPreview.ts` — `?preview=char` turntable (mascots behind, pets in front) with `__charPreview.pinDog(anim, yaw)` to freeze a pose for screenshots, the same idea as the builder's `pinShot()`.
- `render/textures.ts` — central texture registry (one cached instance per URL) + `warmupGpu` (upload every texture and `renderer.compile` every shader during the boot overlay). This is why mid-gameplay never pays a first-sight upload/compile hitch — route ALL texture loads through `loadTexture`, not `new TextureLoader()`.
- `ui/perf.ts` — `?perf=1` overlay (fps / worst-frame ms / draw calls / geo·tex·program counts / JS heap, and the worst frame's per-phase work: `perf.time("render", …)`); `__robo*.perf()` exposes the same sample for soak/leak checks.
- **Never let one material serve two shader variants per frame.** three re-derives the program (parameters + cache-key strings) on every switch — every object, every frame — which was the top of the CPU profile and ~90% of the garbage (GC pauses = the "turning stutters" reports). The rules that keep it from coming back:
  - **Every light is `layers.enableAll()`** wherever it is created. The ink mask camera only sees `INK_LAYER`s; a mask pass that saw no lights flipped the shared light state 2 → 0 → 2 each frame and invalidated EVERY lit material.
  - **Instanced shadow casters use `castsInstancedShadow(mesh)`** (`render/instancedDepth.ts`): three's single shared depth material otherwise flips between instanced and plain casters.
  - **A material is either instanced or not**: voxelView keeps twin materials (instanced near bricks / merged far chunks); instanced meshes go on `INK_INSTANCED_LAYER`, not `INK_LAYER`, for the mask pass's own override material.
- **Draw between ticks** (`craft/smoothing.ts`): physics is fixed 60 Hz; the player and the pet are DRAWN `interpolate(prev, curr, alpha)` and the view angles `easeAngle` (~25 ms, absorbs a 125 Hz mouse vs a 144 Hz screen). Aim/mining use the exact angles. Unit-tested with irregular frame schedules — headless SwiftShader frame times are too noisy to judge smoothness by.
- **Reuse GPU resources, don't copy them**: one material per source when cloning (e.g. the robot fade clones per *material*, not per mesh), one cached geometry per shape, shared attributes for recoloured copies, one grain texture (`blockParts.crayonGrain`). Audit with `__roboCraft.scene()`: group materials/geometries/textures by content and look for copies.
- **The robot's body is not glued to the camera** (`CraftGame.updateFacing`, `turnToward` in `smoothing.ts`): walking, it turns toward the camera-relative key direction (S walks it face-first toward the camera); mining/placing turn it back to the crosshair for `ACTION_FACE_TIME`; seated = seat yaw; first person = view. The classroom sends this body heading, not the camera yaw.
- Landing assets are size-capped: banner/paper are WebP, logo is a resized PNG; renderer caps `pixelRatio` at 1.5.

### Deployment

Runs on the same host as the `C:\poke` project, fully isolated (own port 8082, `/srv/craftyap`, separate SQLite). Deploy kit at repo root: `Dockerfile` (node:22-slim, only the server's 4 external deps — shared is bundled), `docker-compose.yml`, `ops/nginx/craftyap.com.conf` (+ bootstrap variant), `scripts/{deploy,backup-db}.sh`, and `.github/workflows/deploy.yml` (push to main → test → SSH deploy). Full runbook in `DEPLOY_KO.md`. Verify a running server with `node tools/smoke-prod.mjs <url>`. **Every deploy first snapshots the live DB** (`scripts/pre-deploy-backup.sh` → `/srv/craftyap/data/pre-deploy/`, newest 10, online backup — sqlite3 CLI or better-sqlite3 inside the running container) and aborts if it can't; that snapshot is the rollback point for saved classrooms. A change to the classroom save format must stay readable by BOTH the new and the previous server (rollback): add optional fields, never rename keys or rewrite rows.

### E2E harness conventions

Dev builds expose debug hooks per mode: `window.__robo` (tower), `__roboBuilder`, `__roboCraft` (give/mineAt/placeAt/craft/teleport), `__roboBattle` (killBot/damagePlayer/skipTime/snapshot). Two rules learned the hard way:

- Raw test teleports are **correctly rejected** by the server anti-cheat. Physics-only suites call `__robo.offline()` first; online movement must be kinematically plausible (`glideTo` micro-steps in e2e-multiplayer).
- Background tabs pause rAF (render + fixed loop), so cross-tab comparisons must read data updated by WS handlers, not mesh positions; bring a tab to front before reading its rendered state.

## Known limitations (see README for the user-facing list)

Mid-run reconnect resets server-side checkpoint progress; nickname = identity (no accounts); all rooms share the daily seed by design; sustained within-envelope speed passes validation (records still bounded by min-finish-time + checkpoint order).
