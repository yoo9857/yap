# CraftYap engine (Rust) — the transition

**Goal:** one engine for the web, the Android/iOS apps, PC (Windows/macOS) and the server,
optimized for each. One codebase avoids Minecraft's split (Java Edition + a C++ rewrite, Bedrock,
maintained apart ever since). The current TypeScript game keeps running and shipping while
the engine grows beside it. Each part is swapped in only once it is proven identical and faster.

```
            ┌──────────── engine/crates/core (Rust) ─────────────┐
            │ voxel world · water · physics · meshing · class rules │
            └──────┬──────────────────┬───────────────────┬────────┘
     WASM in the browser      native in the apps       native on the server
     (crates/wasm)            (later: crates/client,   (later: replaces the
                               wgpu → Vulkan/Metal)     TypeScript rules)
```

## Rules for the transition

1. **TypeScript stays the reference until a part is switched.** A Rust port is a line-for-line
   translation of the TS module it replaces, with the TS file named at its top. Change both
   together, never one.
2. **Every port ships with a parity test** in `packages/shared/test/rust-*.test.ts`. It runs
   randomized worlds through both versions and requires the SAME output in the SAME order,
   step by step, not merely similar output. These tests skip when the WASM package isn't built,
   so the existing CI and deploy never depend on Rust.
3. **Every port ships with a benchmark** on identical worlds (`pnpm engine:bench`). It is
   switched in only if it is clearly faster where it runs: in the browser through WASM,
   including the cost of crossing between JS and WASM.
4. **The world lives on the Rust side.** A Rust simulation calling back into JavaScript for each
   cell costs more than it saves. JS hands over cells and receives changes in bulk.
5. **Persisted formats do not change in a port.** Block ids, water ids (19–28), shape codes and
   save/wire tuples stay as they are. A port changes how something is computed, never what is
   stored.
6. Switching a part in: behind a flag first (a dev query parameter); E2E suites green with it on;
   then default on; the TS module is removed only after a release with no regressions.

## Roadmap

| Stage | Content | Status |
|---|---|---|
| 0 | Mobile with the current engine: touch controls, quality presets (low/medium/high/auto), Capacitor app | planned |
| 1a | Rust workspace, toolchain, CI, **water simulation** + parity + benchmark | **done** (not switched in) |
| 1b | The game's voxel window mirrored in Rust (`grid.rs`: cells, shapes, wet layer, field ring, furniture) | **done** |
| 1c | Water switched in behind `?engine=rust` (solo field and island) | **done (flag)** → default after a release |
| 1c' | Classroom server water on the Rust core (`field.rs`, WASM in Node) behind `FLUID_ENGINE=rust` | **done (flag)** |
| 1c'' | Make Rust the default on both sides after a release with no regressions | next |
| 1d | Chunk meshing in Rust. **1d-1 (flag):** the joined brick shells (`kit.rs` + `earcut.rs`), bit-identical. **1d-2 (everyone, TS):** far → near flips built in budgeted steps. **1d-3 (flag):** the chunk scan (`scan.rs`): near lists, seam backing, far merged faces and baked shapes, studs, water cells. Next: a worker | **1d-1…3 done** |
| 1e | Voxel body physics (AABB sweeps, step-up), raycast | |
| 1e | **The water surface is Rust only** (`water_mesh.rs` through `WaterMesher`, in the web's water worker; the app uses the same code). The TypeScript mesher `waterGeometry.ts` was DELETED 2026-11-12 (owner: one implementation, no twins) — docs/WATER.md, "Stage 2"; the surface net it ported was deleted 2026-11-13 (one water: a box per cell) | **done** |
| 2 | Native client: wgpu renderer (Vulkan / Metal / DirectX / WebGPU) on the same core. **The Android app ships on it (no WebView), decided 2026-11-05.** Milestones N0–N6 in `docs/ANDROID.md` | **N0–N1 done**: Android + desktop shell, lifecycle, recovery, quality presets |
| 3 | (decide later) user-made games: scripting (Lua/Luau) over the engine's data | |

## How the game uses it (stage 1c)

- **One package for every JS host: `@robo/engine`** (`packages/engine`).
  - `wasm/` is the single committed build (`--target web`), with a SOURCE_HASH of the Rust it came from.
  - `src/browser.ts` fetches and starts it.
  - `src/node.ts` starts it synchronously from the file: `../wasm/` from source, or
    `dist/engine-wasm/` in the bundled server, which tsup copies there. The Docker image ships
    `dist/` whole. The bundle imports nothing new at runtime; the runtime stage still installs only
    its 4 packages.
  - The tests load this same build, so what is tested is what ships, and they run in the normal CI
    without Rust.
- `?engine=rust` (solo field/island): `main.ts` loads it via `apps/client/src/engine/rustEngine.ts`
  (a ~20 KB gzipped wasm in its own chunk; nobody else downloads it). If it fails to load, the game
  plays on the TypeScript rules (same water), with a console warning.
- `WaterSim` keeps the scheduling (step timer, waking saved water, scroll handling) and runs the
  rules in a backend: `TsWaterBackend` (reference) or `RustWaterBackend`.
- The Rust mirror is kept in step by these updates:
  - `load` of the whole window on start and every field scroll;
  - `VoxelWorld.onWrite` for each cell the game writes;
  - the field's banked ring right outside the window (the only cells beyond it that the rules read);
  - solid furniture, re-sent whenever the layout's `version` moves;
  - the shape-seal table (`SHAPE_SEALS`, from TypeScript, so both sides use the same geometry).
- Changes come back as one `Int32Array` and are written into the TS world.
- A wasm trap mid-game switches that game to `TsWaterBackend`: nothing of the failed step was written, the mirror hook is removed, and every water cell is woken again (`test/rust-water.test.ts`).
- A class unloaded from the server frees its Rust water at once (`ClassRoom.dispose`), not whenever the finalizer runs.
- Out-of-window writes are REFUSED by both backends. They used to count as a change and re-queue
  themselves every step, so banked water by the window edge kept the simulation busy forever.
- `apps/client/test/rust-water.test.ts` runs the real `WaterSim` on both backends over the real
  world. It covers a pool, shaped blocks, furniture, edits mid-flow and two field scrolls, and
  compares the whole world after every tick. A one-cell furniture difference makes it fail; that
  was checked.

- `FLUID_ENGINE=rust` (server: every class and party field; also per shard in cluster mode;
  `docker-compose.yml` passes `FLUID_ENGINE` from `.env`, default `ts`).
  - `ClassManager` decides once at boot and logs "class water runs on the Rust engine".
  - `ClassRoom` mirrors its `edits`/`wet`/furniture into `FieldWorld` and writes Rust's changes back
    through `writeEdit`, so saving, streaming and broadcasting are untouched.
  - Mirror points: the save restore (`write_many`), `writeEdit` (`write`/`erase`), the field reset,
    and furniture. Furniture is compared by layout object AND version, because ClassRoom replaces
    its layout object on every change.
  - A full store is refused by Rust and reported through `take_at_capacity`.
  - A trap drops that one class back to TypeScript (logged) with every water cell woken again.
- Both Rust steps honour the same soft time budget as `FluidSim.step(world, maxMs)`: the host's
  `performance.now`, checked every 8 cells. The server's per-room and shared budgets keep working.
- Shape seals are a precomputed table (`SHAPE_SEALS`). Measuring the geometry took 160 ms, which
  the first class on a server paid; `test/waterlog.test.ts` recomputes every entry.
- `apps/server/test/rust-class-water.test.ts` runs two rooms with identical traffic and requires
  identical s-k-edit/s-k-wet messages and saved fields. The traffic covers shaped blocks, a chair,
  mining a wet shape, reset, restore, a full 300,000-cell store and a trap. A chair placed on only
  one side fails 11 of 12 seeds; that was checked.
- Verified on the built server: single process, the Docker runtime stage replicated (dist + its 4
  packages), and `SHARDS=2`. A real socket opens a class, pours water by a round block, and receives
  the flow and the water inside the round.

## Brick shells (stage 1d-1)

The near form of a chunk draws each block's full cubes as ONE joined shell
(`kitCellsGeometry` in `apps/client/src/craft/kitShell.ts`: union outlines per layer, inset
sections with rounded corners, earcut caps). It was the most expensive part of building a chunk.
Measured in the browser on the island walking the same route: `buildNearMeshes` 665 ms over 70
chunks, the worst chunk 37 ms, against a 4 ms per-frame build budget.

- `engine/crates/core/src/kit.rs` is a line-for-line port. It includes the three.js steps the
  shell runs through: `computeVertexNormals` on a triangle soup, the planar UVs and
  `translate` (which normalizes the normals once more).
- `earcut.rs` is three's earcut 3.0.1, with V8's `Array.prototype.sort` (`js_sort`) and V8's
  `Math.hypot` (`js_hypot`). A different sort or hypot would change a triangle or the last bit
  of a vertex.
- `apps/client/src/craft/kitRust.ts` asks `joined` once per cell of the cells' box grown by one
  and hands it over as a mask. Rust never calls back into JS.
- `apps/client/test/rust-kit.test.ts` compares every float32 of the positions, normals, colours
  and UVs bit for bit. It covers 40 random blobs in a world of other solids, plus a single cell,
  a line, a ring and a hollow box. One extra joined cell on the Rust side makes it fail; that was
  checked.
- **In the game:** `?engine=rust` also builds the shells on Rust (`VoxelView.useRustShells`;
  `__roboCraft.engines()` shows which engine runs each part). A Rust error falls back to
  TypeScript for that view.
  - The island renders pixel-identical: 0 differing pixels outside the animated pet.
  - E2E with the flag: holes (681,885 faces), craft, field, furniture and pet all pass.

| | TypeScript | Rust |
|---|---|---|
| `buildNearMeshes`, island route (browser) | 665 ms (worst chunk 37 ms) | 139 ms (worst 11 ms) |
| whole chunk builds, same route | 749 ms | 229 ms |
| shells, 30 terrain chunks (Node, `pnpm engine:bench`) | 85 ms/chunk | 9.4 ms/chunk |

## Staged near builds (stage 1d-2, every player)

Walking turns far chunks near. The near form of a chunk was built in one go, so a single chunk
could take a whole frame: up to 37 ms, against a 4 ms per-frame build budget.

An unchanged chunk that still shows its far form is now scanned once, then built one mesh (one
block × shape) at a time while the frame budget lasts (`startStaging` / `stepStaging`). The far
form stays drawn until every near mesh is ready, then the two swap in one frame.

- A staged build is thrown away (`dropStaging`) when:
  - the chunk is edited (`invalidate`; edits stay synchronous),
  - the field scrolls (staged cells are grid coordinates),
  - the whole view is rebuilt or disposed,
  - the player walks away again before it is ready.
- Builds from the queue come first. The queue refills only when the focus moves, so staging always
  gets its turn.
- `chunkStats()` reports `staged`. E2E holes, craft, field, furniture and pet pass on both engines.

## The chunk scan (stage 1d-3)

`engine/crates/core/src/scan.rs` ports `VoxelView.scanChunk` line for line.

- **Input:** a SLAB, the chunk plus a one-cell ring at every height. It holds:
  - the raw blocks as `world.get` sees them, including the field's ground beyond the window;
  - the shapes, which are 0 beyond the window;
  - the hidden flags of the cell being mined and the falling cells.
  - Rows inside the window are copied whole. The first version called `world.get` per cell, which
    made empty chunks 5× slower than TypeScript.
- **Fixed tables:** the view's tables are handed over once (`WasmScanner`): block flags,
  materials per face band, the face tables, the five far templates and every shape's orientation
  quaternion. `applyQuaternion` is three's formula.
- **Output:** what the meshes are built from, in JS `Map` insertion order. That covers the near
  lists, the seam backing, the far buffers (a buffer is created before its face is culled, as
  `farBuffer()` does), studs, water cells and the top.
- `apps/client/test/rust-scan.test.ts` renders random worlds twice, on TypeScript and on Rust,
  and requires every mesh of every chunk to be equal. That covers near and far forms, shells,
  instance matrices, backing, far attributes and groups, and studs.
  - The worlds mix every shape family, glass, grass under blocks, water, hidden cells and the
    field edge.
  - It asserts the Rust scan really ran. A 0.25 change in one backing coordinate makes it fail;
    that was checked.

| | TypeScript | Rust |
|---|---|---|
| chunk scan, island, per chunk (Node, `pnpm engine:bench`) | 2.31 ms | 0.50 ms |

## Layout

```
engine/
  Cargo.toml            workspace (release: LTO, 1 codegen unit, panic=abort)
  crates/core/          pure simulation, no I/O, no platform code (fluid.rs …)
  crates/wasm/          wasm-bindgen bindings: WasmFluid (parity), WasmWater (game window), WasmClassWater (classroom), kit_cells_geometry (brick shells)
  target/               build output (git-ignored)
packages/engine/               @robo/engine: wasm/ (committed build + SOURCE_HASH), src/browser.ts, src/node.ts
engine/crates/core/src/grid.rs    the game window mirror (client)
engine/crates/core/src/field.rs   a classroom's sparse field mirror (server)
engine/crates/core/src/kit.rs     brick shells (port of kitShell.ts); earcut.rs: three's earcut
engine/crates/core/src/scan.rs    the chunk scan (port of VoxelView.scanChunk)
engine/crates/core/src/world.rs   world storage + island generation (port of voxelWorld.ts)
engine/crates/core/src/surface.rs block surface families and maps (port of blockMaterials.ts)
engine/crates/core/src/blocks_gen.rs  GENERATED block catalog + shape codes (pnpm engine:catalog)
engine/rust-toolchain.toml        pinned compiler (1.99.1)
packages/shared/test/rust-parity.test.ts   Rust = TS, randomized, step by step
apps/client/test/rust-water.test.ts        the game's WaterSim on Rust = on TS, tick by tick
apps/server/test/rust-class-water.test.ts  a class's water on Rust = on TS, message by message
apps/client/test/rust-kit.test.ts          brick shells on Rust = kitShell.ts, bit for bit (rust-kit-bench: speed)
apps/client/test/rust-scan.test.ts         the chunk scan on Rust = scanChunk (whole views, every mesh)
apps/client/test/rust-world.test.ts        generateIsland on Rust, every cell
apps/client/test/rust-surface.test.ts      surface families + createMaterialMaps on Rust, every byte
packages/shared/test/rust-bench.test.ts    speed on identical worlds (RUST_BENCH=1)
.github/workflows/engine.yml               cargo test + clippy + wasm build + parity + bench
```

## Commands

```bash
pnpm engine:build   # wasm-pack → packages/engine/wasm (committed; browser, server and tests)
pnpm engine:check   # the committed web wasm matches the Rust sources (CI)
pnpm engine:test    # cargo test + the parity test
pnpm engine:bench   # TS vs Rust speed
cd engine && cargo clippy --all-targets -- -D warnings
```

Compiler pinned in `engine/rust-toolchain.toml` (1.99.1). Toolchain on Windows: Visual Studio 2022 Build Tools (C++ workload, the MSVC linker), rustup
(stable, `rustup target add wasm32-unknown-unknown`), `cargo install wasm-pack --locked`.

## Measurements

Water simulation, Node 24 + WASM, identical worlds, 2026-11-04. Changes are identical in every scene.

| Scene | TypeScript | Rust (WASM) | |
|---|---|---|---|
| walled pool 48×48, 3 deep | 14 ms | 2 ms | 5.9× |
| 120 separate streams | 255 ms | 36 ms | 7.1× |
| waterfall terraces | 66 ms | 10 ms | 6.3× |

In the game (browser, `tools/stress-water.mjs`, 200,000 water cells with furniture collision,
`EXTRA_QUERY=&engine=rust`):

| | TypeScript | Rust |
|---|---|---|
| update p95 | 3.0 ms | 1.1 ms |
| worst update | 13.9 ms | 6.8 ms |
| updates until settled | 901 | 586 |

TypeScript is held to its 3 ms step budget, so it needs more ticks to settle. Rust does the same
work in about a third fewer ticks.

Classroom server (`tools/stress-water-server.mjs [--raw] [--rust]`, 50,000 sources):

| | TypeScript | Rust |
|---|---|---|
| same work (4096 cells/step), median step | 25.1 ms | 5.0 ms (identical changes) |
| production budget (6 ms): changes in 24 steps | 2,412 | 13,883 |
| restoring the class | 86 ms | 35 ms |

The first build used Rust's default SipHash maps and was only 1.5–2.5× faster; FxHash
(`rustc-hash`) is what gets to 6–7×. These numbers use the sparse test world. Stage 1b (the real
grid) decides the in-game gain.
