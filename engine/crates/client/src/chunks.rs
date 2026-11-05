//! The world's chunks as triangles, built off the main thread.
//!
//! Each 16×16 column of the 160×160 world is scanned by the core (`scan.rs`, the web's
//! `scanChunk`) on a SLAB: the chunk plus a one-cell ring at every height. Its near form joins each
//! block's full cubes into one shell (`kit.rs`, the web's `kitCellsGeometry`). Its far form is the
//! scan's face-culled faces. Colours come from the block catalog, by face band (top / side /
//! bottom) like the web's per-face materials.
//!
//! A `Mesher` pool owns the jobs: the frame loop sends (chunk, form) requests (nearest first) and
//! picks up the finished vertex lists, so a chunk never stalls a frame. Workers take jobs from one
//! shared queue in order, so nearest-first holds; a worker that panics is logged and the others
//! carry on (its chunk stays unbuilt, the far form or nothing is drawn there).

use crate::looks::band_look;
use crate::scene::{StudInstance, Vertex};
use craftyap_core::blocks_gen::{BLOCKS, FULL_CUBE, KIT_CUBE, ROUND, SOLID};
use craftyap_core::kit::{kit_cells_geometry, JoinMask};
use craftyap_core::scan::{scan, Face, Slab, Tables, Template};
use craftyap_core::world::{World, WORLD_X, WORLD_Y, WORLD_Z};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

pub const CHUNK: i32 = 16;
pub const CHUNKS_X: i32 = WORLD_X / CHUNK;
pub const CHUNKS_Z: i32 = WORLD_Z / CHUNK;

/// `isFullCubeShape` (generated from @robo/shared).
fn full_cube(shape: u8) -> bool {
    FULL_CUBE[shape as usize]
}

/// The view's face table, built like voxelView.ts's FACES.
fn faces() -> Vec<Face> {
    let ns: [[f64; 3]; 6] = [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]];
    ns.iter()
        .map(|&n| {
            let v = if n[1] == 1.0 { [0.0, 0.0, -1.0] } else if n[1] == -1.0 { [0.0, 0.0, 1.0] } else { [0.0, 1.0, 0.0] };
            let u = [v[1] * n[2] - v[2] * n[1], v[2] * n[0] - v[0] * n[2], v[0] * n[1] - v[1] * n[0]];
            let o = [0, 1, 2].map(|k| 0.5 + n[k] * 0.5 - u[k] * 0.5 - v[k] * 0.5);
            Face { n, u, v, o }
        })
        .collect()
}

/// Scan tables for the native client: material index = block id × 3 + face band.
pub fn tables() -> Tables {
    let mut see_through = [false; 256];
    let mut def = [0u8; 256];
    let mut materials = vec![Vec::new(); 256];
    for b in BLOCKS {
        let i = b.id as usize;
        see_through[i] = b.see_through;
        def[i] = 1 | if b.no_stud { 2 } else { 0 } | if b.key == "grass" || b.key == "flower-grass" { 4 } else { 0 };
        materials[i] = (0..3).map(|band| b.id as i32 * 3 + band).collect();
    }
    let mut full = [false; 256];
    for (s, f) in full.iter_mut().enumerate() {
        *f = full_cube(s as u8);
    }
    Tables {
        solid: SOLID,
        full_cube: full,
        see_through,
        def,
        dirt: craftyap_core::world::id("dirt"),
        kit_cube: KIT_CUBE,
        round: ROUND,
        faces: faces(),
        face_corners: [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 0.0), (1.0, 1.0), (0.0, 1.0)],
        face_uv: [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0],
        backing_inset: 0.035,
        materials,
        family: [0; 256],
        // shaped bricks arrive with placing (N3); until then their far form is empty
        templates: vec![Template { pos: Vec::new(), nrm: Vec::new(), uv: None }],
        quats: vec![[0.0, 0.0, 0.0, 1.0]; 256],
        world_y: WORLD_Y,
    }
}

/// An sRGB tint multiplied by a linear shade (three: material colour x vertex colour), back in sRGB.
fn shade(tint: [u8; 3], col: [f32; 3]) -> [u8; 3] {
    let lin = |c: u8| {
        let c = c as f32 / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let srgb = |l: f32| {
        let l = l.clamp(0.0, 1.0);
        let c = if l <= 0.0031308 { l * 12.92 } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 };
        (c * 255.0).round() as u8
    };
    [0, 1, 2].map(|i| srgb(lin(tint[i]) * col[i]))
}

fn band_of(ny: f32) -> usize {
    if ny > 0.52 {
        0
    } else if ny < -0.52 {
        2
    } else {
        1
    }
}

/// Whether a block is see-through (glass, ice): drawn in the blended pass, like the web's
/// `transparent` materials (opacity `CLEAR_OPACITY`).
fn is_clear(block: u8) -> bool {
    BLOCKS.iter().any(|b| b.id == block && b.see_through)
}

/// A chunk form's triangles, split by pass.
#[derive(Default)]
pub struct Meshed {
    pub opaque: Vec<Vertex>,
    /// See-through blocks, drawn blended after every opaque chunk.
    pub clear: Vec<Vertex>,
    /// Brick tops that carry studs (the far scan only: every chunk has a far form, and studs are
    /// drawn by distance to the focus, not by LOD form).
    pub studs: Vec<StudInstance>,
    /// The water surface (with the far form, like the studs: water does not change with LOD).
    pub water: Vec<crate::water::WaterVertex>,
}

impl Meshed {
    fn list(&mut self, block: u8) -> &mut Vec<Vertex> {
        if is_clear(block) { &mut self.clear } else { &mut self.opaque }
    }
}

/// One chunk's triangles, near (joined shells) or far (culled faces).
pub fn mesh_chunk(world: &World, tables: &Tables, cx: i32, cz: i32, far: bool) -> Meshed {
    let (x0, z0) = (cx * CHUNK, cz * CHUNK);
    let (x1, z1) = ((x0 + CHUNK).min(WORLD_X), (z0 + CHUNK).min(WORLD_Z));
    let (sx0, sz0, sw, sd) = (x0 - 1, z0 - 1, x1 - x0 + 2, z1 - z0 + 2);
    let n = (sw * sd * WORLD_Y) as usize;
    let (mut cells, mut shapes) = (vec![0u8; n], vec![0u8; n]);
    let hidden = vec![0u8; n];
    let mut i = 0;
    for y in 0..WORLD_Y {
        for z in sz0..sz0 + sd {
            for x in sx0..sx0 + sw {
                cells[i] = world.get(x, y, z);
                shapes[i] = world.get_shape(x, y, z);
                i += 1;
            }
        }
    }
    let slab = Slab { x0: sx0, z0: sz0, w: sw, d: sd, cells: &cells, shapes: &shapes, hidden: &hidden };
    let out = match scan(tables, &slab, x0, z0, x1, z1, far) {
        Ok(o) => o,
        Err(e) => {
            log::error!("chunk {cx},{cz}: {e}");
            return Meshed::default();
        }
    };
    let mut meshed = Meshed::default();
    if far {
        // key = block << 1 | style; style 1 (kit cube / round: the kit connector) shares the
        // cylinder studs until shaped and placed bricks arrive (N3)
        for (key, list) in out.studs.keys.iter().zip(&out.studs.values) {
            let (tint, layer) = band_look((*key >> 1) as u8, 0);
            let look = [tint[0], tint[1], tint[2], layer];
            for c in list.as_chunks::<3>().0 {
                meshed.studs.push(StudInstance { pos: [c[0] as f32 + 0.5, c[1] as f32 + 1.0, c[2] as f32 + 0.5], look });
            }
        }
        for (index, buf) in out.far.keys.iter().zip(&out.far.values) {
            let (tint, layer) = band_look((*index / 3) as u8, (*index % 3) as usize);
            let verts = meshed.list((*index / 3) as u8);
            for k in 0..buf.pos.len() / 3 {
                verts.push(Vertex::new([buf.pos[k * 3], buf.pos[k * 3 + 1], buf.pos[k * 3 + 2]], [buf.nrm[k * 3], buf.nrm[k * 3 + 1], buf.nrm[k * 3 + 2]], tint, layer, [buf.uv[k * 2], buf.uv[k * 2 + 1]]));
            }
        }
        // the water rides with the far form (it does not change with LOD)
        meshed.water = crate::water::mesh_water(world, cx, cz);
        return meshed;
    }
    // joined: a solid full cube (any block) — the shell runs on into it without an inset
    let sy = WORLD_Y + 2;
    let mut joined = vec![0u8; (sw * sy * sd) as usize];
    for y in 0..WORLD_Y {
        for lz in 0..sd {
            for lx in 0..sw {
                let s = ((y * sd + lz) * sw + lx) as usize;
                if SOLID[cells[s] as usize] && full_cube(shapes[s]) {
                    joined[(((y + 1) * sd + lz) * sw + lx) as usize] = 1;
                }
            }
        }
    }
    let mask = JoinMask { x0: sx0, y0: -1, z0: sz0, sx: sw, sy, sz: sd, cells: &joined, missed: Default::default() };
    for (key, list) in out.near.keys.iter().zip(&out.near.values) {
        let (block, shape) = ((key >> 8) as u8, (key & 0xff) as u8);
        if !full_cube(shape) {
            continue; // shaped bricks: N3
        }
        let cells: Vec<(i32, i32, i32)> = list.as_chunks::<3>().0.iter().map(|c| (c[0], c[1], c[2])).collect();
        match kit_cells_geometry(&cells, &mask) {
            Ok(g) => {
                let verts = meshed.list(block);
                for k in 0..g.pos.len() / 3 {
                    let nrm = [g.nrm[k * 3], g.nrm[k * 3 + 1], g.nrm[k * 3 + 2]];
                    let (tint, layer) = band_look(block, band_of(nrm[1]));
                    // the shell's own shading (kitShell's colour attribute, which the web's
                    // vertexColors multiply in): folded into the tint in linear light
                    let tint = shade(tint, [g.col[k * 3], g.col[k * 3 + 1], g.col[k * 3 + 2]]);
                    verts.push(Vertex::new([g.pos[k * 3], g.pos[k * 3 + 1], g.pos[k * 3 + 2]], nrm, tint, layer, [g.uv[k * 2], g.uv[k * 2 + 1]]));
                }
            }
            Err(e) => log::error!("chunk {cx},{cz} block {block}: {e}"),
        }
    }
    if mask.missed.get() != 0 {
        log::warn!("chunk {cx},{cz}: {} joined lookups outside the slab", mask.missed.get());
    }
    meshed
}

/// A finished chunk form, with the stamp of the request it answers.
pub struct Built {
    pub cx: i32,
    pub cz: i32,
    pub far: bool,
    pub stamp: u64,
    pub mesh: Meshed,
}

/// One request: the world snapshot to mesh (the world changes — edits, a field scroll, another
/// mode — so every job carries the one it was asked about) and a stamp to drop stale answers.
struct Job {
    world: Arc<World>,
    cx: i32,
    cz: i32,
    far: bool,
    stamp: u64,
}

/// The meshing workers: requests in, finished chunks out. Dropping it ends the threads.
pub struct Mesher {
    jobs: Option<Sender<Job>>,
    done: Receiver<Built>,
}

impl Default for Mesher {
    fn default() -> Self {
        Self::new()
    }
}

impl Mesher {
    pub fn new() -> Self {
        let (jobs, rx) = channel::<Job>();
        let (tx, done) = channel();
        let rx = Arc::new(Mutex::new(rx));
        let tables = Arc::new(tables());
        // leave a core for the frame loop; phones have 4–8, a pool past 4 only fights the GPU driver
        let workers = std::thread::available_parallelism().map_or(1, |n| n.get().saturating_sub(1)).clamp(1, 4);
        for k in 0..workers {
            let (tables, rx, tx) = (tables.clone(), rx.clone(), tx.clone());
            let spawned = std::thread::Builder::new().name(format!("mesher-{k}")).spawn(move || loop {
                // a poisoned lock means another worker panicked mid-recv: the queue itself is fine
                let job = rx.lock().unwrap_or_else(|p| p.into_inner()).recv();
                let Ok(Job { world, cx, cz, far, stamp }) = job else { break }; // the app is gone
                let mesh = mesh_chunk(&world, &tables, cx, cz, far);
                drop(world); // release the snapshot before the send: the next edit need not copy it
                if tx.send(Built { cx, cz, far, stamp, mesh }).is_err() {
                    break;
                }
            });
            if let Err(e) = spawned {
                log::error!("cannot start mesher worker {k}: {e}");
            }
        }
        Self { jobs: Some(jobs), done }
    }
    pub fn request(&self, world: &Arc<World>, cx: i32, cz: i32, far: bool, stamp: u64) {
        if let Some(j) = &self.jobs {
            let _ = j.send(Job { world: world.clone(), cx, cz, far, stamp });
        }
    }
    pub fn finished(&self) -> impl Iterator<Item = Built> + '_ {
        self.done.try_iter()
    }
}

impl Drop for Mesher {
    fn drop(&mut self) {
        self.jobs = None; // closes the channel: the thread's recv fails and it returns
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_far_form_carries_the_water_and_the_near_form_does_not() {
        let mut w = craftyap_core::world::generate_field();
        for x in 34..38 {
            for z in 34..38 {
                w.set(x, 4, z, 19);
            }
        }
        let t = tables();
        assert!(!mesh_chunk(&w, &t, 2, 2, true).water.is_empty(), "far form: water surface");
        assert!(mesh_chunk(&w, &t, 2, 2, false).water.is_empty(), "near form: none (it would draw twice)");
    }

    #[test]
    fn faces_match_the_web_table() {
        // voxelView.ts FACES[0] (+x): u = (0,0,-1), v = (0,1,0), o = (1,0,1)
        let f = &faces()[0];
        assert_eq!(f.u, [0.0, 0.0, -1.0]);
        assert_eq!(f.v, [0.0, 1.0, 0.0]);
        assert_eq!(f.o, [1.0, 0.0, 1.0]);
        // top: v = (0,0,-1), u = (1,0,0) → o = (0,1,1)
        let t = &faces()[2];
        assert_eq!(t.u, [1.0, 0.0, 0.0]);
        assert_eq!(t.o, [0.0, 1.0, 1.0]);
    }

    #[test]
    fn island_chunks_mesh_both_forms_with_no_lookup_outside_the_slab() {
        let w = craftyap_core::world::generate_island(12345.0);
        let t = tables();
        let near = mesh_chunk(&w, &t, 2, 2, false).opaque;
        let far = mesh_chunk(&w, &t, 2, 2, true).opaque;
        assert!(near.len() > 1000 && far.len() > 100, "{} {}", near.len(), far.len());
        assert_eq!(near.len() % 3, 0);
        assert_eq!(far.len() % 3, 0);
    }

    #[test]
    fn studs_cap_open_brick_tops_only() {
        let w = craftyap_core::world::generate_island(crate::scene::ISLAND_SEED);
        let t = tables();
        let m = mesh_chunk(&w, &t, 2, 2, true);
        assert!(!m.studs.is_empty());
        for s in &m.studs {
            let (x, y, z) = (s.pos[0].floor() as i32, s.pos[1] as i32 - 1, s.pos[2].floor() as i32);
            assert!(SOLID[w.get(x, y, z) as usize], "a stud on a solid brick");
            assert!(!SOLID[w.get(x, y + 1, z) as usize], "with air above it");
        }
        // the near form carries none (they come with the far one)
        assert!(mesh_chunk(&w, &t, 2, 2, false).studs.is_empty());
    }

    #[test]
    fn see_through_blocks_go_to_the_clear_pass() {
        // the castle's windows are glass: find a chunk with some, both forms split them out
        let w = craftyap_core::world::generate_island(crate::scene::ISLAND_SEED);
        let t = tables();
        let glass = craftyap_core::world::id("glass");
        let chunk = (0..CHUNKS_X * CHUNKS_Z)
            .map(|i| (i % CHUNKS_X, i / CHUNKS_X))
            .find(|&(cx, cz)| (0..WORLD_Y).any(|y| (0..CHUNK).any(|dz| (0..CHUNK).any(|dx| w.get(cx * CHUNK + dx, y, cz * CHUNK + dz) == glass))))
            .expect("the island has glass");
        for far in [false, true] {
            let m = mesh_chunk(&w, &t, chunk.0, chunk.1, far);
            assert!(!m.clear.is_empty() && m.clear.len().is_multiple_of(3), "far={far}");
        }
        assert!(is_clear(glass) && is_clear(craftyap_core::world::id("ice")) && !is_clear(craftyap_core::world::id("stone")));
    }
}
