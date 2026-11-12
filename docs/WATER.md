# Water rendering and simulation

The renderer uses Three.js/WebGL2, a TypeScript surface-net mesher in a module
Web Worker, and a small shared cellular fluid simulation. Classrooms run the
simulation on the server. Solo fields/islands run the same rules locally.

## Persistent states

- `19`: explicitly poured, inexhaustible source.
- `20..26`: flowing levels 1..7.
- `27`: falling water.
- `28`: retained basin water. Unlike a source, it drains when its container opens.

These IDs are persisted; never renumber them. The client only submits source
placement/removal. The server produces flowing, falling and retained states.
Classroom protocol 5 includes water support and paced world transfer with reliable
replay during loading (protocol 4 introduced water). The version gate prevents
clients predating water from interpreting these IDs as solid, invisible blocks.
Existing block/furniture saves remain valid.

## Continuous geometry

`waterGeometry.ts` extracts a single boundary between water and its surroundings.
It does not assemble separate surface/lip/fall boxes. Each lattice cube connects
its crossing edges into contour loops with a consistent decision on shared faces.
This preserves separate streams and air pockets, including a fully alternating
three-dimensional grid. Parallel edges through a saddle face receive separate
segment vertices rather than being welded into a non-manifold edge.

Nodes and curved edge points are defined from world samples, not the chunk that
requests them. Adjacent chunks therefore share the same position, normal, flow,
wave amplitude and impact data. Solid-contact constraints keep the water against
the terrain. Flat water retains its physical level beside a bank. Shared tangent
projections round the source, spillway and landing without introducing T-junctions.

`aGrid` identifies components/edges across rebuilds. A 180 ms GPU transition
continues from the displayed position if another edit interrupts it. The field's
scroll offset is accounted for in both this match and the ripple coordinates.

## Scheduling and failure recovery

`VoxelView` snapshots the voxel state, then sends affected chunks to `waterWorker`.
Attribute/index buffers return by transfer. Old meshes stay visible until the
whole generation is ready; the replacement is committed together. Terrain edits
invalidate diagonal water neighbours as well as the brick meshes. A pure brick
LOD change does not rebuild the water.

The worker yields between groups of jobs so a newer generation can cancel old
work. World resets, scrolling and disposal cancel staged work and free its
geometry. A worker construction/runtime failure falls back to the same mesher
with a two-millisecond scheduling budget (one chunk can exceed that budget).
Materials and meshes are reused. Resource tests exercise fallback, interruption,
scrolling and disposal; browser QA checks shader/geometry counts over pour cycles.

## Appearance and simulation limits

The shared material uses a periodic mipmapped detail texture, advected flow,
Fresnel reflection, depth-dependent tint/opacity, and impact foam/radial ripples.
It uses the scene's lighting, shadows and fog, with no second reflection-camera
render. Animation only updates uniforms. Camera-water hysteresis avoids fog flicker.

Fluid steps are 250 ms, at most 4096 pending cells per step. Solo work uses a 3 ms
read budget; classroom work uses 4 ms per room under a shared 12 ms round-robin
budget. These are soft scheduling budgets: a single operation, commit, broadcast
or garbage collection can exceed them. Under heavy load, flow advances more slowly.
A closed, fed basin
of at most 256 cells per layer (`BASIN_CELLS`; 4096 for a layer wholly under water, `BASIN_SUBMERGED`) can retain water; a lower outlet drains it again.
This is a bounded voxel game simulation, not a volume-conserving fluid solver.
Explicit sources and the existing two-source infinite-pool rule remain inexhaustible.

## Verification

```
pnpm typecheck
pnpm lint
pnpm test
pnpm build
node tools/qa-water.mjs tmp/water-review
node tools/bench-water.mjs
```

QA covers a deep pool, a cross-chunk waterfall, shoreline, a new pit, stair-like
terrain before/after destruction, and repeated pour/replace cycles. Unit regressions
check watertight connections, separate diagonal components, identical chunk edges,
interrupted transitions, randomized terrain destruction, retained-pool drainage,
door displacement, worker failure and stale-generation cancellation.

## Release validation (2026-10-26)

- 371 unit tests; type checking and ESLint pass.
- Real water input: 14/14 (bucket, seven-cell flow, scoop/drain, swim, climb,
  underwater camera, reload, worker, two-browser classroom flow and build lock).
- Regression suites: craft 7/7, field 11/11, furniture 58/58, pet 18/18,
  classroom 44/44, machine lab, battle 7/7, production 9/9.
- Production verification includes a real bucket pour through the bundled module
  worker, with no development hooks.
- Terrain QA: staircase destruction and pit filling have no JavaScript/WebGL
  errors. Six pour/replace cycles plateau at 93 geometries and 26 shader programs.
  The observed main-thread water rebuild peak is 1.4 ms in this test scene.
- Reference geometry: a 32x32 deep pool uses 116,832 bytes versus 589,824 in the
  initial renderer; the 16x20 waterfall uses 77,808 versus 281,088. CPU meshing
  happens off the render thread; these are scene-specific measurements.
- Compatibility proof: the previous production ClassRoom loads and preserves all
  water IDs, furniture, class name and credentials in a new saved classroom.

Deployment snapshots the live SQLite database before the hand-over. Since
2026-11-06 deploys no longer wait for an idle app: `scripts/zero-downtime-deploy.sh`
starts the new container beside the old one, locks new game sockets for the few
seconds of the switch (so a class can never open on both), and the old container
saves every class before it closes (see DEPLOY_KO.md, 무중단 배포).
Refreshing an older classroom tab loads protocol 5 and the current water renderer.

Automatic ocean/lake generation remains a separate follow-up; this release covers
player-built water, its interaction with edited terrain, and classroom sharing.

## Functional audit (2026-10-26)

- Solo field scrolling reactivates restored water and newly exposed flow edges.
  Pending work outside the old window cannot strand a saved source.
- Classroom fluid writes enforce the 300,000-cell cap at commit, not only during
  the step's snapshot reads. Only committed writes are broadcast; freeing storage
  reactivates frontiers that were stopped by the cap.
- Island save validation accepts up to the actual grid's cell count, matching
  what the serializer can write. Saves above the previous 200,000-edit limit
  reload intact instead of resetting the island.
- Browser autosave marks a snapshot saved only after a successful write. Failed
  writes show a warning and retry; recovery is reported. Field saves above the
  loader's 400,000-edit cap leave the previous readable save untouched. Field
  scroll origins participate in autosave change detection.
- A failed classroom database write remains dirty for the next save interval.

Regression cases reproduce a field return, an almost-full classroom store,
200,001 island water edits, an over-limit field save, and a transient database
failure. Browser water E2E also injects a quota error and verifies retry/recovery.
Validation: 376 unit tests, water E2E 16/16, field E2E 11/11, production E2E
9/9; type checking, ESLint and the production build pass.

## Adversarial water load (2026-10-26)

- Fluid queues, basin memoization and classroom edit maps use exact compact
  coordinate keys. Distant solo coordinates retain a lossless string fallback.
  The persisted classroom tuples and protocol remain unchanged.
- Dense solo restores activate at most 256 wet cells per fixed tick, scanning
  at most 262,144 cells under a soft one-millisecond scan budget. Fully enclosed,
  unblocked sources need no initial work. The scan budget also covers furniture
  collision lookups in a dense volume.
  A field scroll resets this scan so restored water cannot lose its wakeup.
- Classroom capacity recovery scans incrementally instead of re-enqueuing all
  300,000 stored cells. A full store releases its iterator, preventing repeated
  replacements from retaining old Map tables. Busy classrooms share the fluid
  time budget fairly.
- Initial browser water meshes also use the worker. Contour loops and distinct
  saddle segments close checkerboard surfaces while removing redundant geometry.
  Edge decisions are identical across chunks. A generation above 32,768 vertices
  omits transition matching for every neighbour together; all surfaces remain.

Repeatable local probes (isolated worlds, no production bulk traffic):

```
node tools/stress-water.mjs tmp/water-load-final
pnpm --filter @robo/server exec node --expose-gc --import tsx ../../tools/stress-water-server.mjs --raw
pnpm --filter @robo/server exec node --expose-gc --import tsx ../../tools/stress-water-server.mjs
```

Observed on the Windows/Edge test machine:

- 200,000 dense solo water cells, with furniture collision lookups, finish
  activation/flow with no pending work. Simulation update p95 is 3.0 ms; the
  largest observed update is 7.0 ms.
- 18,432 disconnected sources across nine chunks: 148,116 vertices and
  15,554,160 bytes of mesh data. Four place/change/remove cycles return GPU
  geometry counts from 9 to 0 every time; the shared texture remains at 1.
  Post-GC main heap growth after warmup is below 0.25 MiB; worker growth is below 0.02 MiB.
  Worker backing storage plateaus. JavaScript/WebGL errors: none.
- A 50,000-source classroom restore uses about 21 MiB additional heap versus
  about 55 MiB before this change. The bounded six-millisecond room probe records
  a 6.5 ms median and 7.8 ms maximum including commit overhead. Production's
  manager passes four milliseconds per room under its shared budget.

These are scenario-specific measurements, not a constant-memory or FPS guarantee.
GPU cost still depends on exposed surfaces and disconnected fragments. A very
fragmented generation can take roughly a second in the worker, while old meshes
remain visible and the input thread stays available.

Final regressions: 385 unit tests; water E2E 16/16, classroom E2E 44/44 and
production E2E 9/9. The production jump check missed input once and passed a clean
rerun without product changes. Terrain/pit/stair QA remains error-free and six
pour/replace cycles plateau at 93 geometries and 26 shader programs.

## Water inside shaped blocks — waterlogging (2026-11-04)

A triangle, corner, round, half block or stairs fills only part of its cell, and
the simulation now puts water in the rest (`packages/shared/src/waterlog.ts`):

- **A water layer beside the block.** The cell keeps its block id and shape; the
  water it holds is a separate value (`VoxelWorld.wet`, the field's banked `wet`
  map, the server's `ClassRoom.wet`). `FluidWorld.get/set` read and write that
  layer for such cells (`holdsWaterlog(block, shape)`), so the rules in `fluid.ts`
  run unchanged on them. Writing a cell (place, mine, a classmate's edit) clears
  its water on every side; the flow refills it the next step. Mining such a block
  is the exception: its water stays in the cell (client `writeCell`, server
  `applyEdits` → an `s-k-edit` from "" to everyone), so no dry hole flashes.
- **Sealed faces.** `FluidWorld.seal` gives the faces water cannot pass (FACE_*
  bits): a face covered by more than 77 % of the shape (`shapeSeal`, sampled
  16×16). Ramps: back + floor; half blocks: floor (upside down: roof); stairs: back
  + floor (their 75 % sides stay open); corners: floor; round: top + bottom (a disc
  covers 79 %). Movement between two cells needs both shared faces open, sideways
  and up/down: water falls into a ramp or half block from above, but spreads over a
  round's top as over a floor.
- **Never saved.** It is flow state. A reloaded island/field or a restored class
  re-flows it from the saved water around it within a few steps (sources wake their
  neighbours). Saves, the field bank format and the classroom store are unchanged,
  so a rollback reads every row.
- **Classroom:** protocol 10 adds `s-k-wet` (absolute x, y, z, water id or 0). The
  server sends it for flow changes inside shaped cells, the whole layer after a join
  (replayed after the streamed world), and the cells of a refused edit.
- **Rendering:** the mesher's snapshot takes the layer as that cell's water id
  (`waterlogSnapshot`); the opaque block covers what falls inside its solid part.
  Swimming and the underwater camera read `VoxelWorld.waterAt`.
- Limits: the bucket cannot scoop water out of a shaped block. A half block in a
  pool's rim lets water out onto the land (its sides are half open).

Checked by `packages/shared/test/waterlog.test.ts`, `apps/client/test/water-shapes.test.ts`,
the classroom water test and `node tools/shot-water-mixed.mjs` (triangle + round pairs,
clusters, against a wall, at the surface, in the rim, and a stream on open ground;
fails if any shaped cell the water reaches stays dry).

## Running water: sheets, films, corners, furniture (2026-11-11)

Players' screenshots showed water standing round blocks as cell-sized bodies: a box of water round
a ramp, a dome round shapes hanging in the air, two separate strips down two faces of a block, a
dry pit round every chair. The rules stay Minecraft-style cells; what changed is what is DRAWN for
water that is running off something, and where furniture keeps water out.

- **Furniture stands in the water.** Only a piece that shuts (a closed door or gate: `openParts`)
  keeps water out of its cells (`FurnitureLayout.holdsBackWater` / `waterCells`, client hook
  `VoxelWorld.propDry`, server `ClassRoom.fluidWorld.open`, the Rust mirrors' `props`). A chair, table
  or sofa used to hold a whole dry cell. Bodies still collide with them (`propSolid`, unchanged).
- **A sheet on the face it runs down** (`waterGeometry.ts` `sheet`, `SHEET` = 0.34 m): a falling
  cell, or a flowing cell hanging over an edge, that has open air on one side and something to run
  off on the other (a solid, standing water, or a shaped block holding water) reaches only `SHEET`
  from that side. A fall with nothing beside it keeps its whole column; an inside corner keeps the cell.
- **One sheet round a block's corner.** Two wet cells meeting corner to corner are two streams in
  the open, but ONE surface when the other two cells are a solid and air (the contour joins round the
  dry corners), and each sheet reaches `SHEET` past the block's edge so the join has thickness.
- **A film over a shaped block.** Water that FELL onto a ramp, half block or stairs (the cell's water
  is falling water) is drawn `FILM` (0.22 m) above the block's top at each corner of its cell
  (`shapeProfile` in waterlog.ts, handed to the mesher per cell as `profile`), and the flowing lip
  directly above it is not drawn a second time (`waterlogSnapshot`). Water that reached a shape from
  the side stands at its own level as before; such cells are marked `WATER_HELD` so what spills out of
  them still runs down as a sheet.
- **Straight columns.** A face's centre vertex lies on its curved edges (a Coons patch); at the flat
  average a falling column was 10 cm narrower halfway up every block.

- **Running water is placed per axis** (`JOIN` = 0.8): a vertex of a fall, sheet or lip takes each
  coordinate from the crossings ALONG that axis (its side stays upright, its top level, a sheet as
  thick at a corner as on its face) instead of the average of every crossing, which tilted them into
  slanted panels between blocks hanging at different heights. Where a higher stream or a fall meets
  water below, the foot is pulled to the line where they meet (no half-cell skirt). Standing water and
  ground streams keep the rounded average.
- **Stacked blocks** (follow-up, same day): a fall keeps the sheet of the fall above it once the
  face it ran down ends (a curtain below a hanging block, not a whole cell again); a fall that has
  LANDED on a block counts as standing water for the lip beside it; and a block that only the water
  BELOW touches no longer pins the falling side's vertex to its corner (`below` constraints yield
  to the falling side's own crossing on that axis). `test/water-slant.test.ts` settles water over
  hanging blocks with the real rules and adds up the triangles that are neither upright nor level:
  27 m² with the first mesher, under 6 now. Two more rules got it there: running water's vertices
  are placed EXACTLY per axis (the 20 % of the average kept at first leaned every sheet outward just
  above its foot), and only outward (convex) edges are rounded — rounding the inward crease where a
  sheet meets the water below cut 10 cm into the sheet. What is left comes from one vertex per
  lattice cube having to stand for several features at once (two curtains at different heights
  meeting, a hovering source above its own sheet); removing it needs more than one vertex per cube.
- **Water goes over an edge in a curve, and its lips meet at the block's top corners**: the rim of
  a lip (the top and a side of the SAME cell in one vertex: an outward edge) is placed mostly at the
  rounded average (`RIM` = 0.3) instead of the exact corner, which made a square plate over every
  edge; and a lip's end goes on round the corner like a sheet's (`turnsCorner`: the cell round the
  corner is a lip too), where two lips used to meet in a point with a square notch outside it.
  `test/water-slant.test.ts` therefore counts only BIG tilted panels (over 0.2 m² in one triangle):
  the rounded rims are tilted on purpose.
- **The snapshot hands over a chunk's whole re-meshed height**, not just the changed layers: a shaped
  block's water above or below a change used to vanish from the new mesh. The worker gets the
  profile marks as a sparse list (a second whole-grid copy per build was 1.4 MB of garbage).

- **Three passes, one shader** (`makeWaterMaterial(pass)`, `VoxelView.installWater`; web only): the
  level surfaces first, without depth; then ALL the water's depth, no colour; then the steep faces'
  colour, only where it is that nearest depth. A sheet or a fall therefore blends exactly one layer,
  over the level water behind it. In one double-sided pass without depth, a sheet's front, back and
  every sheet behind it stacked (dark overlaps, inner edges showing through) in triangle order,
  which changed with every flow step (the shimmer). Nearest-layer for everything dropped the stream
  behind a sheet (a bright dry patch); steep-only depth let steep faces show through level ones.
  Cost: three draw calls per water chunk instead of one, the same program (`uPass` is a uniform).

All of it is in both meshers (`engine/crates/core/src/water_mesh.rs`, bit-identical:
`test/rust-water-mesh.test.ts` now feeds random profiles). `water_mesh` (wasm) takes the profile
array as a 4th argument; `build_water_mesh` (the native app's call) passes none, so the app draws
sheets and joined corners but not films yet. Swimming still counts the whole cell.

Two rules of the simulation changed with it (same day, `fluid.ts` + the Rust twins, parity-tested):

- **Water that fell onto a ramp or a step runs down it** (`runsAway`): a falling-water cell in a
  block whose shape seals its floor and exactly one side (ramps and stairs standing on their floor)
  feeds only the cell opposite that back. It used to spill through the open triangular sides too,
  so every slide grew a curtain of water down each flank. Water that reached the block from the side
  still passes through it; a half block (no back) still spills every way.
- **Running water is shallower** (`waterHeight`, and `body.rs`): standing water (source, retained
  basin) is still 0.875 of its cell; flowing water is `0.64 − level × 0.077` (0.56 m beside the
  source, 0.10 m at the seventh cell) instead of `0.875 − level × 0.11` (0.77 m beside the source).
  Wading and swimming read the same function, so a stream is waded, not swum.

Not changed: a source on a pillar still runs down all four faces, and the seven-cell reach.
`node tools/shot-water-flow.mjs [outdir]` builds every case above (walls, falls,
furniture, steps, shapes, a slide, hanging shapes, a pillar's corners), prints the cells and shoots
them; `ONLY=shape,corner` picks scenes.

## Finite water — prototype behind `?water=finite` (2026-11-11)

Players: "break a pool's wall and the last stream never ends — water is made forever". True of the
rules above: every poured bucket is a spring, so an opened tank keeps all twelve cells and feeds a
stream for ever (`tools/shot-water-break.mjs` films it). `packages/shared/src/fluidVolume.ts`
(`FiniteFluidSim`, `test/fluid-volume.test.ts`) is the alternative, on SOLO play only for now:

- **The same ids, read as amounts** (eighths of a cell): 28 = full, 20…26 = 7…1, 27 = the trail
  under dropping water (no water of its own), 19 = a SPRING that never runs dry. Nothing new is
  saved, and every older world's poured water simply stays a spring. The bucket pours 28 and scoops
  whatever a cell holds. Heights are drawn by amount (`drawWaterByAmount`, set in the game thread
  and in the water worker).
- **Rules**, cell by cell with every move written at once so the total is exact: down first (through
  open air straight to what holds it); then sideways, an eighth at a time to the lowest cell in
  reach while it is two eighths lower — a neighbour, or up to four cells away THROUGH water, which
  is what makes a pool settle flat instead of as a staircase; then a film nothing will feed dries
  (a hash of cell and step, about one evaluation in eight).
- So: a walled pool stands; an opened one runs out and its water spreads thin and dries; a bucket on
  open ground is a puddle for a few seconds; in a pit it stays; a fall is visible only while water
  is dropping; a spring keeps feeding and what it fed dries once the spring is scooped.

Not done, in the order it would have to be: a spring item (today only old saves have springs), the
Rust twin + parity test, the classroom server (`ClassRoom.stepFluids`, and the bucket/scoop rules
there), the island, shaped blocks under the new rules (the `seal` hooks are used but unshot), and
the E2E suite (e2e-water asserts the seven-cell stream). Try it: `/?mode=field&water=finite`;
film it: `QUERY="&water=finite" FRAMES=36 GAP=400 node tools/shot-water-break.mjs tmp/out`.

## In the water or not; the underwater screen (2026-11-11)

Players: "under water the screen often looks as if I were above it". Two causes, both fixed:

- **What counts as water follows what is drawn** (`voxelBody.waterBodyAt` ↔ `body.rs`): every
  water cell, except a SHEET of falling water (`fallIsSheet`: open air on one side and a block on
  another, or continuing such a cell above it — the curtain on a block's face and below it). A
  sheet is a third of its cell: counted as a cell, the robot swam and the screen went under in open
  air beside it. A lone column, a wide fall and the inside of deep water (a wide pond's cells under
  its surface ARE falling water) are swum in. (A first version excluded every falling cell with air
  beside it — and deep ponds read as "not water"; never deployed.)
- **The screen is split at the waterline** (`CraftGame.updateUnderwater`): `waterDepthAt` is the
  eye's depth under the DRAWN surface (the top water cell's height), not "is the eye in a water
  cell". The row where that surface crosses the near plane splits the screen; the wash covers what
  is below it (stronger while split: the fog cannot be split), and fog (12 m, was 18) and the
  muffle follow the larger half with a band between. This is the known cell-versus-surface
  mismatch (Minecraft MC-135839) solved the way ocean renderers do it (signed height of the camera
  over the surface).

Not solved here, and the reason for `docs/WATER_DESIGN_KO.md`: a space ENCLOSED by sheets is air
and looks like air from inside, and at the waterline the part below is washed but not fogged. Both
need the scene's depth (a water pass that knows how much water each pixel looks through).

Also in classrooms: while a seating exists the plot fences are walls to the flow
(`ClassRoom.plotWalls`), so one student's water never floods a neighbour's plot.
`node tools/shot-underwater.mjs [outdir]` checks deep water, the waterline, the bank and a sheet.

## The water pipeline: tint and murk by how much water a pixel looks through (2026-11-11)

Stages A and B of `docs/WATER_DESIGN_KO.md`, in `render/waterPipeline.ts`. On by default where
there is a mouse (`CraftGame`), `?water2=0` turns it off, `?water2=1` forces it on a touch device
(not measured there yet, so a phone keeps the plain path above).

The frame is built in four steps instead of one:

1. the scene WITHOUT the water → colour + depth (the water meshes sit on `WATER_LAYER` only);
2. the water's nearest FRONT face and nearest BACK face → two depth textures (the water shader's
   `front` / `back` passes, drawn with `scene.overrideMaterial`; fragments behind the scene discard);
3. one full-screen composite: per pixel, the length of water the ray passes through, and from it
   Beer–Lambert tint and murk (`uAbsorb` per metre: red goes first). A ray starts IN water when the
   back face comes first — or, with no water surface in sight, when the pixel is below the
   waterline row the game computes from the eye's depth (`WaterPipeline.waterline`);
4. the surface on top (`surface` pass): a thin veil of its own colour, the sky it mirrors, glints,
   foam — nearest layer only, fading out where the water behind it is under 14 cm (no hard line
   at a bank). Real water this clear would be invisible a hand deep; the veil is what keeps a
   stream readable.

What that buys: deep water is dark and blue and shallow water clear, from the same rule; under
water every pixel is fogged by its own distance (red bricks go dark first); at the surface the
screen splits per pixel; a space enclosed by sheets is air and the sheets round it are water, as
they are. The DOM wash and the fog switch of the plain path are not used.

Rules that keep it working:
- **A pass must not sample a texture it is drawn into** (a feedback loop; the draw is dropped).
  Only `surface` reads all three textures, on the canvas; `front`/`back` read the scene's depth;
  every other water material gets empty samplers (`makeWaterMaterial`).
- **The shadow map is frozen after step 1** (it ignores camera layers and would be rebuilt three
  more times), like the ink pass.
- **Warm-up**: `GameRenderer.compileTargets()` is the pipeline's scene target alone (scene
  materials never draw to the canvas there), and the warm quad is a water mesh on `WATER_LAYER`
  so the boot frames draw it through `front`/`back`/`surface`. Measured: 39 programs at boot
  (35 on the plain path), none added by the first water, no GL errors.
- The closed-surface assumption: front and back faces bound real volumes because the mesh has
  faces toward air only. A pool has none against its floor: there the scene's depth ends the water.

Not in it yet: refraction, caustics, foam from thickness (stage C); the Android app (stage G).
Cost: headless frame times were the same with it on and off (both at the 60 fps cap, so that says
little); boot took 0.5‒1.6 s longer in two samples. `tools/shot-underwater.mjs` and
`tools/shot-water-flow.mjs` run on either path (`QUERY="&water2=0"` for the plain one).

## Big ponds are standing water; water at a wall beside a pocket is water (2026-11-11)

Players: "under water, pressed into a wall's corner, it is not water — I am thrown down — and the
corner does not fill". In a pond past the old 256-cell basin limit the water under the sources was
columns of FALLING water, which does not spread sideways: every cavity under a ledge stayed air,
and the floor a shallow stream. The 256 limit is what keeps one bucket from flooding a walled yard
(or a student's plot) a cell deep, so it stays for a layer open to the sky; a layer with NO open
air over any of its cells — the inside of a pond, under its surface — may now be 4096 cells
(`BASIN_SUBMERGED`, 64 × 64; TS and Rust). Such a pond is retained water all the way down, cavities
included (`fluid.test.ts`). (Raising the one limit was tried first: every stream in a bounded
world turned into a lake, and the tests said so.) Beyond that size the old behaviour remains. And `fallIsSheet` (voxelBody ↔ body.rs) now asks what the
mesher asks — open air on ONE side with a block straight ACROSS from it — instead of "a block on a
side and air on a side", which called the water against a pond's wall a sheet whenever an air cell
lay next to it.

## Running water is a film on the face (2026-11-11, later)

A sheet used to reach 0.34 m from the face it ran down and was drawn as clear skin: a wall or a
hanging block looked as if it stood in a glass case with empty space inside. `SHEET` is now
0.09 m (`waterGeometry.ts` ↔ `water_mesh.rs`) and the curtain shading in `waterMesh.ts` shows the
water as rivulets running in a thin wet film (two scales of threads, lit only a little so it does
not go dark in a block's shadow). The in-water test is unchanged (`fallIsSheet`). Thresholds moved
with it: `water-slant.test.ts` 1.5 → 1.8 m², the longest edge in `water.test.ts` 2.1 → 2.3.
Scenes: `ONLY=over-wall,mid-fall,under-block,float node tools/shot-water-flow.mjs <dir>`.
Still open: where a film meets a whole cell of water (inside corners, the curtain under a hanging
block) the step is larger than before.

## A pond fills up to a block sunk in it (2026-11-11, later)

Standing water under a block that is itself in the water (water beside the block) is drawn full to
the block's underside (`covered` in `waterGeometry.ts` ↔ `water_mesh.rs`). At its open-air height
(0.875) an eighth of a cell stayed empty under every sunk block, with a square of surface in it —
from below, a pale plate under the block. NOT for a block lying ON the pond's surface (no water
beside it): that square is part of the surface, and without it the surface has a hole seen from
below. Running water keeps its height under a block. Scene: `ONLY=pond-block`.

## Holes found by random layouts (2026-11-11, `test/water-fuzz.test.ts`)

Water has no faces against blocks, so its surface is only closed where its rim lies ON a block.
60 random layouts (blocks scattered and hanging, an L-shaped wall, water on, beside and in the
corners of them) are meshed and every rim that is not on a block is counted. Three kinds of hole
came out, each fixed in `waterGeometry.ts` ↔ `water_mesh.rs`:

- **Low water under a block, beside full-height water** (a fall, deep water): the tall water has no
  face toward it, so between the low surface and the block's underside its side stood open — a slit
  under the block's edge. The low surface comes up to the block's lower edge there (the loop over
  `VERTICAL` before `deeplyInsideSolid`), and a saddle point between two such nodes stays up too.
- **A thin lip over a whole-cell fall** (the fall squeezed between two blocks, an inside corner):
  the fall's top was open beside the block. A lip is only as thin as the fall under it (`sheet`).
- Rims went from 24 layouts to 10, the worst from 14 m of edge to 3.2 m.

### Second round (2026-11-12): no open rim left

The layouts gained terraces of random height and a pond in a pit with blocks in it and a breach;
1500 of them were clean afterwards (the test keeps 120, and fails on ANY rim further than 10 cm
from a block — a rounded rim bulges that far). What was wrong, all in the node placement:

- **The pool's edge beside a sheet's foot.** A node is at once the foot of a thin sheet and the
  corner of the pool's surface against a block. Contacts are now three kinds: the cell's own
  (`constraints`), the water's under what comes down (`below`), the pool's beside it, open to the
  air (`pool`). The foot leans to the block (averaged, the pool's edge stood half a cell off it,
  with a strip of surface missing) — except where the foot's own cell touches that block on the
  other axis: then the foot is on the block's face already and stays at the sheet, clamped to the
  block's extent.
- **A sheet turned a corner into a block** (`turnsCorner` when the cell round the corner is solid):
  the node went 9 cm into it, was thrown back to a face centre and drew stray triangles.
- **Whole water over a thin fall, under a hanging block** (`ledge`): the node held on that block's
  face lay a hand's width under its lower edge. It is put on the edge.
- **A sheet over a whole fall in mid-air** (`widens`): the sheet widens to the whole cell at its
  foot; kept thin, the whole cell's top stood open and its side was cut off slantwise. And a FALL
  no longer counts water beside it as a face to lie on (only a lip does) — it comes from above.
- **A block sunk in a pond, beside the open surface**: that surface comes up the last eighth to the
  block's edge (the second `VERTICAL` loop), or a slit stayed under the edge.
- **Saddle points**: between two nodes held on the same wall the edge runs straight along the wall,
  and in a sheet's cell the point is measured on the SHEET, not the whole cell — a quarter of a
  cell outside a 9 cm sheet it was the dark pointed fin under a hanging block's corner.

Big tilted panels in the hanging-blocks scene (`water-slant.test.ts`) went 1.73 → 1.27 m² with it.
`tools/e2e-water.mjs` waits for the mesh worker to exist before checking it (it is made with the
first batch; right after a reload the queue is empty before that — the check failed one run in two).

## Rivulets on a sheet, and the cost of dozens of springs (2026-11-12)

**White zigzags on running water.** The rivulets' place along the face was taken from the vertex
normal, which is smoothed and so differs corner to corner: the coordinate bent inside every
triangle and the streaks came out as chevrons, like feathers (seen close to a wall). It is now
`x + z` of the world position — the same on every face and across every edge — and the streaks are
a little fainter (`waterMesh.ts`, the `curtain` branch).

**Dozens of springs.** `SCENE=many N=40|150 GPU=1 CAP=1 node tools/perf-water.mjs` pours springs
one after another on open ground (every third on a pillar) and measures while they spread, at the
screen's rate on the real GPU (Intel Arc, 1920×1080×1.5):

| springs | water cells | pipeline: median / worst frame | plain: median / worst |
| --- | --- | --- | --- |
| 40 | 3 694 | 16.6 / 39.8 ms | 16.6 / 34 ms |
| 150 | 4 456 | 16.6 / 37.3 ms | 16.8 / 70.6 ms |

A generation costs the main thread ~1.2 ms to hand over and ~0.8 ms to install
(`waterStats().cost`), the worker 2–8 ms to mesh; the simulation is under 0.3 ms a frame. The one
frame over 16 ms is the first generation (14–19 ms) and the autosave (7–11 ms) while water moves.
Without `CAP=1` the frame rate is uncapped: a scene the GPU cannot draw at 300 fps then stalls in
bursts of 0.1–1.2 s inside `render` — an artefact of the measurement, not of the game.

## Close up: rivulets, grey slabs, springs on a face (2026-11-12, later)

Seen from a metre away (`FIRST=1 ONLY=tree,sides node tools/shot-water-flow.mjs <dir>`: first
person, views p/q/r):

- **Rivulets on a LEANING face** bent into chevrons again (`x + z` changes with height where a
  sheet widens at its foot). The fragment's flat normal (`dFdx/dFdy`) now picks the horizontal axis
  the streaks are laid along. (`flat` is a reserved word in GLSL ES 3: a variable of that name
  fails the compile and the water is simply not drawn — no error reaches the page.)
- **Running water is a film whichever way its face points** (`vFlow.y > 0.3`): only its upright
  faces were, and the slanted and level ones beside them got a pond's surface — in a block's shadow
  an opaque grey slab against the wall. The pipeline's surface veil also grows with the water
  behind it (0.22 → 0.3) and is never darker than a floor colour. (At 0.07 a stream on grass
  disappeared: checked on the real GPU.)
- **A spring hanging in the air against a face** (`sheet()`: `loose` includes the source) is where
  the film on that face starts. As a whole cell it tapered into the film over a metre — a funnel
  round a pillar with springs on its four faces. `water_mesh.rs` too. The body rule
  (`waterBodyAt`) still counts that cell as water: one cell, up on a wall. Scenes `sides`,
  `wall-sides`.

## Falls in the open, lips, and a way to SEE the shape (2026-11-12, night)

- **`?waterdebug=1`** draws the water's shape in flat colours (`uWaterDebug` in `waterMesh.ts`):
  level faces blue, upright faces green, tilted panels red→orange, each triangle lit by its own
  flat normal. A box, a step or a fin that the transparent shading hides is plain to see; use it
  with `QUERY="&waterdebug=1" node tools/shot-water-flow.mjs <dir>`.
- **A fall in the open is `FALL` (0.3) either side of its cell's middle** — a stream 0.6 m wide,
  not a cell-sized glass box (`freeFall`: nothing but air or more of the fall beside it; next to a
  block or lying water the cell keeps its width, its side has to meet theirs). Body rule unchanged.
- **A lip stands `LIP` (0.2) high**, not a stream's 0.56: water that landed on a block lay on it
  as a slab half a metre thick with square corners. Big tilted panels in the hanging-blocks scene:
  1.55 → 0.94 m².
- Level faces of running film take their pattern from the ground plan (laid along height, the
  streaks were level bands).
- Left: one rim in the 120 fuzz layouts (seed 46, 17 cm, where a narrow fall meets a full-width one
  beside a block; `FUZZ_SEEDS=46` prints it), the spring's own cube on top of a block, and the
  square cage of four curtains under every hanging block — that one is the simulation's shape
  (water goes down all four sides), not the mesher's.
Scenes added: `tree`, `sides`, `wall-sides`, `high`, `scatter`; `FIRST=1` shoots in first person.

## Redesign, stage 1: water in the air is drawn apart from the cells (2026-11-12)

The owner's call: no more patching the lattice round blocks — running water must read as liquid.
`drawWaterAsStreams(true)` (the game sets it; `?falls=0` turns it off; **web only so far**):

- **Loose water** (`loose`): a falling cell, a flowing cell or a spring with air or falling water
  under it, and a fall over water it drops into. It is NOT in the lattice any more (`lat` hands the
  lattice air there). A fall that has landed on a block stays in the lattice as lying water — a
  puddle (level 7) where it runs straight off again, a stream's depth among other lying water —
  and a spring whose water all runs off (on a pillar's top) is a low mound, not a cube.
- **Each loose cell is a loft between two level outlines** (`outline`, `ring`, `band`, `cap`):
  against a wall beside it a film as wide as the cell (1–7 cm from the face); once the wall has
  ended a stream 0.48 m wide, 10–36 cm from that face's plane — a curtain as wide as the cell only
  where the same fall goes on beside it; with no face at all a 0.6 m column. The outline at a
  cell's top is the cell above's, so stacked cells join without a seam. A lip starts at the height
  of the lying water behind it and rounds over the edge; a spring in the air has a rounded head;
  a fall into water goes on 0.9 m under its surface, foaming where it enters.
- Tests and the parity test run with it OFF (the module default): `water_mesh.rs` has no streams
  yet, so **the native app still draws the lattice falls** — port `loose`/`lat`/`streams` next,
  then flip the default and move the fuzz to the new shapes.
- Not done: films do not join round a block's corner (each face is its own panel), outlines are
  rectangles (a stream should be round), the body rule still counts every loose cell as water to
  swim in, and nothing checks the new shapes for holes yet.

## Stage 2: round streams, and ONE mesher — Rust (2026-11-12, later)

**Shapes** (`draw_streams` in `water_mesh.rs`). An outline is a
rectangle with a roundness per corner (`against`, `point`: a rounded corner sits on its arc):

- a fall in the open is a round column (0.6 m) and STAYS one past a block beside it;
- **water coming down keeps the face it came down** (`origin`: the direction of the cell above —
  on the wall while there is one, a curtain after). Picking a face anew in every cell twisted the
  water from one block's face over to its neighbour's (big tilted panels between them);
- **a film that has left its wall falls on as it was** — a curtain as wide and as thin as the film.
  Drawn together into a narrow stream it made a funnel of tilted triangles under every block;
- a **lip is the lying water bending over the edge**: it starts `LIP_BACK` (0.25) behind the edge,
  inside that water, at `LIP_TOP` (0.6) of its height, and ends as the film it becomes (`LIP_FAR`
  0.11). Its two ends take the height they share with the lip beside them (`tilted`): as a plate
  standing on the edge at each cell's own height, a wall's top was a row of battlements;
- **films join round a block's corner** (`wraps`: the block's next face has a film too and the cell
  between is open — each goes on past the corner by its own thickness, rounded; under the block the
  curtains do the same);
- a spring in the air has a domed head (three rings, normals tilted up), not a pointed crystal.

**Shading** (`waterMesh.ts`, the pipeline's surface pass): the owner saw "wind curtains" — white
gauze sheets hanging off every block — and milky slabs lying on blocks. Both were thresholds on
the distance to the SCENE behind the water, not on the water: (1) a sheet counted as a fall in the
open (white, nearly opaque) when the scene was far behind it, which every thin sheet in the air
is — it now goes by the water's own thickness (`waterThick`: front face to the nearest back face),
and a sheet in the air is blue and see-through with faint streaks (`free`); (2) the froth where
water meets something was within 13 cm of the scene, which a puddle a hand deep is everywhere —
the band now narrows with the water's depth (`aDepth`). Look at shapes with `?waterdebug=1`.

`test/water-streams.test.ts`: on 90 random layouts every run of loose cells is a closed tube
(welded by position, no edge of the stream part belongs to an odd number of triangles).

**One mesher: Rust, and no TypeScript one.** The owner's call (2026-11-12): two implementations
kept in step by hand doubled every water change, so `waterGeometry.ts` is gone and the surface is
meshed by `engine/crates/core/src/water_mesh.rs` everywhere. A change to the water's shape is a
change to that file, then `pnpm engine:build` (cargo is in `~/.cargo/bin`).

- **Web:** the water worker (`craft/waterWorker.ts`) loads the engine and meshes through
  `WaterMesher` (`engine/crates/wasm`: one snapshot per generation, `chunk(x, z, minY, maxY)` per
  job). `craft/waterMesher.ts` is the glue: the engine's flat array as a three.js geometry
  (`resultFromRust`, `buildWaterGeometry` for one thread), the switches (`drawWaterAsStreams`,
  `drawWaterFinite`) and the morph between generations (`prepareWaterTransition`).
- **No worker, or its engine failed:** the view loads the engine on the main thread
  (`loadWaterEngine`) and meshes there within the frame budget; until it has loaded, the water
  waits. If the browser cannot run WASM at all there is no water surface (the simulation runs on).
- **Finite water** (`?water=finite`): the by-amount heights are in Rust (`body::draw_water_by_amount`,
  a module-wide switch like the TypeScript one; the worker sets it per generation).
- **Tests** run on the committed WASM build: `test/setup-water-engine.ts` (a vitest setup file)
  starts it, so `water.test.ts`, `water-slant`, `water-fuzz`, `water-streams` and `water-view`
  judge the Rust mesher. The parity test (`rust-water-mesh.test.ts`) went with the TypeScript.
- The worker is an ES-module worker (`worker.format: "es"` in vite.config.ts): it code-splits the
  engine. `pnpm build && node tools/probe-water-worker.mjs` runs the BUILT worker chunk on the
  single-port server (a mesh comes back, the .wasm is 200 application/wasm).
- Default play now fetches the .wasm (324 KB) with the first water mesh: a post-deploy check that
  expects "no wasm in default play" is out of date.
- The Android app still draws the lattice falls (`client/src/water.rs` calls `build_water_mesh`):
  it hands shaped blocks' water over without a profile, and `loose` needs the profile to leave
  that water in its block. Give it the profile, then switch it to `build_water_mesh_streams`.

**Strands, no lip, no diagonal joins** (2026-11-12, from the owner's screenshots: water "cut off",
"not connected", "overlapping" seen from above and in inside corners). Three causes, all in
`water_mesh.rs`:

- **The lattice joined water on a block to water one block DOWN beside it** (`build_cube`, a cube
  face with two wet cells corner to corner, one solid, one air: "one sheet round a block's
  corner"). That rule was for sheets in the lattice; with the films drawn apart it made a big
  slanted pane over the block's edge and a wedge at every step of a cascade. Off when `streams`.
- **A cell's water ran on ONE face** (`origin`). Now `strands`: a bit per face — where it starts,
  a strand over EVERY edge with lying water behind it, or failing that a film on EVERY wall beside
  it; coming down it keeps the cell above's faces (wall → film, no wall → curtain; a column stays
  a column). An inside corner used to get one wet wall, the others dry, and the films either side
  of it stopped there. Each strand is its own closed tube (`draw_strand`).
- **The lip was a second pane inside the lying water** (it started 25 cm back, at 60 % of that
  water's height, and showed through the surface from above with straight edges where the two
  crossed). There is no lip any more: the lattice's rounded rim IS the water bending over the
  edge, and the strand begins as a collar (`LIP_BACK` 3 cm back over the edge, `LIP_TOP` 4.5 cm up)
  tucked under it.

And in the shader: the surface faded out where the water behind it was under 14 cm, which water a
hand deep on a block is in patches with straight edges; 5 cm now. Scenes: `ONLY=notch,steps`;
`ORBIT=1` shoots a scene from eight directions. Running water keeps its Minecraft-like depth —
thick by its spring, thin at its end (the owner's answer when asked).

Still open in the shapes: films in an INSIDE corner (the cell picks one wall), four separate
streams under a hanging block (the simulation's shape), the body rule (every loose cell is still
water to swim in).

## The simple water — the default (2026-11-12, evening)

The owner, after a day of films, lips, curtains and collars each fixing one screenshot and breaking
the next: "it keeps getting stranger — simple, like Minecraft, water that runs down." So the game
draws `build_simple` (`water_mesh.rs`, the end of the file):

- every water cell is a box; its top stands at the cell's level (`water_height`: 0.875 standing,
  0.56 → 0.10 running, thick by the spring and thin at the end);
- the four corners of the top are SHARED with the cells round them (`corner_height`: the average
  of the water cells at that corner, full where any of them has water over it), so the surface
  runs on from cell to cell as one slope with no cracks;
- falling water and water under water are whole cells;
- a side is drawn toward air, the bottom over air, nothing against a block or more water.

No surface net, no sheets, films, lips, curtains or strands. `?watershape=net` draws those instead
(everything above this section), kept for comparison until the owner has seen the simple water in
play; `test/setup-water-engine.ts` turns the net on for the older tests, `test/water-simple.test.ts`
judges the simple one (no cracks, falls away from the spring, faces outward, whole cells in a fall).
The switch is module-wide in the engine (`draw_water_simple`, default ON — the Android app draws
the simple water too). If the owner keeps it, delete the net: `build_cube` … `draw_strand`, the
`streams` flag, and the tests that judge them.

**Its shading** (`uWaterSimple` in `waterMesh.ts`, the pipeline's surface pass only; the plain path
of touch devices is unchanged): blue by how much water there is (`waterThick`: light and clear when
shallow, deep blue when deep), the sky at a glancing angle, light lines running with the flow,
froth where it meets something; a fall is white water streaking down over blue. Written here in
the usual stylised-water way, not taken from another project. Frame cost on the real GPU, uncapped,
1920×1080, a 20×20 pond with six falls: 5.3 ms before, 4.5 ms after (median; run-to-run noise is
of that order — read it as "not slower").

## A closed volume: the eye-in-water question is counted, and what keeps it closed (2026-11-12, night)

From the owner's screenshots, in the order they came. The thread through all of it: stop adding
case rules, find the invariant, pin it with a test.

**Is the eye in water?** was a level row at the eye, then a line through the near plane's four
corners, then a 16×9 grid — each wrong somewhere (a sloping surface beside a fall, water touching
one corner of the view, slivers along the line). It is COUNTED now: `build_simple` also emits the
water's faces against blocks (`WaterMesh::closure`, face codes 16+, `aWet` −1 — the shader clips
them out of every pass but `count`), so the water is a closed volume, and the pipeline's count
pass adds up, without depth, the faces each ray leaves the water by (red) and enters it by
(green). One more out than in: the ray starts in water. Only while the camera is at water
(`WaterPipeline.atWater`: any water in the 27 cells round it). The older net (open against blocks)
keeps the grid (`WaterPipeline.inside`), which is also what the muffle, the fog and the touch
path's wash follow. An eye in water sees through at least `uInsideMin` metres (inside a fall one
cell wide the screen read as air); a side seen from inside the water draws no veil.

**What keeps the volume closed** (`test/water-simple.test.ts`: every edge has an even number of
triangles, and every vertex at one place carries one swell):

- a vertex's swell is a function of its CORNER (its height), never of the cell. Per cell, the
  cells round a corner lifted it by different amounts: a hairline crack along every cell edge —
  lines on the water and, through the depth-less count pass, dotted lines over blocks in front;
- a spring's top is a fan over its corners (a point on an edge's middle swells by its own place);
  a standing cell level with everything round it is one quad (a 32×32 pond: 22.5k → 10k vertices);
- the count pass ignores the 0.18 s transition (corners shared by two faces part for a moment).

**Where the water meets blocks** (`tuck`, a function of the lattice point, so the volume stays
closed): a corner at a block reaches `TUCK` (7 cm) INTO it where water stands face to face with
it — bricks are drawn inside their cells, and water ending on the cell boundary left a slot at
every wall; only `TUCK_END` (3 cm) along a wall at its end (the whole way, the free side leaned
into the wall: a dent); and OUT round a block's corner with water on both sides and air past it
(drawn in, the two sides crossed inside the block and its edge stood out dry: a bright line down
every pillar). A spring keeps its corners on a wall it is set against.

**Where water of two heights meets**: a LIP — running water with a fall under it — runs down to
its cell's floor at the corners only lips share, and at the corner two lips turn round at open
air (`corner_height`). Standing at its own height it was a slab hung over the edge: an upright
step all round a platform and a pane at each corner. A top folds along the diagonal whose ends
stand most alike. `voxelBody.waterDepthAt` repeats the corner rules (`cornerHeight`): change both.

**Flow** (`fluid.ts` `nextState` = `fluid.rs`): a dry cell with running water on two OPPOSITE
sides over a floor joins them as the weakest water. Two springs a cell too far apart left a dry
line of steps between them. A stream's own slanting edge has its water on adjacent sides, so one
spring still ends at seven cells (113 cells), and the joined cell feeds nothing and dries a step
after either side does (`test/fluid.test.ts`).

**Look**: the sky's reflection on the simple water is faint (0.28): from up high at a slant it
was a white glare that broke off wherever the slope changed.

Checked with: `tools/shot-water-inside.mjs` (the camera in water, the eye through a sloping
surface, sideways into a fall), `shot-water-wall.mjs`, `shot-water-meet.mjs` (`STEP=1`: a platform),
`soak-water.mjs` (no leak over 24 pour/drain rounds), `e2e-class-water.mjs` with
`apps/server/test/classroom-water-tools.test.ts` (the teacher's tools: both screens hold and draw
exactly the server's water). Not reproduced: "in teacher mode the water stops and only the middle
sticks up" — the rules, the messages and the drawn cells all agree through that sequence.

## One water: the surface net is gone (2026-11-13)

At the owner's word the older water — the surface net on the voxel-centre lattice with its sheets,
films, lips, curtains and streams, everything above from "Running water: sheets, films…" to
"Stage 2" — was deleted: `water_mesh.rs` went from 1502 lines to 374 and the committed WASM from
328 KB to 246 KB. Those sections stay as the record of why the simple water is what it is; the
code is in git history. Gone with it: `?watershape=net`, `?falls=0`, `drawWaterAsStreams`,
`drawWaterSimple`, the shape profile handed to the mesher, the pipeline's measured fallback
(`tInside`), the old surface look in the shader, and the tests that judged the net
(`water-streams`, `water-slant`, the lattice half of `water.test.ts`). The plain path (touch
devices) keeps its own shading of the same mesh. Do not bring a second shape back behind a flag.
