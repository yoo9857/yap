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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmclasswater_free: (a: number, b: number) => void;
    readonly __wbg_wasmfluid_free: (a: number, b: number) => void;
    readonly __wbg_wasmwater_free: (a: number, b: number) => void;
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
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
