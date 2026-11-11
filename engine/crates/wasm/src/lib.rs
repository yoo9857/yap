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

/// The block renderer's chunk scan (`scan.rs`, a port of `VoxelView.scanChunk`). Built once per
/// view from its tables; `scan` runs per chunk on a slab (the chunk + a one-cell ring, every height).
#[wasm_bindgen]
pub struct WasmScanner {
    tables: craftyap_core::scan::Tables,
}

#[wasm_bindgen]
impl WasmScanner {
    /// Per block id (256 each): solid, see-through, def bits (1 exists, 2 noStud, 4 grass), material
    /// count (0, 1 or 3) and 3 material slots; per shape code (256 each): full cube, far family;
    /// `faces` 6 × (n, u, v, o); `corners` 6 × (u, v); `face_uv` 12; `quats` 256 × (x, y, z, w).
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(solid: &[u8], see_through: &[u8], def: &[u8], mat_count: &[u8], mats: &[i32], full_cube: &[u8], family: &[u8], dirt: u8, kit_cube: u8, round: u8, faces: &[f64], corners: &[f64], face_uv: &[f64], backing_inset: f64, quats: &[f64], world_y: i32) -> WasmScanner {
        use craftyap_core::scan::{Face, Tables};
        let flags = |a: &[u8]| -> [bool; 256] {
            let mut out = [false; 256];
            for (i, v) in a.iter().take(256).enumerate() {
                out[i] = *v != 0;
            }
            out
        };
        let bytes = |a: &[u8]| -> [u8; 256] {
            let mut out = [0u8; 256];
            for (i, v) in a.iter().take(256).enumerate() {
                out[i] = *v;
            }
            out
        };
        let materials = (0..256).map(|b| (0..mat_count[b] as usize).map(|k| mats[b * 3 + k]).collect()).collect();
        let faces = faces.as_chunks::<12>().0.iter().map(|f| Face { n: [f[0], f[1], f[2]], u: [f[3], f[4], f[5]], v: [f[6], f[7], f[8]], o: [f[9], f[10], f[11]] }).collect();
        let mut face_corners = [(0.0, 0.0); 6];
        for k in 0..6 {
            face_corners[k] = (corners[k * 2], corners[k * 2 + 1]);
        }
        let mut uv = [0.0; 12];
        uv.copy_from_slice(&face_uv[..12]);
        let quats = quats.as_chunks::<4>().0.to_vec();
        WasmScanner {
            tables: Tables {
                solid: flags(solid),
                full_cube: flags(full_cube),
                see_through: flags(see_through),
                def: bytes(def),
                dirt,
                kit_cube,
                round,
                faces,
                face_corners,
                face_uv: uv,
                backing_inset,
                materials,
                family: bytes(family),
                templates: Vec::new(),
                quats,
                world_y,
            },
        }
    }

    /// A far-form template, in the order `family` indexes them.
    pub fn add_template(&mut self, pos: &[f32], nrm: &[f32], uv: Option<Vec<f32>>) {
        self.tables.templates.push(craftyap_core::scan::Template {
            pos: pos.iter().map(|v| *v as f64).collect(),
            nrm: nrm.iter().map(|v| *v as f64).collect(),
            uv: uv.map(|u| u.iter().map(|v| *v as f64).collect()),
        });
    }

    /// One chunk. Packed float32: [ok, top, nWater, water…, nStuds, (key, len, xyz…)…,
    /// nNear, (key, len, xyz…)…, nBacking, backing…, nFar, (index, nVerts, pos…, nrm…, uv…)…].
    #[allow(clippy::too_many_arguments)]
    pub fn scan(&self, cells: &[u8], shapes: &[u8], hidden: &[u8], sx0: i32, sz0: i32, sw: i32, sd: i32, x0: i32, z0: i32, x1: i32, z1: i32, far: bool) -> Vec<f32> {
        use craftyap_core::scan::{scan, Slab};
        let slab = Slab { x0: sx0, z0: sz0, w: sw, d: sd, cells, shapes, hidden };
        let out = match scan(&self.tables, &slab, x0, z0, x1, z1, far) {
            Ok(o) => o,
            Err(_) => return vec![0.0],
        };
        let mut v: Vec<f32> = Vec::with_capacity(64 + out.water.len() + out.backing.len());
        v.push(1.0);
        v.push(out.top as f32);
        v.push(out.water.len() as f32);
        v.extend(out.water.iter().map(|x| *x as f32));
        for map in [&out.studs, &out.near] {
            v.push(map.keys.len() as f32);
            for (k, list) in map.keys.iter().zip(&map.values) {
                v.push(*k as f32);
                v.push(list.len() as f32);
                v.extend(list.iter().map(|x| *x as f32));
            }
        }
        v.push(out.backing.len() as f32);
        v.extend_from_slice(&out.backing);
        v.push(out.far.keys.len() as f32);
        for (k, b) in out.far.keys.iter().zip(&out.far.values) {
            v.push(*k as f32);
            v.push((b.pos.len() / 3) as f32);
            v.extend_from_slice(&b.pos);
            v.extend_from_slice(&b.nrm);
            v.extend_from_slice(&b.uv);
        }
        v
    }
}

/// `generateIsland(seed)` on the Rust core (`world.rs`): the cells, for the parity test.
#[wasm_bindgen]
pub fn generate_island(seed: f64) -> Vec<u8> {
    craftyap_core::world::generate_island(seed).cells
}

/// `surfaceStyle(key).family` on the Rust core (`surface.rs`), for the parity test.
#[wasm_bindgen]
pub fn surface_family(key: &str) -> String {
    craftyap_core::surface::family_of(key).name().to_string()
}

/// `createMaterialMaps(family, size)` on the Rust core: colour, normals and roughness bytes, concatenated.
#[wasm_bindgen]
pub fn material_maps(family: &str, size: usize) -> Vec<u8> {
    use craftyap_core::surface::{create_material_maps, Family};
    let Some(f) = Family::ALL.iter().copied().find(|f| f.name() == family) else { return Vec::new() };
    let m = create_material_maps(f, size);
    [m.colour, m.normals, m.rough].concat()
}

/// `stepBody` on the Rust core (`body.rs`), for the parity test (rust-body.test.ts): the island of
/// `seed` with `edits` applied ([x, y, z, block, shape, wet] each), a body at `start`
/// ([x, y, z, w, h, jumpSpeed], NaN = default) unstuck, then one tick per `inputs` entry
/// ([wishX, wishZ, jump, pushX, pushZ]). Returns [x, y, z, vx, vy, vz, grounded, wet] per tick.
#[wasm_bindgen]
pub fn body_trace(seed: f64, edits: &[f64], start: &[f64], inputs: &[f64], dt: f64) -> Vec<f64> {
    use craftyap_core::body::{step_body, unstick, Body};
    use craftyap_core::world::World;
    let mut w = craftyap_core::world::generate_island(seed);
    for e in edits.as_chunks::<6>().0 {
        let (x, y, z) = (e[0] as i32, e[1] as i32, e[2] as i32);
        if e[4] > 0.0 {
            w.set_shaped(x, y, z, e[3] as u8, e[4] as u8);
        } else {
            w.set(x, y, z, e[3] as u8);
        }
        if e[5] > 0.0 && World::in_bounds(x, y, z) {
            w.wet[World::index(x, y, z)] = e[5] as u8;
        }
    }
    let opt = |v: f64| (!v.is_nan()).then_some(v);
    let mut b = Body { w: opt(start[3]), h: opt(start[4]), jump_speed: opt(start[5]), ..Body::at(start[0], start[1], start[2]) };
    unstick(&w, &mut b);
    let mut out = Vec::with_capacity(inputs.len() / 5 * 8);
    for i in inputs.as_chunks::<5>().0 {
        step_body(&w, &mut b, dt, i[0], i[1], i[2] != 0.0, i[3], i[4]);
        out.extend_from_slice(&[b.x, b.y, b.z, b.vx, b.vy, b.vz, if b.grounded { 1.0 } else { 0.0 }, b.wet]);
    }
    out
}

/// `VoxelWorld.raycast` on the Rust core, for the parity test (rust-body.test.ts): the island of
/// `seed` with `edits` applied (as body_trace), then each ray [ox, oy, oz, dx, dy, dz, maxDist,
/// fluids]. Returns [hit, vx, vy, vz, bx, by, bz, dist] per ray (hit 0 = none).
#[wasm_bindgen]
pub fn raycast_trace(seed: f64, edits: &[f64], rays: &[f64]) -> Vec<f64> {
    use craftyap_core::world::World;
    let mut w = craftyap_core::world::generate_island(seed);
    for e in edits.as_chunks::<6>().0 {
        let (x, y, z) = (e[0] as i32, e[1] as i32, e[2] as i32);
        if e[4] > 0.0 {
            w.set_shaped(x, y, z, e[3] as u8, e[4] as u8);
        } else {
            w.set(x, y, z, e[3] as u8);
        }
        if e[5] > 0.0 && World::in_bounds(x, y, z) {
            w.wet[World::index(x, y, z)] = e[5] as u8;
        }
    }
    let mut out = Vec::with_capacity(rays.len());
    for r in rays.as_chunks::<8>().0 {
        match w.raycast(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7] != 0.0) {
            Some(h) => out.extend_from_slice(&[1.0, h.voxel[0] as f64, h.voxel[1] as f64, h.voxel[2] as f64, h.before[0] as f64, h.before[1] as f64, h.before[2] as f64, h.dist]),
            None => out.extend_from_slice(&[0.0; 8]),
        }
    }
    out
}

/// `surfaceStyle(key)` numbers on the Rust core: [roughness, metalness, normal, clearcoat].
#[wasm_bindgen]
pub fn surface_style(key: &str) -> Vec<f64> {
    let s = craftyap_core::surface::style(craftyap_core::surface::family_of(key));
    vec![s.roughness, s.metalness, s.normal, s.clearcoat]
}

/// The water surface (`water_mesh.rs`, a port of waterGeometry.ts `buildWaterGeometry`) over a
/// 160 × 56 × 160 grid (`cells`, the VoxelWorld layout, waterlogged shapes already handed over AS
/// their water) and the column beyond it (`outside`, empty = air). Returns one Float32Array:
/// [vertex count, index count, position (3n), normal (3n), wave, wet, foam, depth (n each),
/// flow (3n), impact (3n), grid (4n), indices]; [0, 0] when nothing is drawn, [-1, 0] when the
/// TypeScript would throw. `profile` (same layout as `cells`, or empty): the top of each shaped
/// block holding water (waterlog.ts `shapeProfile`).
#[wasm_bindgen]
pub fn water_mesh(cells: &[u8], outside: &[u8], list: &[i32], profile: &[u8]) -> Vec<f32> {
    use craftyap_core::water_mesh::build_water_mesh_shaped;
    use craftyap_core::world::{WORLD_X, WORLD_Y, WORLD_Z};
    let get = |x: i32, y: i32, z: i32| -> u8 {
        if !(0..WORLD_Y).contains(&y) {
            return 0;
        }
        if (0..WORLD_X).contains(&x) && (0..WORLD_Z).contains(&z) {
            return cells.get(((y * WORLD_Z + z) * WORLD_X + x) as usize).copied().unwrap_or(0);
        }
        outside.get(y as usize).copied().unwrap_or(0)
    };
    let points: Vec<[i32; 3]> = list.as_chunks::<3>().0.to_vec();
    let top = |x: i32, y: i32, z: i32| -> u8 {
        if (0..WORLD_Y).contains(&y) && (0..WORLD_X).contains(&x) && (0..WORLD_Z).contains(&z) {
            return profile.get(((y * WORLD_Z + z) * WORLD_X + x) as usize).copied().unwrap_or(0);
        }
        0
    };
    match build_water_mesh_shaped(&get, &top, &points) {
        Err(_) => vec![-1.0, 0.0],
        Ok(None) => vec![0.0, 0.0],
        Ok(Some(m)) => {
            let mut out = vec![(m.position.len() / 3) as f32, m.indices.len() as f32];
            for part in [&m.position, &m.normal, &m.wave, &m.wet, &m.foam, &m.depth, &m.flow, &m.impact, &m.grid] {
                out.extend_from_slice(part);
            }
            out.extend(m.indices.iter().map(|&i| i as f32));
            out
        }
    }
}
