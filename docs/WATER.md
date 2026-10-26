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
It does not assemble separate surface/lip/fall boxes. Each lattice cube separates
connected water **and outside** components, preventing diagonally touching streams
or separate air pockets from being joined into a non-manifold surface.

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

Fluid steps are 250 ms, at most 4096 pending cells per step. A closed, fed basin
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
