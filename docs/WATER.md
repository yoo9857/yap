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

## Status — work in progress (branch `water`, 2026-10-23)

Not merged to `main` and **not deployed**: a push to `main` auto-deploys, and
this changes the classroom protocol (v4), the save contents and the renderer.

Done and passing (`pnpm typecheck && pnpm lint && pnpm test`: 371 unit tests):
- shared fluid sim (`packages/shared/src/fluid.ts`) + tests, server-run flow in
  classrooms (`classRoom.stepFluids`, stepped by `ClassManager` every 250 ms) + tests;
- swimming/wading/climb-out (`voxelBody.ts`), water is "not air, not solid"
  (`SOLID_ID` in `blocks.ts`, `isReplaceable`, `raycast(..., fluids)`);
- hotbar slot `0` = endless water bucket: right click pours a source, left click
  scoops a source (flowing water says to scoop its source); underwater fog + tint,
  splash/pour sounds, water shader warmed up behind the loading screen;
- worker-built continuous surface (`waterGeometry.ts`, `waterWorker.ts`) with the
  main-thread fallback; water-only rebuilds (`markWaterDirty`) so a running stream
  never rebuilds its chunks' bricks.

Still to do before merging:
1. `tools/e2e-water.mjs` — real input (key 0, right/left click, Space), flow
   reaches 7 cells, scoop drains, swim up / climb out, underwater tint, reload
   keeps water, no new shader programs mid-game, two-browser classroom sync.
   (`__roboCraft.water()` exposes wet / underwater / cell counts for it.)
2. Re-run the other suites against water: e2e-craft, e2e-field, e2e-furniture,
   e2e-pet (the pet swims through the same `stepBody`), e2e-classroom,
   e2e-machines (rapier terrain ignores water: machines drive through it),
   e2e-battle, e2e-production; then `node tools/qa-water.mjs` and
   `node tools/bench-water.mjs`.
3. `CLASS_PROTOCOL_VERSION` is 4 but its doc comment still describes 3 — add the
   v4 line (water states on the wire). Deploying v4 makes every open classroom
   tab show "please refresh" (bad-version) — deploy outside class hours.
4. Rollback check: an older server must still load a class saved with water
   (ids 19–28 are accepted as 0–255 edits; an old client would not draw them).
5. Then the sea (island coast / field lake), which was deferred until the water
   physics was finished.
