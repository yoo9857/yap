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
Classroom protocol 4 prevents clients without water support from interpreting
these IDs as solid, invisible blocks. Existing block/furniture saves remain valid.

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

Deployment snapshots the live SQLite database before rebuilding. After the image
is ready, `scripts/wait-idle.sh` checks established app connections inside the
container. If they remain active for two minutes it aborts without replacing the
running app. Initial, idle and active-connection paths are verified with mocks.
Refreshing an older classroom tab loads protocol 4 and the new water renderer.

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
