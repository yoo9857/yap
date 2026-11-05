//! One chunk's scan for the block renderer: a line-for-line port of `VoxelView.scanChunk`
//! (`apps/client/src/craft/voxelView.ts`). It walks the chunk's cells once and emits what the
//! meshes are built from: the near form's cell lists per (block, shape) and its seam backing, or
//! the far form's face-culled triangles per material; plus studs, water cells and the top.
//! `apps/client/test/rust-scan.test.ts` builds whole views both ways and compares every mesh.
//!
//! The host hands over a SLAB: the chunk plus a one-cell ring, every height, with the raw block
//! (`world.get`, so the field's ground beyond the window is in it), the shape (0 beyond the window,
//! like `getShape`) and the hidden flag (`isMiningHidden`) of each cell. Above and below the world
//! is air. Everything JS-specific (block catalog, face tables, far templates, orientations) comes
//! from the host once, as tables.

use rustc_hash::FxHashMap;

pub struct Face {
    pub n: [f64; 3],
    pub u: [f64; 3],
    pub v: [f64; 3],
    pub o: [f64; 3],
}

/// A far-form template (a non-indexed geometry: positions, normals, uvs as float32 values).
pub struct Template {
    pub pos: Vec<f64>,
    pub nrm: Vec<f64>,
    pub uv: Option<Vec<f64>>,
}

pub struct Tables {
    pub solid: [bool; 256],
    pub full_cube: [bool; 256],
    pub see_through: [bool; 256],
    /// bit 0: the block exists (`blockById`), bit 1: `noStud`, bit 2: grass/flower-grass.
    pub def: [u8; 256],
    pub dirt: u8,
    pub kit_cube: u8,
    pub round: u8,
    pub faces: Vec<Face>,
    pub face_corners: [(f64, f64); 6],
    pub face_uv: [f64; 12],
    pub backing_inset: f64,
    /// `faceMaterialIndices` per block id (1 = one material, 3 = top/side/bottom); empty = none.
    pub materials: Vec<Vec<i32>>,
    /// Far template per shape code: index into `templates`.
    pub family: [u8; 256],
    pub templates: Vec<Template>,
    /// `brickOrientation(...)` per shape code (identity for shapes that do not turn): x, y, z, w.
    pub quats: Vec<[f64; 4]>,
    pub world_y: i32,
}

pub struct Slab<'a> {
    pub x0: i32,
    pub z0: i32,
    pub w: i32,
    pub d: i32,
    pub cells: &'a [u8],
    pub shapes: &'a [u8],
    pub hidden: &'a [u8],
}

/// Float32 buffers grown like the view's `Floats`.
#[derive(Default)]
pub struct FarBuffer {
    pub pos: Vec<f32>,
    pub nrm: Vec<f32>,
    pub uv: Vec<f32>,
}

/// An insertion-ordered map, like a JS `Map`.
pub struct Ordered<T> {
    pub keys: Vec<i32>,
    pub values: Vec<T>,
    index: FxHashMap<i32, usize>,
}
impl<T: Default> Ordered<T> {
    fn new() -> Self {
        Self { keys: Vec::new(), values: Vec::new(), index: FxHashMap::default() }
    }
    fn get(&mut self, k: i32) -> &mut T {
        let i = match self.index.get(&k) {
            Some(&i) => i,
            None => {
                self.keys.push(k);
                self.values.push(T::default());
                self.index.insert(k, self.values.len() - 1);
                self.values.len() - 1
            }
        };
        &mut self.values[i]
    }
}

pub struct ScanOut {
    pub top: i32,
    pub water: Vec<i32>,
    pub studs: Ordered<Vec<i32>>,
    pub near: Ordered<Vec<i32>>,
    pub backing: Vec<f32>,
    pub far: Ordered<FarBuffer>,
}

impl Slab<'_> {
    #[inline]
    fn at(&self, x: i32, y: i32, z: i32, world_y: i32) -> Option<usize> {
        let (lx, lz) = (x - self.x0, z - self.z0);
        if y < 0 || y >= world_y {
            return None;
        }
        debug_assert!(lx >= 0 && lz >= 0 && lx < self.w && lz < self.d, "slab read outside its ring");
        Some(((y * self.d + lz) * self.w + lx) as usize)
    }
}

/// `scanChunk` for the cells x0 ≤ x < x1, z0 ≤ z < z1 (grid coordinates). Err = a block with no
/// materials reached the far form (the TypeScript throws there too).
#[allow(clippy::too_many_arguments)]
pub fn scan(t: &Tables, s: &Slab, x0: i32, z0: i32, x1: i32, z1: i32, far: bool) -> Result<ScanOut, &'static str> {
    let wy = t.world_y;
    let block_at = |x: i32, y: i32, z: i32| -> u8 { s.at(x, y, z, wy).map_or(0, |i| s.cells[i]) };
    let hidden_at = |x: i32, y: i32, z: i32| -> bool { s.at(x, y, z, wy).is_some_and(|i| s.hidden[i] != 0) };
    // `occludes` / `opaque`: a visible, solid, opaque full cube
    let occludes = |x: i32, y: i32, z: i32| -> bool {
        match s.at(x, y, z, wy) {
            None => false,
            Some(i) => {
                let block = s.cells[i];
                s.hidden[i] == 0 && t.solid[block as usize] && t.full_cube[s.shapes[i] as usize] && !t.see_through[block as usize]
            }
        }
    };
    let mut out = ScanOut { top: 0, water: Vec::new(), studs: Ordered::new(), near: Ordered::new(), backing: Vec::new(), far: Ordered::new() };
    let mut top = 0;
    let bi = t.backing_inset;
    for y in 0..wy {
        for z in z0..z1 {
            for x in x0..x1 {
                let i = s.at(x, y, z, wy).unwrap();
                if s.hidden[i] != 0 {
                    continue;
                }
                let mut block = s.cells[i];
                if !t.solid[block as usize] {
                    if block != 0 {
                        out.water.extend_from_slice(&[x, y, z]);
                    }
                    continue;
                }
                let exposed = !occludes(x - 1, y, z) || !occludes(x + 1, y, z) || !occludes(x, y - 1, z) || !occludes(x, y + 1, z) || !occludes(x, y, z - 1) || !occludes(x, y, z + 1);
                if !exposed {
                    continue;
                }
                top = y;
                let shape = s.shapes[i];
                let mut def = t.def[block as usize];
                if def & 1 != 0 && def & 4 != 0 && occludes(x, y + 1, z) {
                    block = t.dirt;
                    def = t.def[block as usize];
                }
                let air_above = hidden_at(x, y + 1, z) || !t.solid[block_at(x, y + 1, z) as usize];
                if def & 1 != 0 && def & 2 == 0 && (t.full_cube[shape as usize] || shape == t.round) && air_above {
                    let key = ((block as i32) << 1) | if shape == t.kit_cube || shape == t.round { 1 } else { 0 };
                    out.studs.get(key).extend_from_slice(&[x, y, z]);
                }
                if !far {
                    let key = ((block as i32) << 8) | shape as i32;
                    out.near.get(key).extend_from_slice(&[x, y, z]);
                    if t.full_cube[shape as usize] && !t.see_through[block as usize] {
                        let (fx, fy, fz) = (x as f64, y as f64, z as f64);
                        for face in &t.faces {
                            let (nx, ny, nz) = (face.n[0], face.n[1], face.n[2]);
                            let (inx, iny, inz) = (nx as i32, ny as i32, nz as i32);
                            if occludes(x + inx, y + iny, z + inz) {
                                continue;
                            }
                            let edge = |d: [f64; 3]| -> f64 {
                                let (dx, dy, dz) = (d[0] as i32, d[1] as i32, d[2] as i32);
                                if !occludes(x + dx, y + dy, z + dz) {
                                    bi
                                } else if occludes(x + dx + inx, y + dy + iny, z + dz + inz) {
                                    -bi
                                } else {
                                    0.0
                                }
                            };
                            let (u, v) = (face.u, face.v);
                            let u0 = edge([-u[0], -u[1], -u[2]]);
                            let u1 = edge(u);
                            let v0 = edge([-v[0], -v[1], -v[2]]);
                            let v1 = edge(v);
                            for &(cu, cv) in &t.face_corners {
                                let a = if cu != 0.0 { 1.0 - u1 } else { u0 };
                                let b = if cv != 0.0 { 1.0 - v1 } else { v0 };
                                out.backing.push((fx + face.o[0] + u[0] * a + v[0] * b - nx * bi) as f32);
                                out.backing.push((fy + face.o[1] + u[1] * a + v[1] * b - ny * bi) as f32);
                                out.backing.push((fz + face.o[2] + u[2] * a + v[2] * b - nz * bi) as f32);
                            }
                        }
                    }
                    continue;
                }
                let mats = &t.materials[block as usize];
                if mats.is_empty() {
                    return Err("a block without materials");
                }
                let band = |ny: f64| -> i32 {
                    if mats.len() > 1 {
                        mats[if ny > 0.52 {
                            0
                        } else if ny < -0.52 {
                            2
                        } else {
                            1
                        }]
                    } else {
                        mats[0]
                    }
                };
                if t.full_cube[shape as usize] {
                    let (fx, fy, fz) = (x as f64, y as f64, z as f64);
                    for face in &t.faces {
                        let index = band(face.n[1]);
                        out.far.get(index); // created even when the face is culled, like farBuffer()
                        let (inx, iny, inz) = (face.n[0] as i32, face.n[1] as i32, face.n[2] as i32);
                        if occludes(x + inx, y + iny, z + inz) {
                            continue;
                        }
                        if t.see_through[block as usize] && block_at(x + inx, y + iny, z + inz) == block {
                            continue;
                        }
                        let buf = out.far.get(index);
                        for k in 0..6 {
                            let (cu, cv) = t.face_corners[k];
                            buf.pos.push((fx + face.o[0] + face.u[0] * cu + face.v[0] * cv) as f32);
                            buf.pos.push((fy + face.o[1] + face.u[1] * cu + face.v[1] * cv) as f32);
                            buf.pos.push((fz + face.o[2] + face.u[2] * cu + face.v[2] * cv) as f32);
                            buf.nrm.push(face.n[0] as f32);
                            buf.nrm.push(face.n[1] as f32);
                            buf.nrm.push(face.n[2] as f32);
                            buf.uv.push(t.face_uv[k * 2] as f32);
                            buf.uv.push(t.face_uv[k * 2 + 1] as f32);
                        }
                    }
                } else {
                    // bakeShape
                    let geo = &t.templates[t.family[shape as usize] as usize];
                    let q = t.quats[shape as usize];
                    let count = geo.pos.len() / 3;
                    let mut index = band(0.0);
                    out.far.get(index);
                    for k in 0..count {
                        if k % 3 == 0 {
                            let n = apply_quaternion([geo.nrm[k * 3], geo.nrm[k * 3 + 1], geo.nrm[k * 3 + 2]], q);
                            index = band(n[1]);
                        }
                        let p = apply_quaternion([geo.pos[k * 3], geo.pos[k * 3 + 1], geo.pos[k * 3 + 2]], q);
                        let n = apply_quaternion([geo.nrm[k * 3], geo.nrm[k * 3 + 1], geo.nrm[k * 3 + 2]], q);
                        let buf = out.far.get(index);
                        buf.pos.push((p[0] + x as f64 + 0.5) as f32);
                        buf.pos.push((p[1] + y as f64 + 0.5) as f32);
                        buf.pos.push((p[2] + z as f64 + 0.5) as f32);
                        buf.nrm.push(n[0] as f32);
                        buf.nrm.push(n[1] as f32);
                        buf.nrm.push(n[2] as f32);
                        match &geo.uv {
                            Some(uv) => {
                                buf.uv.push(uv[k * 2] as f32);
                                buf.uv.push(uv[k * 2 + 1] as f32);
                            }
                            None => {
                                buf.uv.push(0.0);
                                buf.uv.push(0.0);
                            }
                        }
                    }
                }
            }
        }
    }
    out.top = top;
    Ok(out)
}

/// three's `Vector3.applyQuaternion`.
#[inline]
fn apply_quaternion(v: [f64; 3], q: [f64; 4]) -> [f64; 3] {
    let (vx, vy, vz) = (v[0], v[1], v[2]);
    let (qx, qy, qz, qw) = (q[0], q[1], q[2], q[3]);
    let tx = 2.0 * (qy * vz - qz * vy);
    let ty = 2.0 * (qz * vx - qx * vz);
    let tz = 2.0 * (qx * vy - qy * vx);
    [vx + qw * tx + qy * tz - qz * ty, vy + qw * ty + qz * tx - qx * tz, vz + qw * tz + qx * ty - qy * tx]
}
