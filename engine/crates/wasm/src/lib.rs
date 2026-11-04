//! WebAssembly bindings. The world lives on the Rust side: calling back into JavaScript for every
//! cell read would cost more than Rust saves, so JS hands cells over and gets changes back.

use craftyap_core::fluid::{FluidSim, FluidWorld, SparseWorld};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    /// The host's monotonic clock (ms): `performance.now` exists in browsers and in Node.
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

/// A water simulation over its own sparse world (parity tests and benchmarks for now).
#[wasm_bindgen]
pub struct WasmFluid {
    world: SparseWorld,
    sim: FluidSim,
}

#[wasm_bindgen]
impl WasmFluid {
    #[wasm_bindgen(constructor)]
    pub fn new(floor_y: i32, max_y: i32, half_size: i32, floor_block: u8, budget: usize) -> WasmFluid {
        WasmFluid { world: SparseWorld::new(floor_y, max_y, half_size, floor_block), sim: FluidSim::new(budget) }
    }
    /// Place a block (0 = air). `shaped`: it holds water behind the `seal` faces.
    pub fn put(&mut self, x: i32, y: i32, z: i32, block: u8, shaped: bool, seal: u8) {
        self.world.put(x, y, z, block, shaped, seal);
    }
    /// Write a cell the way the simulation does (water or air; a shaped cell's water layer).
    pub fn set(&mut self, x: i32, y: i32, z: i32, id: u8) {
        self.world.set(x, y, z, id);
    }
    pub fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        self.world.get(x, y, z)
    }
    pub fn water(&self, x: i32, y: i32, z: i32) -> u8 {
        self.world.water(x, y, z)
    }
    pub fn touch(&mut self, x: i32, y: i32, z: i32) {
        self.sim.touch(x, y, z);
    }
    pub fn busy(&self) -> bool {
        self.sim.busy()
    }
    pub fn pending(&self) -> usize {
        self.sim.pending_count()
    }
    /// One step; the committed changes flattened as x, y, z, id.
    pub fn step(&mut self) -> Vec<i32> {
        let changes = self.sim.step(&mut self.world);
        let mut out = Vec::with_capacity(changes.len() * 4);
        for (x, y, z, id) in changes {
            out.extend_from_slice(&[x, y, z, id as i32]);
        }
        out
    }
    /// Step until idle or `max_steps`, without crossing back into JS each step. Returns the number
    /// of committed changes.
    pub fn run(&mut self, max_steps: u32) -> u32 {
        let mut total = 0;
        for _ in 0..max_steps {
            if !self.sim.busy() {
                break;
            }
            total += self.sim.step(&mut self.world).len() as u32;
        }
        total
    }
}

/// The game's water on the mirrored voxel window (`Grid`): TypeScript keeps the window in step
/// (load on start/scroll, write per edited cell, the ring outside, furniture) and applies the
/// changes `step` returns. Coordinates in calls and changes are ABSOLUTE, like WaterSim's.
#[wasm_bindgen]
pub struct WasmWater {
    grid: craftyap_core::grid::Grid,
    sim: FluidSim,
}

#[wasm_bindgen]
impl WasmWater {
    #[wasm_bindgen(constructor)]
    pub fn new(sx: i32, sy: i32, sz: i32, seal_table: &[u8], budget: usize) -> WasmWater {
        WasmWater { grid: craftyap_core::grid::Grid::new(sx, sy, sz, seal_table), sim: FluidSim::new(budget) }
    }
    /// Replace the window. `outside`: the field column (empty for an island).
    pub fn load(&mut self, cells: &[u8], shapes: &[u8], wet: &[u8], outside: &[u8], origin_x: i32, origin_z: i32) {
        self.grid.load(cells, shapes, wet, outside, origin_x, origin_z);
    }
    pub fn write(&mut self, i: usize, block: u8, shape: u8, wet: u8) {
        self.grid.write(i, block, shape, wet);
    }
    /// Banked cells in the ring outside the window: flat [ax, y, az, block, shape, wet]*.
    pub fn edge(&mut self, cells: &[i32]) {
        for c in cells.as_chunks::<6>().0 {
            self.grid.set_edge(c[0], c[1], c[2], c[3] as u8, c[4] as u8, c[5] as u8);
        }
    }
    /// Solid furniture cells: flat [ax, y, az]*, replacing the previous set.
    pub fn props(&mut self, cells: &[i32]) {
        self.grid.set_props(cells.as_chunks::<3>().0.iter().map(|c| (c[0], c[1], c[2])));
    }
    pub fn touch(&mut self, x: i32, y: i32, z: i32) {
        self.sim.touch(x, y, z);
    }
    pub fn clear(&mut self) {
        self.sim.clear();
    }
    pub fn busy(&self) -> bool {
        self.sim.busy()
    }
    pub fn pending(&self) -> usize {
        self.sim.pending_count()
    }
    /// One step under a soft time budget (ms; Infinity = none), like fluid.ts; committed changes
    /// flat as x, y, z, id (absolute).
    pub fn step(&mut self, max_ms: f64) -> Vec<i32> {
        let changes = self.sim.step_timed(&mut self.grid, max_ms, performance_now);
        let mut out = Vec::with_capacity(changes.len() * 4);
        for (x, y, z, id) in changes {
            out.extend_from_slice(&[x, y, z, id as i32]);
        }
        out
    }
}

/// A classroom's water (the server): the Rust core over a mirror of the class's field. The server
/// mirrors every cell it writes (`write`/`erase`), resets, and furniture; it applies the changes
/// `step` returns to its own maps. Coordinates are absolute field cells.
#[wasm_bindgen]
pub struct WasmClassWater {
    world: craftyap_core::field::FieldWorld,
    sim: FluidSim,
}

#[wasm_bindgen]
impl WasmClassWater {
    #[wasm_bindgen(constructor)]
    pub fn new(column: &[u8], max_coord: i32, max_y: i32, max_edits: usize, seal_table: &[u8], budget: usize) -> WasmClassWater {
        WasmClassWater {
            world: craftyap_core::field::FieldWorld::new(column, max_coord, max_y, max_edits, seal_table),
            sim: FluidSim::new(budget),
        }
    }
    /// The server stored a cell (block, shape).
    pub fn write(&mut self, x: i32, y: i32, z: i32, block: u8, shape: u8) {
        self.world.write((x, y, z), Some((block, shape)));
    }
    /// The server dropped a cell back to the plain field.
    pub fn erase(&mut self, x: i32, y: i32, z: i32) {
        self.world.write((x, y, z), None);
    }
    /// Many cells at once (a restored class): flat [x, y, z, block, shape]*.
    pub fn write_many(&mut self, cells: &[i32]) {
        self.world.reserve(cells.len() / 5);
        for c in cells.as_chunks::<5>().0 {
            self.world.write((c[0], c[1], c[2]), Some((c[3] as u8, c[4] as u8)));
        }
    }
    pub fn reset(&mut self) {
        self.world.reset();
        self.sim.clear();
    }
    /// Solid furniture cells: flat [x, y, z]*, replacing the previous set.
    pub fn props(&mut self, cells: &[i32]) {
        self.world.set_props(cells.as_chunks::<3>().0.iter().map(|c| (c[0], c[1], c[2])));
    }
    pub fn touch(&mut self, x: i32, y: i32, z: i32) {
        self.sim.touch(x, y, z);
    }
    pub fn clear(&mut self) {
        self.sim.clear();
    }
    pub fn busy(&self) -> bool {
        self.sim.busy()
    }
    pub fn pending(&self) -> usize {
        self.sim.pending_count()
    }
    pub fn edit_count(&self) -> usize {
        self.world.edit_count()
    }
    /// Did the last steps meet a full store? (cleared by reading)
    pub fn take_at_capacity(&self) -> bool {
        self.world.take_at_capacity()
    }
    /// One step under a soft time budget (ms; Infinity = none), like fluid.ts; committed changes
    /// flat as x, y, z, id.
    pub fn step(&mut self, max_ms: f64) -> Vec<i32> {
        let changes = self.sim.step_timed(&mut self.world, max_ms, performance_now);
        let mut out = Vec::with_capacity(changes.len() * 4);
        for (x, y, z, id) in changes {
            out.extend_from_slice(&[x, y, z, id as i32]);
        }
        out
    }
}

/// Brick shells (`kit.rs`, a port of `kitShell.ts` `kitCellsGeometry(cells, false, joined)`).
/// `cells` is flat x, y, z; `mask` answers "joined" for the box (x0, y0, z0) + (sx, sy, sz),
/// indexed ((y * sz + z) * sx + x). Returns one Float32Array:
/// [vertex count, mask misses, positions (3n), normals (3n), colours (3n), uvs (2n)];
/// a vertex count of -1 is an open contour (the TypeScript throws there).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn kit_cells_geometry(cells: &[i32], mask: &[u8], x0: i32, y0: i32, z0: i32, sx: i32, sy: i32, sz: i32) -> Vec<f32> {
    use craftyap_core::kit::{kit_cells_geometry as build, JoinMask};
    let list: Vec<(i32, i32, i32)> = cells.as_chunks::<3>().0.iter().map(|c| (c[0], c[1], c[2])).collect();
    let m = JoinMask { x0, y0, z0, sx, sy, sz, cells: mask, missed: Default::default() };
    match build(&list, &m) {
        Err(_) => vec![-1.0, m.missed.get() as f32],
        Ok(g) => {
            let n = g.pos.len() / 3;
            let mut out = Vec::with_capacity(2 + n * 11);
            out.push(n as f32);
            out.push(m.missed.get() as f32);
            out.extend_from_slice(&g.pos);
            out.extend_from_slice(&g.nrm);
            out.extend_from_slice(&g.col);
            out.extend_from_slice(&g.uv);
            out
        }
    }
}
