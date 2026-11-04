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
| 1d | Chunk meshing (kit shells, far merged meshes) in Rust → WASM workers | |
| 1e | Voxel body physics (AABB sweeps, step-up), raycast | |
| 2 | Native client: wgpu renderer (Vulkan / Metal / DirectX / WebGPU) on the same core; the Android app moves from WebView to native | |
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

## Layout

```
engine/
  Cargo.toml            workspace (release: LTO, 1 codegen unit, panic=abort)
  crates/core/          pure simulation, no I/O, no platform code (fluid.rs …)
  crates/wasm/          wasm-bindgen bindings: WasmFluid (parity), WasmWater (game window), WasmClassWater (classroom)
  target/               build output (git-ignored)
packages/engine/               @robo/engine: wasm/ (committed build + SOURCE_HASH), src/browser.ts, src/node.ts
engine/crates/core/src/grid.rs    the game window mirror (client)
engine/crates/core/src/field.rs   a classroom's sparse field mirror (server)
engine/rust-toolchain.toml        pinned compiler (1.99.1)
packages/shared/test/rust-parity.test.ts   Rust = TS, randomized, step by step
apps/client/test/rust-water.test.ts        the game's WaterSim on Rust = on TS, tick by tick
apps/server/test/rust-class-water.test.ts  a class's water on Rust = on TS, message by message
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
