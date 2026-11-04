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
const WasmWaterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmwater_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
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

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
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
