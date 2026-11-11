/* @ts-self-types="./craftyap_wasm.d.ts" */

/**
 * A classroom's water (the server): the Rust core over a mirror of the class's field. The server
 * mirrors every cell it writes (`write`/`erase`), resets, and furniture; it applies the changes
 * `step` returns to its own maps. Coordinates are absolute field cells.
 */
export class WasmClassWater {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmClassWaterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmclasswater_free(ptr, 0);
    }
    /**
     * @returns {boolean}
     */
    busy() {
        const ret = wasm.wasmclasswater_busy(this.__wbg_ptr);
        return ret !== 0;
    }
    clear() {
        wasm.wasmclasswater_clear(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    edit_count() {
        const ret = wasm.wasmclasswater_edit_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The server dropped a cell back to the plain field.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    erase(x, y, z) {
        wasm.wasmclasswater_erase(this.__wbg_ptr, x, y, z);
    }
    /**
     * @param {Uint8Array | number[]} column
     * @param {number} max_coord
     * @param {number} max_y
     * @param {number} max_edits
     * @param {Uint8Array | number[]} seal_table
     * @param {number} budget
     */
    constructor(column, max_coord, max_y, max_edits, seal_table, budget) {
        const val3 = +max_coord;
        const val4 = +max_y;
        const val5 = +max_edits;
        const val6 = +budget;
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passArray8ToWasm0(column, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passArray8ToWasm0(seal_table, wasm.__wbindgen_malloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.wasmclasswater_new(ptr0, len0, val3, val4, val5, ptr1, len1, val6);
        this.__wbg_ptr = ret;
        WasmClassWaterFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    pending() {
        const ret = wasm.wasmclasswater_pending(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Solid furniture cells: flat [x, y, z]*, replacing the previous set.
     * @param {Int32Array | number[]} cells
     */
    props(cells) {
        const ptr0 = passArray32ToWasm0(cells, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmclasswater_props(this.__wbg_ptr, ptr0, len0);
    }
    reset() {
        wasm.wasmclasswater_reset(this.__wbg_ptr);
    }
    /**
     * One step under a soft time budget (ms; Infinity = none), like fluid.ts; committed changes
     * flat as x, y, z, id.
     * @param {number} max_ms
     * @returns {Int32Array}
     */
    step(max_ms) {
        const ret = wasm.wasmclasswater_step(this.__wbg_ptr, max_ms);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Did the last steps meet a full store? (cleared by reading)
     * @returns {boolean}
     */
    take_at_capacity() {
        const ret = wasm.wasmclasswater_take_at_capacity(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    touch(x, y, z) {
        wasm.wasmclasswater_touch(this.__wbg_ptr, x, y, z);
    }
    /**
     * The server stored a cell (block, shape).
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} block
     * @param {number} shape
     */
    write(x, y, z, block, shape) {
        wasm.wasmclasswater_write(this.__wbg_ptr, x, y, z, block, shape);
    }
    /**
     * Many cells at once (a restored class): flat [x, y, z, block, shape]*.
     * @param {Int32Array | number[]} cells
     */
    write_many(cells) {
        const ptr0 = passArray32ToWasm0(cells, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmclasswater_write_many(this.__wbg_ptr, ptr0, len0);
    }
}
if (Symbol.dispose) WasmClassWater.prototype[Symbol.dispose] = WasmClassWater.prototype.free;

/**
 * A water simulation over its own sparse world (parity tests and benchmarks for now).
 */
export class WasmFluid {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmFluidFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmfluid_free(ptr, 0);
    }
    /**
     * @returns {boolean}
     */
    busy() {
        const ret = wasm.wasmfluid_busy(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {number}
     */
    get(x, y, z) {
        const ret = wasm.wasmfluid_get(this.__wbg_ptr, x, y, z);
        return ret;
    }
    /**
     * @param {number} floor_y
     * @param {number} max_y
     * @param {number} half_size
     * @param {number} floor_block
     * @param {number} budget
     */
    constructor(floor_y, max_y, half_size, floor_block, budget) {
        const ret = wasm.wasmfluid_new(floor_y, max_y, half_size, floor_block, budget);
        this.__wbg_ptr = ret;
        WasmFluidFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    pending() {
        const ret = wasm.wasmfluid_pending(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Place a block (0 = air). `shaped`: it holds water behind the `seal` faces.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} block
     * @param {boolean} shaped
     * @param {number} seal
     */
    put(x, y, z, block, shaped, seal) {
        wasm.wasmfluid_put(this.__wbg_ptr, x, y, z, block, shaped, seal);
    }
    /**
     * Step until idle or `max_steps`, without crossing back into JS each step. Returns the number
     * of committed changes.
     * @param {number} max_steps
     * @returns {number}
     */
    run(max_steps) {
        const ret = wasm.wasmfluid_run(this.__wbg_ptr, max_steps);
        return ret >>> 0;
    }
    /**
     * Write a cell the way the simulation does (water or air; a shaped cell's water layer).
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} id
     */
    set(x, y, z, id) {
        wasm.wasmfluid_set(this.__wbg_ptr, x, y, z, id);
    }
    /**
     * One step; the committed changes flattened as x, y, z, id.
     * @returns {Int32Array}
     */
    step() {
        const ret = wasm.wasmfluid_step(this.__wbg_ptr);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    touch(x, y, z) {
        wasm.wasmfluid_touch(this.__wbg_ptr, x, y, z);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {number}
     */
    water(x, y, z) {
        const ret = wasm.wasmfluid_water(this.__wbg_ptr, x, y, z);
        return ret;
    }
}
if (Symbol.dispose) WasmFluid.prototype[Symbol.dispose] = WasmFluid.prototype.free;

/**
 * The block renderer's chunk scan (`scan.rs`, a port of `VoxelView.scanChunk`). Built once per
 * view from its tables; `scan` runs per chunk on a slab (the chunk + a one-cell ring, every height).
 */
export class WasmScanner {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmScannerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmscanner_free(ptr, 0);
    }
    /**
     * A far-form template, in the order `family` indexes them.
     * @param {Float32Array | number[]} pos
     * @param {Float32Array | number[]} nrm
     * @param {Float32Array | number[] | null} [uv]
     */
    add_template(pos, nrm, uv) {
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = passArrayF32ToWasm0(pos, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passArrayF32ToWasm0(nrm, wasm.__wbindgen_malloc);
            len1 = WASM_VECTOR_LEN;
            ptr2 = isLikeNone(uv) ? 0 : passArrayF32ToWasm0(uv, wasm.__wbindgen_malloc);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 4, 4); }
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 4, 4); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 4, 4); }
            throw e;
        }
        wasm.wasmscanner_add_template(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
    }
    /**
     * Per block id (256 each): solid, see-through, def bits (1 exists, 2 noStud, 4 grass), material
     * count (0, 1 or 3) and 3 material slots; per shape code (256 each): full cube, far family;
     * `faces` 6 × (n, u, v, o); `corners` 6 × (u, v); `face_uv` 12; `quats` 256 × (x, y, z, w).
     * @param {Uint8Array | number[]} solid
     * @param {Uint8Array | number[]} see_through
     * @param {Uint8Array | number[]} def
     * @param {Uint8Array | number[]} mat_count
     * @param {Int32Array | number[]} mats
     * @param {Uint8Array | number[]} full_cube
     * @param {Uint8Array | number[]} family
     * @param {number} dirt
     * @param {number} kit_cube
     * @param {number} round
     * @param {Float64Array | number[]} faces
     * @param {Float64Array | number[]} corners
     * @param {Float64Array | number[]} face_uv
     * @param {number} backing_inset
     * @param {Float64Array | number[]} quats
     * @param {number} world_y
     */
    constructor(solid, see_through, def, mat_count, mats, full_cube, family, dirt, kit_cube, round, faces, corners, face_uv, backing_inset, quats, world_y) {
        const val12 = +dirt;
        const val13 = +kit_cube;
        const val14 = +round;
        const val15 = +backing_inset;
        const val16 = +world_y;
        let ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, ptr10, len10;
        try {
            ptr0 = passArray8ToWasm0(solid, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passArray8ToWasm0(see_through, wasm.__wbindgen_malloc);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passArray8ToWasm0(def, wasm.__wbindgen_malloc);
            len2 = WASM_VECTOR_LEN;
            ptr3 = passArray8ToWasm0(mat_count, wasm.__wbindgen_malloc);
            len3 = WASM_VECTOR_LEN;
            ptr4 = passArray32ToWasm0(mats, wasm.__wbindgen_malloc);
            len4 = WASM_VECTOR_LEN;
            ptr5 = passArray8ToWasm0(full_cube, wasm.__wbindgen_malloc);
            len5 = WASM_VECTOR_LEN;
            ptr6 = passArray8ToWasm0(family, wasm.__wbindgen_malloc);
            len6 = WASM_VECTOR_LEN;
            ptr7 = passArrayF64ToWasm0(faces, wasm.__wbindgen_malloc);
            len7 = WASM_VECTOR_LEN;
            ptr8 = passArrayF64ToWasm0(corners, wasm.__wbindgen_malloc);
            len8 = WASM_VECTOR_LEN;
            ptr9 = passArrayF64ToWasm0(face_uv, wasm.__wbindgen_malloc);
            len9 = WASM_VECTOR_LEN;
            ptr10 = passArrayF64ToWasm0(quats, wasm.__wbindgen_malloc);
            len10 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr10) { wasm.__wbindgen_free(ptr10, len10 * 8, 8); }
            if (ptr9) { wasm.__wbindgen_free(ptr9, len9 * 8, 8); }
            if (ptr8) { wasm.__wbindgen_free(ptr8, len8 * 8, 8); }
            if (ptr7) { wasm.__wbindgen_free(ptr7, len7 * 8, 8); }
            if (ptr6) { wasm.__wbindgen_free(ptr6, len6 * 1, 1); }
            if (ptr5) { wasm.__wbindgen_free(ptr5, len5 * 1, 1); }
            if (ptr4) { wasm.__wbindgen_free(ptr4, len4 * 4, 4); }
            if (ptr3) { wasm.__wbindgen_free(ptr3, len3 * 1, 1); }
            if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.wasmscanner_new(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, val12, val13, val14, ptr7, len7, ptr8, len8, ptr9, len9, val15, ptr10, len10, val16);
        this.__wbg_ptr = ret;
        WasmScannerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * One chunk. Packed float32: [ok, top, nWater, water…, nStuds, (key, len, xyz…)…,
     * nNear, (key, len, xyz…)…, nBacking, backing…, nFar, (index, nVerts, pos…, nrm…, uv…)…].
     * @param {Uint8Array | number[]} cells
     * @param {Uint8Array | number[]} shapes
     * @param {Uint8Array | number[]} hidden
     * @param {number} sx0
     * @param {number} sz0
     * @param {number} sw
     * @param {number} sd
     * @param {number} x0
     * @param {number} z0
     * @param {number} x1
     * @param {number} z1
     * @param {boolean} far
     * @returns {Float32Array}
     */
    scan(cells, shapes, hidden, sx0, sz0, sw, sd, x0, z0, x1, z1, far) {
        const val4 = +sx0;
        const val5 = +sz0;
        const val6 = +sw;
        const val7 = +sd;
        const val8 = +x0;
        const val9 = +z0;
        const val10 = +x1;
        const val11 = +z1;
        const val12 = +far;
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = passArray8ToWasm0(cells, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passArray8ToWasm0(shapes, wasm.__wbindgen_malloc);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passArray8ToWasm0(hidden, wasm.__wbindgen_malloc);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.wasmscanner_scan(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, val4, val5, val6, val7, val8, val9, val10, val11, val12);
        var v13 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v13;
    }
}
if (Symbol.dispose) WasmScanner.prototype[Symbol.dispose] = WasmScanner.prototype.free;

/**
 * The game's water on the mirrored voxel window (`Grid`): TypeScript keeps the window in step
 * (load on start/scroll, write per edited cell, the ring outside, furniture) and applies the
 * changes `step` returns. Coordinates in calls and changes are ABSOLUTE, like WaterSim's.
 */
export class WasmWater {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmWaterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmwater_free(ptr, 0);
    }
    /**
     * @returns {boolean}
     */
    busy() {
        const ret = wasm.wasmwater_busy(this.__wbg_ptr);
        return ret !== 0;
    }
    clear() {
        wasm.wasmwater_clear(this.__wbg_ptr);
    }
    /**
     * Banked cells in the ring outside the window: flat [ax, y, az, block, shape, wet]*.
     * @param {Int32Array | number[]} cells
     */
    edge(cells) {
        const ptr0 = passArray32ToWasm0(cells, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmwater_edge(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Replace the window. `outside`: the field column (empty for an island).
     * @param {Uint8Array | number[]} cells
     * @param {Uint8Array | number[]} shapes
     * @param {Uint8Array | number[]} wet
     * @param {Uint8Array | number[]} outside
     * @param {number} origin_x
     * @param {number} origin_z
     */
    load(cells, shapes, wet, outside, origin_x, origin_z) {
        const val5 = +origin_x;
        const val6 = +origin_z;
        let ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3;
        try {
            ptr0 = passArray8ToWasm0(cells, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passArray8ToWasm0(shapes, wasm.__wbindgen_malloc);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passArray8ToWasm0(wet, wasm.__wbindgen_malloc);
            len2 = WASM_VECTOR_LEN;
            ptr3 = passArray8ToWasm0(outside, wasm.__wbindgen_malloc);
            len3 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr3) { wasm.__wbindgen_free(ptr3, len3 * 1, 1); }
            if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        wasm.wasmwater_load(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, val5, val6);
    }
    /**
     * @param {number} sx
     * @param {number} sy
     * @param {number} sz
     * @param {Uint8Array | number[]} seal_table
     * @param {number} budget
     */
    constructor(sx, sy, sz, seal_table, budget) {
        const val2 = +sx;
        const val3 = +sy;
        const val4 = +sz;
        const val5 = +budget;
        const ptr0 = passArray8ToWasm0(seal_table, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmwater_new(val2, val3, val4, ptr0, len0, val5);
        this.__wbg_ptr = ret;
        WasmWaterFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    pending() {
        const ret = wasm.wasmwater_pending(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Solid furniture cells: flat [ax, y, az]*, replacing the previous set.
     * @param {Int32Array | number[]} cells
     */
    props(cells) {
        const ptr0 = passArray32ToWasm0(cells, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmwater_props(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * One step under a soft time budget (ms; Infinity = none), like fluid.ts; committed changes
     * flat as x, y, z, id (absolute).
     * @param {number} max_ms
     * @returns {Int32Array}
     */
    step(max_ms) {
        const ret = wasm.wasmwater_step(this.__wbg_ptr, max_ms);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    touch(x, y, z) {
        wasm.wasmwater_touch(this.__wbg_ptr, x, y, z);
    }
    /**
     * @param {number} i
     * @param {number} block
     * @param {number} shape
     * @param {number} wet
     */
    write(i, block, shape, wet) {
        wasm.wasmwater_write(this.__wbg_ptr, i, block, shape, wet);
    }
}
if (Symbol.dispose) WasmWater.prototype[Symbol.dispose] = WasmWater.prototype.free;

/**
 * `stepBody` on the Rust core (`body.rs`), for the parity test (rust-body.test.ts): the island of
 * `seed` with `edits` applied ([x, y, z, block, shape, wet] each), a body at `start`
 * ([x, y, z, w, h, jumpSpeed], NaN = default) unstuck, then one tick per `inputs` entry
 * ([wishX, wishZ, jump, pushX, pushZ]). Returns [x, y, z, vx, vy, vz, grounded, wet] per tick.
 * @param {number} seed
 * @param {Float64Array | number[]} edits
 * @param {Float64Array | number[]} start
 * @param {Float64Array | number[]} inputs
 * @param {number} dt
 * @returns {Float64Array}
 */
export function body_trace(seed, edits, start, inputs, dt) {
    const val4 = +seed;
    const val5 = +dt;
    let ptr0, len0, ptr1, len1, ptr2, len2;
    try {
        ptr0 = passArrayF64ToWasm0(edits, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF64ToWasm0(start, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
        ptr2 = passArrayF64ToWasm0(inputs, wasm.__wbindgen_malloc);
        len2 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 8, 8); }
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 8, 8); }
        throw e;
    }
    const ret = wasm.body_trace(val4, ptr0, len0, ptr1, len1, ptr2, len2, val5);
    var v6 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v6;
}

/**
 * `generateIsland(seed)` on the Rust core (`world.rs`): the cells, for the parity test.
 * @param {number} seed
 * @returns {Uint8Array}
 */
export function generate_island(seed) {
    const ret = wasm.generate_island(seed);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * Brick shells (`kit.rs`, a port of `kitShell.ts` `kitCellsGeometry(cells, false, joined)`).
 * `cells` is flat x, y, z; `mask` answers "joined" for the box (x0, y0, z0) + (sx, sy, sz),
 * indexed ((y * sz + z) * sx + x). Returns one Float32Array:
 * [vertex count, mask misses, positions (3n), normals (3n), colours (3n), uvs (2n)];
 * a vertex count of -1 is an open contour (the TypeScript throws there).
 * @param {Int32Array | number[]} cells
 * @param {Uint8Array | number[]} mask
 * @param {number} x0
 * @param {number} y0
 * @param {number} z0
 * @param {number} sx
 * @param {number} sy
 * @param {number} sz
 * @returns {Float32Array}
 */
export function kit_cells_geometry(cells, mask, x0, y0, z0, sx, sy, sz) {
    const val3 = +x0;
    const val4 = +y0;
    const val5 = +z0;
    const val6 = +sx;
    const val7 = +sy;
    const val8 = +sz;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArray32ToWasm0(cells, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArray8ToWasm0(mask, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 4, 4); }
        throw e;
    }
    const ret = wasm.kit_cells_geometry(ptr0, len0, ptr1, len1, val3, val4, val5, val6, val7, val8);
    var v9 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v9;
}

/**
 * `createMaterialMaps(family, size)` on the Rust core: colour, normals and roughness bytes, concatenated.
 * @param {string} family
 * @param {number} size
 * @returns {Uint8Array}
 */
export function material_maps(family, size) {
    const val2 = +size;
    const ptr0 = passStringToWasm0(family, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.material_maps(ptr0, len0, val2);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * `VoxelWorld.raycast` on the Rust core, for the parity test (rust-body.test.ts): the island of
 * `seed` with `edits` applied (as body_trace), then each ray [ox, oy, oz, dx, dy, dz, maxDist,
 * fluids]. Returns [hit, vx, vy, vz, bx, by, bz, dist] per ray (hit 0 = none).
 * @param {number} seed
 * @param {Float64Array | number[]} edits
 * @param {Float64Array | number[]} rays
 * @returns {Float64Array}
 */
export function raycast_trace(seed, edits, rays) {
    const val3 = +seed;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArrayF64ToWasm0(edits, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF64ToWasm0(rays, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 8, 8); }
        throw e;
    }
    const ret = wasm.raycast_trace(val3, ptr0, len0, ptr1, len1);
    var v4 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v4;
}

/**
 * `surfaceStyle(key).family` on the Rust core (`surface.rs`), for the parity test.
 * @param {string} key
 * @returns {string}
 */
export function surface_family(key) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.surface_family(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * `surfaceStyle(key)` numbers on the Rust core: [roughness, metalness, normal, clearcoat].
 * @param {string} key
 * @returns {Float64Array}
 */
export function surface_style(key) {
    const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.surface_style(ptr0, len0);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * The water surface (`water_mesh.rs`, a port of waterGeometry.ts `buildWaterGeometry`) over a
 * 160 × 56 × 160 grid (`cells`, the VoxelWorld layout, waterlogged shapes already handed over AS
 * their water) and the column beyond it (`outside`, empty = air). Returns one Float32Array:
 * [vertex count, index count, position (3n), normal (3n), wave, wet, foam, depth (n each),
 * flow (3n), impact (3n), grid (4n), indices]; [0, 0] when nothing is drawn, [-1, 0] when the
 * TypeScript would throw. `profile` (same layout as `cells`, or empty): the top of each shaped
 * block holding water (waterlog.ts `shapeProfile`).
 * @param {Uint8Array | number[]} cells
 * @param {Uint8Array | number[]} outside
 * @param {Int32Array | number[]} list
 * @param {Uint8Array | number[]} profile
 * @returns {Float32Array}
 */
export function water_mesh(cells, outside, list, profile) {
    let ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3;
    try {
        ptr0 = passArray8ToWasm0(cells, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArray8ToWasm0(outside, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
        ptr2 = passArray32ToWasm0(list, wasm.__wbindgen_malloc);
        len2 = WASM_VECTOR_LEN;
        ptr3 = passArray8ToWasm0(profile, wasm.__wbindgen_malloc);
        len3 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr3) { wasm.__wbindgen_free(ptr3, len3 * 1, 1); }
        if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 4, 4); }
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.water_mesh(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    var v5 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v5;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_now_85d0c2a31e5c4443: function() {
            const ret = performance.now();
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./craftyap_wasm_bg.js": import0,
    };
}

const WasmClassWaterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmclasswater_free(ptr, 1));
const WasmFluidFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmfluid_free(ptr, 1));
const WasmScannerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmscanner_free(ptr, 1));
const WasmWaterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmwater_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(bytes) {
    numBytesDecoded += bytes.length;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
        cachedTextDecoder.decode();
        numBytesDecoded = bytes.length;
    }
    return cachedTextDecoder.decode(bytes);
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    if (__wbg_init_promise === undefined) {
        __wbg_init_promise = __wbg_init_once(module_or_path);
        __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
    }
    return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('craftyap_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
