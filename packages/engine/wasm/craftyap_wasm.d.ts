/* tslint:disable */
/* eslint-disable */

/**
 * A classroom's water (the server): the Rust core over a mirror of the class's field. The server
 * mirrors every cell it writes (`write`/`erase`), resets, and furniture; it applies the changes
 * `step` returns to its own maps. Coordinates are absolute field cells.
 */
export class WasmClassWater {
    free(): void;
    [Symbol.dispose](): void;
    busy(): boolean;
    clear(): void;
    edit_count(): number;
    /**
     * The server dropped a cell back to the plain field.
     */
    erase(x: number, y: number, z: number): void;
    constructor(column: Uint8Array | number[], max_coord: number, max_y: number, max_edits: number, seal_table: Uint8Array | number[], budget: number);
    pending(): number;
    /**
     * Solid furniture cells: flat [x, y, z]*, replacing the previous set.
     */
    props(cells: Int32Array | number[]): void;
    reset(): void;
    /**
     * One step under a soft time budget (ms; Infinity = none), like fluid.ts; committed changes
     * flat as x, y, z, id.
     */
    step(max_ms: number): Int32Array;
    /**
     * Did the last steps meet a full store? (cleared by reading)
     */
    take_at_capacity(): boolean;
    touch(x: number, y: number, z: number): void;
    /**
     * The server stored a cell (block, shape).
     */
    write(x: number, y: number, z: number, block: number, shape: number): void;
    /**
     * Many cells at once (a restored class): flat [x, y, z, block, shape]*.
     */
    write_many(cells: Int32Array | number[]): void;
}

/**
 * A water simulation over its own sparse world (parity tests and benchmarks for now).
 */
export class WasmFluid {
    free(): void;
    [Symbol.dispose](): void;
    busy(): boolean;
    get(x: number, y: number, z: number): number;
    constructor(floor_y: number, max_y: number, half_size: number, floor_block: number, budget: number);
    pending(): number;
    /**
     * Place a block (0 = air). `shaped`: it holds water behind the `seal` faces.
     */
    put(x: number, y: number, z: number, block: number, shaped: boolean, seal: number): void;
    /**
     * Step until idle or `max_steps`, without crossing back into JS each step. Returns the number
     * of committed changes.
     */
    run(max_steps: number): number;
    /**
     * Write a cell the way the simulation does (water or air; a shaped cell's water layer).
     */
    set(x: number, y: number, z: number, id: number): void;
    /**
     * One step; the committed changes flattened as x, y, z, id.
     */
    step(): Int32Array;
    touch(x: number, y: number, z: number): void;
    water(x: number, y: number, z: number): number;
}

/**
 * The block renderer's chunk scan (`scan.rs`, a port of `VoxelView.scanChunk`). Built once per
 * view from its tables; `scan` runs per chunk on a slab (the chunk + a one-cell ring, every height).
 */
export class WasmScanner {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * A far-form template, in the order `family` indexes them.
     */
    add_template(pos: Float32Array | number[], nrm: Float32Array | number[], uv?: Float32Array | number[] | null): void;
    /**
     * Per block id (256 each): solid, see-through, def bits (1 exists, 2 noStud, 4 grass), material
     * count (0, 1 or 3) and 3 material slots; per shape code (256 each): full cube, far family;
     * `faces` 6 × (n, u, v, o); `corners` 6 × (u, v); `face_uv` 12; `quats` 256 × (x, y, z, w).
     */
    constructor(solid: Uint8Array | number[], see_through: Uint8Array | number[], def: Uint8Array | number[], mat_count: Uint8Array | number[], mats: Int32Array | number[], full_cube: Uint8Array | number[], family: Uint8Array | number[], dirt: number, kit_cube: number, round: number, faces: Float64Array | number[], corners: Float64Array | number[], face_uv: Float64Array | number[], backing_inset: number, quats: Float64Array | number[], world_y: number);
    /**
     * One chunk. Packed float32: [ok, top, nWater, water…, nStuds, (key, len, xyz…)…,
     * nNear, (key, len, xyz…)…, nBacking, backing…, nFar, (index, nVerts, pos…, nrm…, uv…)…].
     */
    scan(cells: Uint8Array | number[], shapes: Uint8Array | number[], hidden: Uint8Array | number[], sx0: number, sz0: number, sw: number, sd: number, x0: number, z0: number, x1: number, z1: number, far: boolean): Float32Array;
}

/**
 * The game's water on the mirrored voxel window (`Grid`): TypeScript keeps the window in step
 * (load on start/scroll, write per edited cell, the ring outside, furniture) and applies the
 * changes `step` returns. Coordinates in calls and changes are ABSOLUTE, like WaterSim's.
 */
export class WasmWater {
    free(): void;
    [Symbol.dispose](): void;
    busy(): boolean;
    clear(): void;
    /**
     * Banked cells in the ring outside the window: flat [ax, y, az, block, shape, wet]*.
     */
    edge(cells: Int32Array | number[]): void;
    /**
     * Replace the window. `outside`: the field column (empty for an island).
     */
    load(cells: Uint8Array | number[], shapes: Uint8Array | number[], wet: Uint8Array | number[], outside: Uint8Array | number[], origin_x: number, origin_z: number): void;
    constructor(sx: number, sy: number, sz: number, seal_table: Uint8Array | number[], budget: number);
    pending(): number;
    /**
     * Solid furniture cells: flat [ax, y, az]*, replacing the previous set.
     */
    props(cells: Int32Array | number[]): void;
    /**
     * One step under a soft time budget (ms; Infinity = none), like fluid.ts; committed changes
     * flat as x, y, z, id (absolute).
     */
    step(max_ms: number): Int32Array;
    touch(x: number, y: number, z: number): void;
    write(i: number, block: number, shape: number, wet: number): void;
}

/**
 * `stepBody` on the Rust core (`body.rs`), for the parity test (rust-body.test.ts): the island of
 * `seed` with `edits` applied ([x, y, z, block, shape, wet] each), a body at `start`
 * ([x, y, z, w, h, jumpSpeed], NaN = default) unstuck, then one tick per `inputs` entry
 * ([wishX, wishZ, jump, pushX, pushZ]). Returns [x, y, z, vx, vy, vz, grounded, wet] per tick.
 */
export function body_trace(seed: number, edits: Float64Array | number[], start: Float64Array | number[], inputs: Float64Array | number[], dt: number): Float64Array;

/**
 * `generateIsland(seed)` on the Rust core (`world.rs`): the cells, for the parity test.
 */
export function generate_island(seed: number): Uint8Array;

/**
 * Brick shells (`kit.rs`, a port of `kitShell.ts` `kitCellsGeometry(cells, false, joined)`).
 * `cells` is flat x, y, z; `mask` answers "joined" for the box (x0, y0, z0) + (sx, sy, sz),
 * indexed ((y * sz + z) * sx + x). Returns one Float32Array:
 * [vertex count, mask misses, positions (3n), normals (3n), colours (3n), uvs (2n)];
 * a vertex count of -1 is an open contour (the TypeScript throws there).
 */
export function kit_cells_geometry(cells: Int32Array | number[], mask: Uint8Array | number[], x0: number, y0: number, z0: number, sx: number, sy: number, sz: number): Float32Array;

/**
 * `createMaterialMaps(family, size)` on the Rust core: colour, normals and roughness bytes, concatenated.
 */
export function material_maps(family: string, size: number): Uint8Array;

/**
 * `VoxelWorld.raycast` on the Rust core, for the parity test (rust-body.test.ts): the island of
 * `seed` with `edits` applied (as body_trace), then each ray [ox, oy, oz, dx, dy, dz, maxDist,
 * fluids]. Returns [hit, vx, vy, vz, bx, by, bz, dist] per ray (hit 0 = none).
 */
export function raycast_trace(seed: number, edits: Float64Array | number[], rays: Float64Array | number[]): Float64Array;

/**
 * `surfaceStyle(key).family` on the Rust core (`surface.rs`), for the parity test.
 */
export function surface_family(key: string): string;

/**
 * `surfaceStyle(key)` numbers on the Rust core: [roughness, metalness, normal, clearcoat].
 */
export function surface_style(key: string): Float64Array;

/**
 * The water surface (`water_mesh.rs`, a port of waterGeometry.ts `buildWaterGeometry`) over a
 * 160 × 56 × 160 grid (`cells`, the VoxelWorld layout, waterlogged shapes already handed over AS
 * their water) and the column beyond it (`outside`, empty = air). Returns one Float32Array:
 * [vertex count, index count, position (3n), normal (3n), wave, wet, foam, depth (n each),
 * flow (3n), impact (3n), grid (4n), indices]; [0, 0] when nothing is drawn, [-1, 0] when the
 * TypeScript would throw.
 */
export function water_mesh(cells: Uint8Array | number[], outside: Uint8Array | number[], list: Int32Array | number[]): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmclasswater_free: (a: number, b: number) => void;
    readonly __wbg_wasmfluid_free: (a: number, b: number) => void;
    readonly __wbg_wasmscanner_free: (a: number, b: number) => void;
    readonly __wbg_wasmwater_free: (a: number, b: number) => void;
    readonly body_trace: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly generate_island: (a: number) => [number, number];
    readonly kit_cells_geometry: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly material_maps: (a: number, b: number, c: number) => [number, number];
    readonly raycast_trace: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly surface_family: (a: number, b: number) => [number, number];
    readonly surface_style: (a: number, b: number) => [number, number];
    readonly wasmclasswater_busy: (a: number) => number;
    readonly wasmclasswater_clear: (a: number) => void;
    readonly wasmclasswater_edit_count: (a: number) => number;
    readonly wasmclasswater_erase: (a: number, b: number, c: number, d: number) => void;
    readonly wasmclasswater_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly wasmclasswater_pending: (a: number) => number;
    readonly wasmclasswater_props: (a: number, b: number, c: number) => void;
    readonly wasmclasswater_reset: (a: number) => void;
    readonly wasmclasswater_step: (a: number, b: number) => [number, number];
    readonly wasmclasswater_take_at_capacity: (a: number) => number;
    readonly wasmclasswater_touch: (a: number, b: number, c: number, d: number) => void;
    readonly wasmclasswater_write: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasmclasswater_write_many: (a: number, b: number, c: number) => void;
    readonly wasmfluid_busy: (a: number) => number;
    readonly wasmfluid_get: (a: number, b: number, c: number, d: number) => number;
    readonly wasmfluid_new: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly wasmfluid_pending: (a: number) => number;
    readonly wasmfluid_put: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly wasmfluid_run: (a: number, b: number) => number;
    readonly wasmfluid_set: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasmfluid_step: (a: number) => [number, number];
    readonly wasmfluid_touch: (a: number, b: number, c: number, d: number) => void;
    readonly wasmfluid_water: (a: number, b: number, c: number, d: number) => number;
    readonly wasmscanner_add_template: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly wasmscanner_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number) => number;
    readonly wasmscanner_scan: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number];
    readonly wasmwater_busy: (a: number) => number;
    readonly wasmwater_clear: (a: number) => void;
    readonly wasmwater_edge: (a: number, b: number, c: number) => void;
    readonly wasmwater_load: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly wasmwater_new: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly wasmwater_pending: (a: number) => number;
    readonly wasmwater_props: (a: number, b: number, c: number) => void;
    readonly wasmwater_step: (a: number, b: number) => [number, number];
    readonly wasmwater_touch: (a: number, b: number, c: number, d: number) => void;
    readonly wasmwater_write: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly water_mesh: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
