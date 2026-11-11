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
of at most 256 cells per layer can retain water; a lower outlet drains it again.
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
