//! The water surface (component-aware surface nets on the voxel-centre lattice, plus water in the
//! air as films and streams; rules and reasons in docs/WATER.md). THE mesher: the web calls it
//! through WASM (`apps/client/src/craft/waterMesher.ts`), the app directly. It began as a
//! line-for-line port of the web's `waterGeometry.ts`, which was deleted on 2026-11-12 — comments
//! naming that file refer to the original (git history). Checked by the client's `water*.test.ts`
//! on the committed WASM build.

use crate::blocks_gen::SOLID;
use crate::body::water_height;
use crate::fluid::{is_water, water_level, WATER, WATER_FALLING};

/// How far a sheet of running water reaches from the face it runs down (m).
const SHEET: f64 = 0.09;
/// Half the width of a fall in the open: a stream, not a cell-sized box (waterGeometry.ts `FALL`).
const FALL: f64 = 0.3;
/// How high a lip stands: a film over the edge (waterGeometry.ts `LIP`).
const LIP: f64 = 0.2;
/// How far a fall's foot is pulled from the rounded average to the line where it meets the water below.
const JOIN: f64 = 0.8;
/// The same for running water's own foot (its height is exact).
const FOOT: f64 = 1.0;
/// How square the rim of a lip is (0 = the rounded average, 1 = a hard edge).
const RIM: f64 = 0.3;
/// How deep water lies over a shaped block it runs across (m).
const FILM: f64 = 0.22;
/// Water in the air (`streams`): a film lies FILM_NEAR‒FILM_FAR from the face it runs down, a lip
/// ends LIP_FAR from the edge it went over; its collar reaches LIP_BACK back over that edge and
/// LIP_TOP above it, into the lying water's rim.
const FILM_NEAR: f64 = 0.012;
const FILM_FAR: f64 = 0.075;
const LIP_FAR: f64 = 0.11;
const LIP_BACK: f64 = 0.03;
const LIP_TOP: f64 = 0.045;
/// x0, x1, z0, z1, then how far each corner is rounded: (x0,z0), (x1,z0), (x1,z1), (x0,z1).
type Outline = [f64; 8];
/// The eight points of an outline: which x (0/1, -1 = the middle), which z (2/3, -1), the outward
/// direction, and for a corner its roundness slot.
const RING: [[i32; 5]; 8] = [[0, 2, -1, -1, 4], [-1, 2, 0, -1, -1], [1, 2, 1, -1, 5], [1, -1, 1, 0, -1], [1, 3, 1, 1, 6], [-1, 3, 0, 1, -1], [0, 3, -1, 1, 7], [0, -1, -1, 0, -1]];
use crate::kit::{js_hypot, js_hypot_n};
use rustc_hash::FxHashMap;

type V3 = [f64; 3];

#[derive(Clone, Debug)]
struct Node {
    id: i64,
    p: V3,
    n: V3,
    grid: [f64; 4],
    wave: f64,
    wet: f64,
    foam: f64,
    depth: f64,
    flow: V3,
    impact: V3,
    crowded: bool,
}

/// The mesh (three's attribute layout): per vertex position, normal, wave, wet, foam, depth, flow,
/// impact (weighted by its strength), grid (4); and the triangle indices.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct WaterMesh {
    pub position: Vec<f32>,
    pub normal: Vec<f32>,
    pub wave: Vec<f32>,
    pub wet: Vec<f32>,
    pub foam: Vec<f32>,
    pub depth: Vec<f32>,
    pub flow: Vec<f32>,
    pub impact: Vec<f32>,
    pub grid: Vec<f32>,
    pub indices: Vec<u32>,
    /// The simple water's faces against BLOCKS (never drawn: `wet` is -1 on their vertices). With
    /// them the water is a closed volume, so a ray's crossings can be counted: one more way out
    /// than in means the eye is in the water (the web's count pass, render/waterPipeline.ts).
    pub closure: Vec<u32>,
}

const CORNERS: [[i32; 3]; 8] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];

struct Tables {
    edges: Vec<(usize, usize, usize)>,
    /// per cube face: its four corners and four edges (in the TypeScript's order)
    faces: Vec<([usize; 4], [usize; 4])>,
}

fn tables() -> &'static Tables {
    static T: std::sync::OnceLock<Tables> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        let mut edges = Vec::new();
        for i in 0..8usize {
            for axis in 0..3usize {
                if i & (1 << axis) == 0 {
                    edges.push((i, i | 1 << axis, axis));
                }
            }
        }
        let faces = (0..6usize)
            .map(|i| {
                let (axis, side) = (i >> 1, i & 1);
                let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
                let corners = [side << axis, side << axis | 1 << u, side << axis | 1 << u | 1 << v, side << axis | 1 << v];
                let mut fe = [0usize; 4];
                for (j, &a) in corners.iter().enumerate() {
                    let b = corners[(j + 1) % 4];
                    fe[j] = edges.iter().position(|&(x, y, _)| (x == a && y == b) || (y == a && x == b)).unwrap_or(usize::MAX);
                }
                (corners, fe)
            })
            .collect();
        Tables { edges, faces }
    })
}

const HORIZONTAL: [[i32; 3]; 4] = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

fn cell_key(x: i32, y: i32, z: i32) -> i64 {
    ((y as i64 + 2) * 164 + z as i64 + 2) * 164 + x as i64 + 2
}

fn normalize(n: V3) -> V3 {
    let k = js_hypot_n(&n);
    if k > 0.00001 {
        [n[0] / k, n[1] / k, n[2] / k]
    } else {
        [0.0, 1.0, 0.0]
    }
}

fn lerp3(a: V3, b: V3, t: f64) -> V3 {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[derive(Clone, Copy)]
struct Sample {
    depth: f64,
    fx: f64,
    fz: f64,
    fall: f64,
    impact: bool,
}

struct Builder<'a, G: Fn(i32, i32, i32) -> u8> {
    get: &'a G,
    /// The top of a shaped block holding water, per corner (waterlog.ts `shapeProfile`); 0 = none.
    profile: &'a dyn Fn(i32, i32, i32) -> u8,
    nodes: Vec<Node>,
    sequence: i64,
    /// cube key → 64 slots of node indices
    cache: FxHashMap<i64, Box<[Option<usize>; 64]>>,
    edge_cache: FxHashMap<i64, Option<usize>>,
    depth_cache: FxHashMap<i64, f64>,
    sheet_cache: FxHashMap<i64, u8>,
    sample_cache: FxHashMap<i64, Sample>,
    vertex: FxHashMap<usize, u32>,
    out: WaterMesh,
    /// Water in the air drawn apart from the lattice (waterGeometry.ts `drawWaterAsStreams`).
    streams: bool,
    lat_cache: std::cell::RefCell<FxHashMap<i64, u8>>,
    origin_cache: FxHashMap<i64, i32>,
    serial: u32,
}

impl<G: Fn(i32, i32, i32) -> u8> Builder<'_, G> {
    /// What the lattice sees (waterGeometry.ts `world`): the cells as they are, or `lat` with streams on.
    fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        if self.streams {
            self.lat(x, y, z)
        } else {
            (self.get)(x, y, z)
        }
    }
    /// The cells as they are (waterGeometry.ts `source.get`).
    fn raw(&self, x: i32, y: i32, z: i32) -> u8 {
        (self.get)(x, y, z)
    }
    /// Water in the air (waterGeometry.ts `loose`).
    fn loose(&self, x: i32, y: i32, z: i32, id: u8) -> bool {
        if !self.streams || !is_water(id) || id > WATER_FALLING {
            return false;
        }
        let below = self.raw(x, y - 1, z);
        (below == 0 || below == WATER_FALLING || id == WATER_FALLING && is_water(below)) && (self.profile)(x, y, z) == 0
    }
    /// waterGeometry.ts `lat`: no water in the air; a landed fall and a spring that all runs off as lying water.
    fn lat(&self, x: i32, y: i32, z: i32) -> u8 {
        let id = self.raw(x, y, z);
        if id != WATER_FALLING && id != WATER {
            return if self.loose(x, y, z, id) { 0 } else { id };
        }
        let key = cell_key(x, y, z);
        if let Some(&v) = self.lat_cache.borrow().get(&key) {
            return v;
        }
        let mut result = id;
        if self.loose(x, y, z, id) {
            result = 0;
        } else {
            let (mut lying, mut running) = (0, 0);
            for [sx, _, sz] in HORIZONTAL {
                let n = self.raw(x + sx, y, z + sz);
                if !is_water(n) {
                    continue;
                }
                if self.loose(x + sx, y, z + sz, n) {
                    running += 1;
                } else {
                    lying += 1;
                }
            }
            if id == WATER_FALLING {
                result = if lying > 0 { WATER + 1 } else { WATER + 7 };
            } else if running > 0 && lying == 0 {
                result = WATER + 3;
            }
        }
        self.lat_cache.borrow_mut().insert(key, result);
        result
    }
    /// The faces the water in a loose cell runs on: bit d = toward HORIZONTAL[d]; 0 = a free column.
    /// Water coming down keeps the way it came (the cell above's faces: a column stays a column
    /// past a block beside it, a film stays on its side — on the wall while there is one, as a
    /// curtain after). Where it starts, it is a lip over EVERY edge with lying water behind it, or
    /// failing that a film on EVERY wall beside it: one face only left the other walls of an
    /// inside corner dry, and the films either side of it cut off.
    fn strands(&mut self, x: i32, y: i32, z: i32) -> u8 {
        let key = cell_key(x, y, z);
        if let Some(&v) = self.origin_cache.get(&key) {
            return v as u8;
        }
        let id = self.raw(x, y, z);
        let up = self.raw(x, y + 1, z);
        let mut mask = 0u8;
        if self.loose(x, y + 1, z, up) {
            mask = self.strands(x, y + 1, z);
        } else {
            if id != WATER_FALLING {
                for (d, [hx, _, hz]) in HORIZONTAL.into_iter().enumerate() {
                    if self.lying(x + hx, y, z + hz) {
                        mask |= 1 << d;
                    }
                }
            }
            if mask == 0 {
                for (d, [hx, _, hz]) in HORIZONTAL.into_iter().enumerate() {
                    if SOLID[self.raw(x + hx, y, z + hz) as usize] {
                        mask |= 1 << d;
                    }
                }
            }
        }
        self.origin_cache.insert(key, mask as i32);
        mask
    }
    /// Water that lies on something (not in the air).
    fn lying(&self, x: i32, y: i32, z: i32) -> bool {
        let id = self.raw(x, y, z);
        is_water(id) && !self.loose(x, y, z, id)
    }
    /// Is the strand toward `d` in this cell a lip — where lying water goes over an edge?
    fn is_lip(&self, x: i32, y: i32, z: i32, d: usize) -> bool {
        let id = self.raw(x, y, z);
        id != WATER_FALLING && !self.loose(x, y + 1, z, self.raw(x, y + 1, z)) && self.lying(x + HORIZONTAL[d][0], y, z + HORIZONTAL[d][2])
    }
    #[allow(clippy::too_many_arguments)]
    fn against(x: i32, z: i32, d: usize, near: f64, far: f64, lo: f64, hi: f64, r_lo: f64, r_hi: f64) -> Outline {
        let (fx, fz) = (HORIZONTAL[d][0], HORIZONTAL[d][2]);
        let (x, z) = (x as f64, z as f64);
        if fx != 0 {
            let plane = if fx > 0 { x + 1.0 } else { x };
            let (a, b) = (plane - fx as f64 * near, plane - fx as f64 * far);
            return [a.min(b), a.max(b), z + 0.5 - lo, z + 0.5 + hi, r_lo, r_lo, r_hi, r_hi];
        }
        let plane = if fz > 0 { z + 1.0 } else { z };
        let (a, b) = (plane - fz as f64 * near, plane - fz as f64 * far);
        [x + 0.5 - lo, x + 0.5 + hi, a.min(b), a.max(b), r_lo, r_hi, r_hi, r_lo]
    }
    fn along(d: usize, step: i32) -> (i32, i32) {
        if HORIZONTAL[d][0] != 0 {
            (0, step)
        } else {
            (step, 0)
        }
    }
    /// The film or curtain toward `d` goes on round the block's corner at this end: the cell round
    /// the corner has a strand toward the same block (or, under it, the same gap), and the cell
    /// between the two is open.
    fn wraps(&mut self, x: i32, y: i32, z: i32, d: usize, step: i32) -> bool {
        let (ax, az) = Self::along(d, step);
        let (bx, bz) = (x + HORIZONTAL[d][0], z + HORIZONTAL[d][2]);
        if SOLID[self.raw(x + ax, y, z + az) as usize] {
            return false;
        }
        let (cx, cz) = (bx + ax, bz + az);
        let c = self.raw(cx, y, cz);
        if !self.loose(cx, y, cz, c) {
            return false;
        }
        let back = if ax != 0 {
            if ax > 0 { 1 } else { 0 }
        } else if az > 0 {
            3
        } else {
            2
        };
        self.strands(cx, y, cz) & (1 << back) != 0
    }
    fn film(&mut self, x: i32, y: i32, z: i32, d: usize, far: f64) -> Outline {
        let (lo, hi) = (self.wraps(x, y, z, d, -1), self.wraps(x, y, z, d, 1));
        Self::against(x, z, d, FILM_NEAR, far, if lo { 0.5 + far } else { 0.5 }, if hi { 0.5 + far } else { 0.5 }, if lo { far * 0.7 } else { 0.0 }, if hi { far * 0.7 } else { 0.0 })
    }
    fn column(x: i32, z: i32) -> Outline {
        let (x, z) = (x as f64, z as f64);
        [x + 0.5 - FALL, x + 0.5 + FALL, z + 0.5 - FALL, z + 0.5 + FALL, FALL, FALL, FALL, FALL]
    }
    /// The outline of the strand toward `d` at this cell's foot: a film on the wall, the same
    /// film falling on as a curtain where the wall has ended, and for a lip over a block's edge
    /// the film it becomes on that block's face.
    fn outline(&mut self, x: i32, y: i32, z: i32, d: usize) -> Outline {
        let (fx, fz) = (HORIZONTAL[d][0], HORIZONTAL[d][2]);
        if self.is_lip(x, y, z, d) && SOLID[self.raw(x + fx, y - 1, z + fz) as usize] && self.loose(x, y - 1, z, self.raw(x, y - 1, z)) {
            return self.film(x, y - 1, z, d, LIP_FAR);
        }
        self.film(x, y, z, d, FILM_FAR)
    }
    fn stream_vertex(&mut self, p: V3, n: V3, cell: [i32; 3], foam: f64) -> u32 {
        let o = &mut self.out;
        let i = (o.position.len() / 3) as u32;
        o.position.extend(p.map(|v| v as f32));
        o.normal.extend(n.map(|v| v as f32));
        o.grid.extend([cell[0] as f32, cell[1] as f32, cell[2] as f32, (200000 + self.serial % 60000) as f32]);
        self.serial += 1;
        o.wave.push(0.0);
        o.wet.push(1.0);
        o.foam.push(foam as f32);
        o.depth.push(0.3f64 as f32);
        o.flow.extend([0.0, 1.0, 0.0]);
        o.impact.extend([0.0, 0.0, 0.0]);
        i
    }
    fn ring_point(o: &Outline, k: usize, y: f64) -> V3 {
        let [ix, iz, nx, nz, slot] = RING[k];
        let px = if ix < 0 { (o[0] + o[1]) / 2.0 } else { o[ix as usize] };
        let pz = if iz < 0 { (o[2] + o[3]) / 2.0 } else { o[iz as usize] };
        if slot < 0 {
            return [px, y, pz];
        }
        let r = o[slot as usize].min((o[1] - o[0]) / 2.0).min((o[3] - o[2]) / 2.0) * 0.2929;
        [px - nx as f64 * r, y, pz - nz as f64 * r]
    }
    fn ring(&mut self, o: &Outline, y: f64, cell: [i32; 3], foam: f64, lift: f64) -> [u32; 8] {
        let mut out = [0u32; 8];
        for (k, slot) in out.iter_mut().enumerate() {
            let n = normalize([RING[k][2] as f64, lift, RING[k][3] as f64]);
            *slot = self.stream_vertex(Self::ring_point(o, k, y), n, cell, foam);
        }
        out
    }
    fn band(&mut self, top: &[u32; 8], bottom: &[u32; 8]) {
        for i in 0..8 {
            let j = (i + 1) % 8;
            self.out.indices.extend([top[i], top[j], bottom[i], top[j], bottom[j], bottom[i]]);
        }
    }
    fn cap(&mut self, o: &Outline, y: f64, cell: [i32; 3], up: bool) {
        let n: V3 = [0.0, if up { 1.0 } else { -1.0 }, 0.0];
        let c = self.stream_vertex([(o[0] + o[1]) / 2.0, y, (o[2] + o[3]) / 2.0], n, cell, 0.0);
        let mut r = [0u32; 8];
        for (k, slot) in r.iter_mut().enumerate() {
            *slot = self.stream_vertex(Self::ring_point(o, k, y), n, cell, 0.0);
        }
        for i in 0..8 {
            let j = (i + 1) % 8;
            if up {
                self.out.indices.extend([c, r[j], r[i]]);
            } else {
                self.out.indices.extend([c, r[i], r[j]]);
            }
        }
    }
    fn scaled(o: &Outline, k: f64) -> Outline {
        let (cx, cz) = ((o[0] + o[1]) / 2.0, (o[2] + o[3]) / 2.0);
        [cx + (o[0] - cx) * k, cx + (o[1] - cx) * k, cz + (o[2] - cz) * k, cz + (o[3] - cz) * k, o[4] * k, o[5] * k, o[6] * k, o[7] * k]
    }
    /// Water in the air: each loose cell's strands (or its column) as lofts between level outlines;
    /// the outline at a cell's top is the one the cell above ends in, so stacked cells join.
    fn draw_streams(&mut self, cells: &[[i32; 3]]) {
        for &[x, y, z] in cells {
            let id = self.raw(x, y, z);
            if !self.loose(x, y, z, id) {
                continue;
            }
            let mask = self.strands(x, y, z);
            if mask == 0 {
                self.draw_strand(x, y, z, id, None);
            }
            for d in 0..4 {
                if mask & (1 << d) != 0 {
                    self.draw_strand(x, y, z, id, Some(d));
                }
            }
        }
    }
    /// One strand of a loose cell (`d`), or its free column (None).
    fn draw_strand(&mut self, x: i32, y: i32, z: i32, id: u8, d: Option<usize>) {
        let cell = [x, y, z];
        let yf = y as f64;
        let own = match d {
            Some(d) => self.outline(x, y, z, d),
            None => Self::column(x, z),
        };
        let fed = self.loose(x, y + 1, z, self.raw(x, y + 1, z));
        let mut top;
        if fed {
            let upper = match d {
                Some(d) => self.outline(x, y + 1, z, d),
                None => Self::column(x, z),
            };
            top = self.ring(&upper, yf + 1.0, cell, 0.0, 0.0);
        } else if id == WATER_FALLING {
            // a fall under water that lies on something
            self.cap(&own, yf + 1.0, cell, true);
            top = self.ring(&own, yf + 1.0, cell, 0.0, 0.0);
        } else if let Some(d) = d.filter(|&d| self.is_lip(x, y, z, d)) {
            // Where lying water goes over an edge, the LATTICE's rounded rim is the water bending
            // over; the film only has to begin under it. So the strand starts as a low collar just
            // over the edge, tucked into that rim. (A lip of its own, starting a quarter of a
            // metre back inside the lying water, showed through that water's surface from above
            // as a second pane with straight edges — overlapping, cut off where the two crossed.)
            let (fx, fz) = (HORIZONTAL[d][0], HORIZONTAL[d][2]);
            let mut brim = own;
            let plane = if fx != 0 {
                if fx > 0 { x as f64 + 1.0 } else { x as f64 }
            } else if fz > 0 {
                z as f64 + 1.0
            } else {
                z as f64
            };
            let f = if fx != 0 { fx } else { fz } as f64;
            let i = if fx != 0 { 0 } else { 2 };
            // the side toward the block moves back over its edge; the outer side stays the film's
            if f > 0.0 {
                brim[i + 1] = plane + LIP_BACK;
            } else {
                brim[i] = plane - LIP_BACK;
            }
            self.cap(&brim, yf + LIP_TOP, cell, true);
            top = self.ring(&brim, yf + LIP_TOP, cell, 0.0, 1.0);
        } else {
            // a spring in the air: a rounded head
            let tip = Self::scaled(&own, 0.35);
            self.cap(&tip, yf + 0.9, cell, true);
            top = self.ring(&tip, yf + 0.9, cell, 0.0, 1.6);
            let shoulder = self.ring(&Self::scaled(&own, 0.78), yf + 0.82, cell, 0.0, 0.7);
            self.band(&top, &shoulder);
            let neck = self.ring(&own, yf + 0.64, cell, 0.0, 0.0);
            self.band(&shoulder, &neck);
            top = neck;
        }
        let bottom = self.ring(&own, yf, cell, 0.0, 0.0);
        self.band(&top, &bottom);
        let below = self.raw(x, y - 1, z);
        if self.loose(x, y - 1, z, below) {
            return;
        }
        if is_water(below) {
            // into the water it lands in: on down under that water's surface, foaming where it enters
            let deep = self.ring(&own, yf - 0.9, cell, 0.8, 0.0);
            self.band(&bottom, &deep);
            self.cap(&own, yf - 0.9, cell, false);
        } else {
            self.cap(&own, yf, cell, false);
        }
    }
    /// Full to the top: under more water, or standing under a block that is itself in the water
    /// (waterGeometry.ts `covered`).
    fn covered(&self, x: i32, y: i32, z: i32, id: u8) -> bool {
        let up = self.get(x, y + 1, z);
        if is_water(up) {
            return true;
        }
        if !SOLID[up as usize] || id == WATER_FALLING || water_level(id) != 0 {
            return false;
        }
        is_water(self.get(x + 1, y + 1, z)) || is_water(self.get(x - 1, y + 1, z))
            || is_water(self.get(x, y + 1, z + 1)) || is_water(self.get(x, y + 1, z - 1))
    }

    fn solid(&self, x: i32, y: i32, z: i32) -> bool {
        SOLID[self.get(x, y, z) as usize]
    }
    fn deeply_inside_solid(&self, p: V3) -> bool {
        let (x, y, z) = (p[0].floor(), p[1].floor(), p[2].floor());
        self.solid(x as i32, y as i32, z as i32) && p[0] - x > 0.002 && p[1] - y > 0.002 && p[2] - z > 0.002 && p[0] - x < 0.998 && p[1] - y < 0.998 && p[2] - z < 0.998
    }
    /// Does a sheet go on round the corner at its end? waterGeometry.ts `turnsCorner`.
    /// A sheet over a fall that is a whole cell in mid-air widens to the whole cell at its foot
    /// (waterGeometry.ts `widens`).
    fn widens(&mut self, x: i32, y: i32, z: i32) -> bool {
        let below = self.get(x, y - 1, z);
        if below != WATER_FALLING || self.sheet(x, y - 1, z, below) & 7 != 0 {
            return false;
        }
        HORIZONTAL.into_iter().any(|[sx, _, sz]| self.get(x + sx, y - 1, z + sz) == 0)
    }
    /// A fall with nothing but air or more of the fall round it (waterGeometry.ts `freeFall`).
    fn free_fall(&self, x: i32, y: i32, z: i32) -> bool {
        HORIZONTAL.into_iter().all(|[sx, _, sz]| {
            let n = self.get(x + sx, y, z + sz);
            n == 0 || n == WATER_FALLING
        })
    }
    fn turns_corner(&mut self, x: i32, y: i32, z: i32, thin_axis: usize, wall: i32, sign: i32) -> bool {
        let (bx, bz) = if thin_axis == 0 { (x + wall, z) } else { (x, z + wall) };
        let (px, pz) = if thin_axis == 0 { (x + wall, z + sign) } else { (x + sign, z + wall) };
        let partner = self.get(px, y, pz);
        if !is_water(partner) {
            return false;
        }
        SOLID[self.get(bx, y, bz) as usize] || self.sheet(px, y, pz, partner) & 8 != 0
    }

    /// Water running off something is a sheet on the face it runs down: see waterGeometry.ts
    /// `sheet`. 0 = the whole cell; 1/2 = on the cell's -x/+x face, 3/4 = on its -z/+z face.
    fn sheet(&mut self, x: i32, y: i32, z: i32, id: u8) -> u8 {
        let key = cell_key(x, y, z);
        if let Some(&v) = self.sheet_cache.get(&key) {
            return v;
        }
        let (mut found, mut both) = (0u8, false);
        let below = self.get(x, y - 1, z);
        // (a spring hanging in the air counts too: it is where the film on that face starts)
        let loose = id == WATER_FALLING || (WATER..WATER_FALLING).contains(&id) && (below == 0 || below == WATER_FALLING);
        if loose {
            for (i, [sx, _, sz]) in HORIZONTAL.into_iter().enumerate() {
                if self.get(x + sx, y, z + sz) != 0 {
                    continue;
                }
                let back = self.get(x - sx, y, z - sz);
                // a shaped block holding water (any profile mark) is something to run off, like a solid
                let mut hug = SOLID[back as usize] || is_water(back) && (self.profile)(x - sx, y, z - sz) != 0;
                // (a FALL comes from above, not from the water beside it: it lies only on blocks)
                if !hug && is_water(back) && id != WATER_FALLING {
                    // standing water, or a fall that has landed on a block
                    let under = self.get(x - sx, y - 1, z - sz);
                    hug = if back != WATER_FALLING { under != 0 && under != WATER_FALLING } else { SOLID[under as usize] };
                }
                if !hug {
                    continue;
                }
                if found != 0 {
                    found = 0;
                    both = true;
                    break;
                }
                found = i as u8 + 1;
            }
            // a fall keeps the sheet of the fall above it once the face it ran down ends
            if found == 0 && !both && id == WATER_FALLING {
                let up = self.get(x, y + 1, z);
                let above = if is_water(up) { self.sheet(x, y + 1, z, up) & 7 } else { 0 };
                if above != 0 {
                    let [sx, _, sz] = HORIZONTAL[above as usize - 1];
                    if self.get(x + sx, y, z + sz) == 0 && !is_water(self.get(x - sx, y, z - sz)) {
                        found = above;
                    }
                }
            }
        }
        // a lip is only as thin as the fall under it (waterGeometry.ts)
        if found != 0 && id != WATER_FALLING && below == WATER_FALLING {
            self.sheet_cache.insert(key, found | 8);
            if self.sheet(x, y - 1, z, below) & 7 != found {
                found = 0;
            }
        }
        if loose {
            found |= 8; // running water, whether or not it lies on a face
        }
        self.sheet_cache.insert(key, found);
        found
    }
    fn depth(&mut self, x: i32, y: i32, z: i32) -> f64 {
        let key = cell_key(x, y, z);
        if let Some(&d) = self.depth_cache.get(&key) {
            return d;
        }
        let mut d = water_height(self.get(x, y, z), false);
        let mut yy = y - 1;
        while yy >= 0 && y - yy < 16 && is_water(self.get(x, yy, z)) {
            d += 1.0;
            yy -= 1;
        }
        self.depth_cache.insert(key, d);
        d
    }
    fn sample(&mut self, x: i32, y: i32, z: i32, id: u8) -> Sample {
        let key = cell_key(x, y, z);
        if let Some(&s) = self.sample_cache.get(&key) {
            return s;
        }
        let (mut fx, mut fz) = (0.0, 0.0);
        let level = water_level(id) as f64;
        for [sx, _, sz] in HORIZONTAL {
            let other = self.get(x + sx, y, z + sz);
            if SOLID[other as usize] {
                continue;
            }
            let gradient = water_level(other) as f64 - level;
            fx += sx as f64 * gradient;
            fz += sz as f64 * gradient;
        }
        let below = self.get(x, y - 1, z);
        let impact = if id == WATER_FALLING { self.solid(x, y - 1, z) || is_water(below) && below != WATER_FALLING } else { self.get(x, y + 1, z) == WATER_FALLING };
        let depth = self.depth(x, y, z);
        let s = Sample { depth, fx, fz, fall: if id == WATER_FALLING { 1.0 } else { 0.0 }, impact };
        self.sample_cache.insert(key, s);
        s
    }

    fn push(&mut self, mut node: Node) -> usize {
        node.id = self.sequence;
        self.sequence += 1;
        self.nodes.push(node);
        self.nodes.len() - 1
    }

    #[allow(clippy::too_many_arguments)]
    fn get_node(&mut self, cx: i32, cy: i32, cz: i32, wx: i32, wy: i32, wz: i32, ax: i32, ay: i32, az: i32) -> Option<usize> {
        let key = cell_key(cx, cy, cz);
        if !self.cache.contains_key(&key) {
            let groups = self.build_cube(cx, cy, cz);
            self.cache.insert(key, groups);
        }
        let i = ((wx - cx) | (wy - cy) << 1 | (wz - cz) << 2) as usize;
        let j = ((ax - cx) | (ay - cy) << 1 | (az - cz) << 2) as usize;
        self.cache[&key].get(i * 8 + j).copied().flatten()
    }

    fn build_cube(&mut self, cx: i32, cy: i32, cz: i32) -> Box<[Option<usize>; 64]> {
        let t = tables();
        let mut groups: Box<[Option<usize>; 64]> = Box::new([None; 64]);
        let ids: Vec<u8> = CORNERS.iter().map(|c| self.get(cx + c[0], cy + c[1], cz + c[2])).collect();
        let (mut water_mask, mut remaining) = (0u32, 0u32);
        for (i, &id) in ids.iter().enumerate() {
            if is_water(id) {
                water_mask |= 1 << i;
            }
        }
        for (i, &(a, b, _)) in t.edges.iter().enumerate() {
            if (water_mask & 1 << a != 0) != (water_mask & 1 << b != 0) {
                remaining |= 1 << i;
            }
        }
        let crowded = (water_mask & water_mask.wrapping_sub(1)) != 0 && !t.edges.iter().any(|&(a, b, _)| water_mask & 1 << a != 0 && water_mask & 1 << b != 0);
        let mut links: Vec<Vec<usize>> = vec![Vec::new(); 12];
        for (corners, fe) in &t.faces {
            let crossed: Vec<usize> = fe.iter().copied().filter(|&e| remaining & 1 << e != 0).collect();
            if crossed.len() == 2 {
                links[crossed[0]].push(crossed[1]);
                links[crossed[1]].push(crossed[0]);
            } else if crossed.len() == 4 {
                // two wet cells corner to corner: two streams in the open, ONE sheet round a
                // block's corner (one solid, one air): see waterGeometry.ts
                let solids = (0..4).filter(|&j| water_mask & 1 << corners[j] == 0 && SOLID[ids[corners[j]] as usize]).count();
                // (not with the films drawn apart: there is no sheet in the lattice to wrap, and the
                // rule joined the water on a block to the water one block DOWN beside it — a big
                // slanted pane over the block's edge, and a wedge at every step of a cascade)
                let wrap = solids == 1 && !self.streams;
                for j in 0..4 {
                    if (water_mask & 1 << corners[j] != 0) != wrap {
                        let (a, b) = (fe[(j + 3) % 4], fe[j]);
                        links[a].push(b);
                        links[b].push(a);
                    }
                }
            }
        }
        while remaining != 0 {
            let seed = remaining.trailing_zeros() as usize;
            let mut queue = vec![seed];
            let (mut edge_mask, mut mask) = (0u32, 0u32);
            let mut q = 0;
            while q < queue.len() {
                let i = queue[q];
                q += 1;
                if edge_mask & 1 << i != 0 {
                    continue;
                }
                edge_mask |= 1 << i;
                let (a, b, _) = t.edges[i];
                mask |= water_mask & ((1 << a) | (1 << b));
                for &j in &links[i] {
                    if edge_mask & 1 << j == 0 {
                        queue.push(j);
                    }
                }
            }
            remaining &= !edge_mask;
            let mut points: Vec<V3> = Vec::new();
            let mut normal: V3 = [0.0; 3];
            let mut surface_heights: Vec<f64> = Vec::new();
            let (mut side_sum, mut side_count) = ([0.0f64; 3], [0.0f64; 3]);
            let (mut axis_sum, mut axis_count) = ([0.0f64; 3], [0.0f64; 3]);
            let (mut running, mut rim, mut ledge) = (false, false, false);
            let mut constraints: [Option<f64>; 3] = [None; 3];
            let mut below: [Option<f64>; 3] = [None; 3];
            let mut pool: [Option<f64>; 3] = [None; 3];
            let mut pool_side = [0.0f64; 3];
            for (e, &(ia, ib, axis)) in t.edges.iter().enumerate() {
                if edge_mask & 1 << e == 0 {
                    continue;
                }
                let wa = water_mask & 1 << ia != 0;
                let (wi, ai) = if wa { (ia, ib) } else { (ib, ia) };
                let (a, b) = (CORNERS[wi], CORNERS[ai]);
                let (x, y, z) = (cx + a[0], cy + a[1], cz + a[2]);
                // over a shaped block the surface follows the block's top at this corner of its cell
                let profile = (self.profile)(x, y, z);
                let code = self.sheet(x, y, z, ids[wi]);
                let thin = code & 7;
                let mut h = if profile & 3 == 0 {
                    water_height(ids[wi], self.covered(x, y, z, ids[wi]))
                } else {
                    ((((profile >> (((1 - a[0]) + 2 * (1 - a[2])) * 2)) & 3) as f64 - 1.0) * 0.5 + FILM).min(1.0)
                };
                if thin != 0 && ids[wi] > WATER && ids[wi] < WATER_FALLING && h > LIP {
                    h = LIP;
                }
                let mut p: V3 = [x as f64 + 0.5, y as f64 + h * 0.5, z as f64 + 0.5];
                let sign = (b[axis] - a[axis]) as f64;
                if code != 0 {
                    running = true;
                }
                let thin_axis = if thin == 0 { usize::MAX } else if thin < 3 { 0 } else { 2 };
                let near = thin & 1 == 1; // the sheet lies on the cell's low face
                if thin_axis != usize::MAX {
                    p[thin_axis] = (if thin_axis == 0 { x } else { z }) as f64 + if near { SHEET * 0.5 } else { 1.0 - SHEET * 0.5 };
                }
                if axis == 1 {
                    p[1] = y as f64 + if sign > 0.0 { h } else { 0.0 };
                } else if axis == thin_axis {
                    let edge = if sign > 0.0 {
                        if near && !self.widens(x, y, z) { SHEET } else { 1.0 }
                    } else if near || self.widens(x, y, z) {
                        0.0
                    } else {
                        1.0 - SHEET
                    };
                    p[axis] = (if axis == 0 { x } else { z }) as f64 + edge;
                } else if thin_axis != usize::MAX && !SOLID[ids[ai] as usize] && self.turns_corner(x, y, z, thin_axis, if near { -1 } else { 1 }, sign as i32) {
                    // the sheet goes on round the block's corner, where the next face's sheet meets it
                    p[axis] += sign * (0.5 + SHEET);
                } else {
                    let free = thin == 0 && ids[wi] == WATER_FALLING && ids[ai] == 0 && self.free_fall(x, y, z);
                    p[axis] += sign * if free { FALL } else { 0.5 };
                }
                points.push(p);
                axis_sum[axis] += p[axis];
                axis_count[axis] += 1.0;
                if axis == 1 && sign > 0.0 {
                    surface_heights.push(p[1]);
                } else if axis != 1 && a[1] == 1 {
                    side_sum[axis] += p[axis];
                    side_count[axis] += 1.0;
                } else if axis != 1 {
                    rim = true; // a side of the same cell whose top is here: an outward edge
                }
                if ids[ai] == 0 || axis == 1 && sign > 0.0 && h < 0.999 {
                    normal[axis] += sign;
                }
                if SOLID[ids[ai] as usize] {
                    // a block hanging over the lower layer, touched by water that goes on down
                    // beside it: the surface passes that block's lower edge (waterGeometry.ts)
                    if axis != 1 && a[1] == 1 && ids[ai & 5] == 0 && is_water(ids[wi & 5]) {
                        ledge = true;
                    }
                    if axis == 1 || a[1] == 1 {
                        constraints[axis] = Some(p[axis]);
                    } else if is_water(ids[wi | 2]) {
                        below[axis] = Some(p[axis]); // contact made by the water under what comes down
                    } else {
                        pool[axis] = Some(p[axis]); // ... and by the pool beside it, open to the air
                        pool_side[axis] = sign;
                    }
                }
            }
            if points.is_empty() {
                continue;
            }
            let mut p: V3 = [0.0; 3];
            for point in &points {
                for axis in 0..3 {
                    p[axis] += point[axis] / points.len() as f64;
                }
            }
            // water coming down into water meets it in a line, not a half-cell skirt (waterGeometry.ts JOIN)
            // running water takes each coordinate from the faces that cross that axis (waterGeometry.ts)
            if running && rim && !surface_heights.is_empty() && side_count[0] + side_count[2] == 0.0 {
                // a lip's rim is an outward edge, and those are round (waterGeometry.ts RIM)
                for axis in 0..3 {
                    if axis_count[axis] > 0.0 {
                        p[axis] += (axis_sum[axis] / axis_count[axis] - p[axis]) * RIM;
                    }
                }
            } else if running {
                for axis in 0..3 {
                    if axis_count[axis] > 0.0 {
                        // exactly, except a foot's sideways place (waterGeometry.ts FOOT)
                        p[axis] = if axis != 1 && !surface_heights.is_empty() {
                            p[axis] + (axis_sum[axis] / axis_count[axis] - p[axis]) * FOOT
                        } else {
                            axis_sum[axis] / axis_count[axis]
                        };
                    }
                }
            } else if !surface_heights.is_empty() && (side_count[0] > 0.0 || side_count[2] > 0.0) {
                p[1] += (surface_heights.iter().fold(0.0, |sum, h| sum + h) / surface_heights.len() as f64 - p[1]) * JOIN;
                for axis in [0usize, 2] {
                    if side_count[axis] > 0.0 {
                        p[axis] += (side_sum[axis] / side_count[axis] - p[axis]) * JOIN;
                    }
                }
            }
            for axis in 0..3 {
                // the cell's own contact, then the water's under what comes down, then the pool's;
                // the foot stays at the sheet where its own cell touches that block on the other
                // axis (waterGeometry.ts)
                let mut held = constraints[axis].or(below[axis]);
                if held.is_none() {
                    if let Some(c) = pool[axis] {
                        // (never past that block's end)
                        held = Some(if side_count[axis] > 0.0 && below[2 - axis].is_some() {
                            let side = side_sum[axis] / side_count[axis];
                            if pool_side[axis] > 0.0 { c.max(side) } else { c.min(side) }
                        } else {
                            c
                        });
                    }
                }
                if let Some(c) = held {
                    p[axis] = c;
                }
            }
            // held on a hanging block's face it must be on the block, not under its lower edge
            if ledge && constraints[1].is_none() && p[1] < (cy + 1) as f64 {
                p[1] = (cy + 1) as f64;
            }
            if normal[1] > 0.0 && normal[0] == 0.0 && normal[2] == 0.0 && !surface_heights.is_empty() {
                p[1] = surface_heights.iter().fold(0.0, |sum, h| sum + h) / surface_heights.len() as f64;
            }
            // low water under a block beside full-height water: come up to the block's lower edge
            // and close the tall water's open side (waterGeometry.ts)
            for j in 0..8usize {
                if j & 2 != 0 || water_mask & 1 << j == 0 || !SOLID[ids[j | 2] as usize] {
                    continue;
                }
                let Some(e) = t.edges.iter().position(|&(a, b, _)| a == j && b == (j | 2)) else { continue };
                if edge_mask & 1 << e == 0 {
                    continue;
                }
                let c = CORNERS[j];
                if water_height(ids[j], self.covered(cx + c[0], cy, cz + c[2], ids[j])) >= 0.999 {
                    continue;
                }
                for k in [j ^ 1, j ^ 4] {
                    if water_mask & 1 << k == 0 {
                        continue;
                    }
                    let d = CORNERS[k];
                    if water_height(ids[k], self.covered(cx + d[0], cy, cz + d[2], ids[k])) >= 0.999 {
                        p[1] = (cy + 1) as f64;
                    }
                }
            }
            // ... and the other way round: water filled up to a sunk block, beside the open surface
            // an eighth lower: that surface comes up to the block's edge (waterGeometry.ts)
            for j in 0..8usize {
                if j & 2 != 0 || water_mask & 1 << j == 0 || !SOLID[ids[j | 2] as usize] {
                    continue;
                }
                let Some(e) = t.edges.iter().position(|&(a, b, _)| a == j && b == (j | 2)) else { continue };
                if edge_mask & 1 << e == 0 {
                    continue;
                }
                let c = CORNERS[j];
                if water_height(ids[j], self.covered(cx + c[0], cy, cz + c[2], ids[j])) < 0.999 {
                    continue;
                }
                for k in [j ^ 1, j ^ 4] {
                    if water_mask & 1 << k == 0 || ids[k | 2] != 0 {
                        continue;
                    }
                    let d = CORNERS[k];
                    if water_height(ids[k], self.covered(cx + d[0], cy, cz + d[2], ids[k])) < 0.999 {
                        p[1] = (cy + 1) as f64;
                    }
                }
            }
            if self.deeply_inside_solid(p) {
                if let Some(safe) = points.iter().find(|point| !self.deeply_inside_solid(**point)) {
                    p = *safe;
                }
            }
            let n = normalize(normal);
            let (mut count, mut d, mut fx, mut fz, mut falls, mut ix, mut iz, mut impact) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
            let mut columns = [false; 4];
            for (i, c) in CORNERS.iter().enumerate() {
                let (dx, dy, dz) = (c[0], c[1], c[2]);
                if is_water(ids[i]) || SOLID[ids[i] as usize] {
                    columns[(dx * 2 + dz) as usize] = true;
                }
                if mask & 1 << i == 0 {
                    continue;
                }
                let (x, y, z, id) = (cx + dx, cy + dy, cz + dz, ids[i]);
                let s = self.sample(x, y, z, id);
                count += 1.0;
                d += s.depth;
                falls += s.fall;
                fx += s.fx;
                fz += s.fz;
                if s.impact {
                    ix += x as f64 + 0.5;
                    iz += z as f64 + 0.5;
                    impact += 1.0;
                }
            }
            let len = js_hypot(fx, fz);
            let scale = if len != 0.0 { f64::min(1.0, len / (count * 4.0)) / len } else { 0.0 };
            let foam = f64::min(1.0, impact / f64::max(1.0, count));
            let node = Node {
                id: 0,
                p,
                n,
                crowded,
                grid: [cx as f64, cy as f64, cz as f64, edge_mask as f64],
                depth: d / count,
                wave: f64::max(0.0, n[1]) * f64::min(1.0, d / count * 3.0) * (1.0 - foam * 0.7),
                wet: columns.iter().filter(|&&c| c).count() as f64 / 4.0,
                foam,
                flow: [fx * scale, falls / count, fz * scale],
                impact: if impact != 0.0 { [ix / impact, iz / impact, f64::min(1.0, impact / 4.0)] } else { [0.0; 3] },
            };
            let index = self.push(node);
            for (e, &(a, b, _)) in t.edges.iter().enumerate() {
                if edge_mask & 1 << e != 0 {
                    groups[if water_mask & 1 << a != 0 { a * 8 + b } else { b * 8 + a }] = Some(index);
                }
            }
        }
        groups
    }

    fn blend(&mut self, a: usize, b: usize, p: V3, grid: [f64; 4]) -> usize {
        let (a, b) = (&self.nodes[a], &self.nodes[b]);
        let node = Node {
            id: 0,
            p,
            grid,
            n: normalize(lerp3(a.n, b.n, 0.5)),
            flow: lerp3(a.flow, b.flow, 0.5),
            crowded: a.crowded || b.crowded,
            wave: (a.wave + b.wave) * 0.5,
            wet: (a.wet + b.wet) * 0.5,
            foam: (a.foam + b.foam) * 0.5,
            depth: (a.depth + b.depth) * 0.5,
            impact: if a.impact[2] != 0.0 { a.impact } else { b.impact },
        };
        self.push(node)
    }

    fn edge_point(&mut self, ai: usize, bi: usize, water: [i32; 3]) -> Option<usize> {
        let t = tables();
        let (a, b) = (self.nodes[ai].clone(), self.nodes[bi].clone());
        let axis = if a.grid[0] != b.grid[0] { 0 } else if a.grid[1] != b.grid[1] { 1 } else { 2 };
        let side = if a.grid[axis] < b.grid[axis] { 1 } else { 0 };
        let (ag, bg) = (a.grid[3] as u32, b.grid[3] as u32);
        let saddle = t.faces[axis * 2 + side].1.iter().all(|&e| ag & 1 << e != 0) && t.faces[axis * 2 + 1 - side].1.iter().all(|&e| bg & 1 << e != 0);
        if !saddle && (a.crowded || b.crowded || dot(a.n, b.n) > 0.9995) {
            return None;
        }
        let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
        let tag = if saddle { 1.0 + (water[u] as f64 - a.grid[u]) + 2.0 * (water[v] as f64 - a.grid[v]) } else { 0.0 };
        let key = (a.id.min(b.id) * 1_000_000 + a.id.max(b.id)) * 5 + tag as i64;
        if let Some(&cached) = self.edge_cache.get(&key) {
            return cached;
        }
        let mid = lerp3(a.p, b.p, 0.5);
        let da = dot([mid[0] - a.p[0], mid[1] - a.p[1], mid[2] - a.p[2]], a.n);
        let db = dot([mid[0] - b.p[0], mid[1] - b.p[1], mid[2] - b.p[2]], b.n);
        let mut p: V3 = [mid[0] - (a.n[0] * da + b.n[0] * db) * 0.4, mid[1] - (a.n[1] * da + b.n[1] * db) * 0.4, mid[2] - (a.n[2] * da + b.n[2] * db) * 0.4];
        if saddle {
            p = [0.0; 3];
            let h = water_height(self.get(water[0], water[1], water[2]), self.covered(water[0], water[1], water[2], self.get(water[0], water[1], water[2])));
            // a sheet's cell is the sheet (waterGeometry.ts)
            let id = self.get(water[0], water[1], water[2]);
            let thin = self.sheet(water[0], water[1], water[2], id) & 7;
            let thin_axis = if thin == 0 { usize::MAX } else if thin < 3 { 0 } else { 2 };
            let near = thin & 1 == 1;
            for cross in [u, v] {
                let sign = if water[cross] as f64 == a.grid[cross] { 1.0 } else { -1.0 };
                let mut point: V3 = [water[0] as f64 + 0.5, water[1] as f64 + h * 0.5, water[2] as f64 + 0.5];
                if thin_axis != usize::MAX {
                    point[thin_axis] = water[thin_axis] as f64 + if near { SHEET * 0.5 } else { 1.0 - SHEET * 0.5 };
                }
                if cross == 1 {
                    point[1] = water[1] as f64 + if sign > 0.0 { h } else { 0.0 };
                } else if cross == thin_axis {
                    point[cross] = water[cross] as f64
                        + if sign > 0.0 {
                            if near { SHEET } else { 1.0 }
                        } else if near {
                            0.0
                        } else {
                            1.0 - SHEET
                        };
                } else {
                    point[cross] += sign * 0.5;
                }
                for j in 0..3 {
                    p[j] += point[j] / 2.0;
                }
            }
            // between two nodes held on the same wall the edge runs straight along that wall
            for cross in [u, v] {
                if cross != 1 && a.p[cross] == b.p[cross] && a.p[cross].fract() == 0.0 {
                    p = mid;
                }
            }
            // between two nodes that came up to a block's underside, stay up there with them
            let lid = (water[1] + 1) as f64;
            if a.p[1] == lid && b.p[1] == lid && SOLID[self.get(water[0], water[1] + 1, water[2]) as usize] {
                p[1] = lid;
            }
        }
        let deviation = js_hypot_n(&[p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]]);
        // only an outward (convex) edge is rounded; an inward crease stays a crease
        let node = if (saddle || deviation > 0.006 && deviation < 0.2 && da <= 0.0 && db <= 0.0) && !self.deeply_inside_solid(p) {
            let grid = [(a.grid[0] + b.grid[0]) / 2.0, (a.grid[1] + b.grid[1]) / 2.0, (a.grid[2] + b.grid[2]) / 2.0, 131072.0 + a.grid[3] + b.grid[3] + tag * 16384.0];
            Some(self.blend(ai, bi, p, grid))
        } else {
            None
        };
        self.edge_cache.insert(key, node);
        node
    }

    fn emit(&mut self, i: usize) -> u32 {
        if let Some(&v) = self.vertex.get(&i) {
            return v;
        }
        let n = &self.nodes[i];
        let o = &mut self.out;
        let index = (o.position.len() / 3) as u32;
        o.position.extend(n.p.map(|x| x as f32));
        o.normal.extend(n.n.map(|x| x as f32));
        o.grid.extend(n.grid.map(|x| x as f32));
        o.wave.push(n.wave as f32);
        o.wet.push(n.wet as f32);
        o.foam.push(n.foam as f32);
        o.depth.push(n.depth as f32);
        o.flow.extend(n.flow.map(|x| x as f32));
        o.impact.extend([(n.impact[0] * n.impact[2]) as f32, (n.impact[1] * n.impact[2]) as f32, n.impact[2] as f32]);
        self.vertex.insert(i, index);
        index
    }

    fn face(&mut self, mut nodes: [usize; 4], reverse: bool, water: [i32; 3]) {
        if reverse {
            nodes.reverse();
        }
        let mut edges = [None; 4];
        for i in 0..4 {
            edges[i] = self.edge_point(nodes[i], nodes[(i + 1) % 4], water);
        }
        if edges.iter().all(Option::is_none) {
            for k in [0, 1, 2, 0, 2, 3] {
                let v = self.emit(nodes[k]);
                self.out.indices.push(v);
            }
            return;
        }
        let m01 = lerp3(self.nodes[nodes[0]].p, self.nodes[nodes[1]].p, 0.5);
        let b01 = self.blend(nodes[0], nodes[1], m01, [0.0; 4]);
        let m23 = lerp3(self.nodes[nodes[2]].p, self.nodes[nodes[3]].p, 0.5);
        let b23 = self.blend(nodes[2], nodes[3], m23, [0.0; 4]);
        let center = self.blend(b01, b23, [0.0; 3], [0.0, 0.0, 0.0, 65536.0]);
        for &v in &nodes {
            let (vp, vg) = (self.nodes[v].p, self.nodes[v].grid);
            let c = &mut self.nodes[center];
            for axis in 0..3 {
                c.p[axis] += vp[axis] / 4.0;
                c.grid[axis] += vg[axis] / 4.0;
            }
        }
        // The centre lies ON the curved edges (a Coons patch): see waterGeometry.ts `face`.
        let flat = self.nodes[center].p;
        for i in 0..4 {
            if let Some(e) = edges[i] {
                let (ep, a, b) = (self.nodes[e].p, self.nodes[nodes[i]].p, self.nodes[nodes[(i + 1) % 4]].p);
                let c = &mut self.nodes[center];
                for axis in 0..3 {
                    c.p[axis] += (ep[axis] - (a[axis] + (b[axis] - a[axis]) * 0.5)) * 0.5;
                }
            }
        }
        if self.deeply_inside_solid(self.nodes[center].p) {
            self.nodes[center].p = flat;
        }
        let mut perimeter = Vec::with_capacity(8);
        for i in 0..4 {
            perimeter.push(nodes[i]);
            if let Some(e) = edges[i] {
                perimeter.push(e);
            }
        }
        for i in 0..perimeter.len() {
            let c = self.emit(center);
            let a = self.emit(perimeter[i]);
            let b = self.emit(perimeter[(i + 1) % perimeter.len()]);
            self.out.indices.extend([c, a, b]);
        }
    }
}

/// `buildWaterGeometry(world, cells)`: `get` reads a cell's id (with any waterlogged shape already
/// handed over AS its water, like voxelView's snapshot); `cells` lists (x, y, z) to mesh. Ok(None) when
/// there is nothing to draw; Err where the TypeScript throws (a missing surface component).
pub fn build_water_mesh<G: Fn(i32, i32, i32) -> u8>(get: &G, cells: &[[i32; 3]]) -> Result<Option<WaterMesh>, MissingComponent> {
    build_water_mesh_shaped(get, &|_, _, _| 0, cells)
}

/// `build_water_mesh` with the shaped blocks' tops (`profile`, waterlog.ts `shapeProfile` per cell):
/// their water is drawn as a film over the block.
pub fn build_water_mesh_shaped<G: Fn(i32, i32, i32) -> u8>(
    get: &G,
    profile: &dyn Fn(i32, i32, i32) -> u8,
    cells: &[[i32; 3]],
) -> Result<Option<WaterMesh>, MissingComponent> {
    build_water_mesh_streams(get, profile, cells, false)
}

/// `build_water_mesh_shaped`, with water in the AIR (falls, lips, springs beside a wall) drawn as
/// films and streams apart from the lattice when `streams` is set (waterGeometry.ts
/// `drawWaterAsStreams`).
pub fn build_water_mesh_streams<G: Fn(i32, i32, i32) -> u8>(
    get: &G,
    profile: &dyn Fn(i32, i32, i32) -> u8,
    cells: &[[i32; 3]],
    streams: bool,
) -> Result<Option<WaterMesh>, MissingComponent> {
    if SIMPLE.load(std::sync::atomic::Ordering::Relaxed) {
        return Ok(build_simple(get, profile, cells));
    }
    let mut b = Builder {
        streams,
        lat_cache: Default::default(),
        origin_cache: FxHashMap::default(),
        serial: 0,
        get,
        profile,
        nodes: Vec::new(),
        sequence: 0,
        cache: FxHashMap::default(),
        edge_cache: FxHashMap::default(),
        depth_cache: FxHashMap::default(),
        sample_cache: FxHashMap::default(),
        sheet_cache: FxHashMap::default(),
        vertex: FxHashMap::default(),
        out: WaterMesh::default(),
    };
    for &[x, y, z] in cells {
        let id = b.get(x, y, z);
        if !is_water(id) {
            continue;
        }
        for axis in 0..3 {
            for sign in [-1, 1] {
                let mut other = [x, y, z];
                other[axis] += sign;
                let other_id = b.get(other[0], other[1], other[2]);
                let top_gap = axis == 1 && sign > 0 && SOLID[other_id as usize] && water_height(id, b.covered(x, y, z, id)) < 0.999;
                if other_id != 0 && !top_gap {
                    continue;
                }
                let mut base = [x, y, z];
                if sign < 0 {
                    base[axis] -= 1;
                }
                let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
                let mut quad = [0usize; 4];
                for (k, (da, db)) in [(-1, -1), (0, -1), (0, 0), (-1, 0)].into_iter().enumerate() {
                    let mut c = base;
                    c[u] += da;
                    c[v] += db;
                    quad[k] = b.get_node(c[0], c[1], c[2], x, y, z, other[0], other[1], other[2]).ok_or(MissingComponent)?;
                }
                b.face(quad, sign < 0, [x, y, z]);
            }
        }
    }
    if streams {
        b.draw_streams(cells);
    }
    if b.out.indices.is_empty() {
        return Ok(None);
    }
    Ok(Some(b.out))
}

/// "Missing connected water surface component" (the TypeScript throws).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MissingComponent;

// ---- the simple water (the default) --------------------------------------------------------------
//
// The owner's call, 2026-11-12: "simple, like Minecraft — water that runs down". Every water cell
// is a box: its top stands at the cell's level, the four corners of that top are shared with the
// cells round them (so the surface runs on from cell to cell as one slope, from the spring to the
// last cell), falling water is a whole cell, and a cell under more water is full. A side is drawn
// toward air, the bottom over air; nothing against a block or more water. No sheets, films, lips
// or curtains, and no surface net.

/// How far a corner of the water at a block reaches INTO that block. Bricks are drawn a few
/// centimetres inside their cell with rounded edges; water ending exactly on the cell's boundary
/// left a slot between itself and the wall it stands against, and the view behind showed through.
const TUCK: f64 = 0.07;
/// ...and how far along the wall at a wall's end (the bricks' own inset): see `tuck`.
const TUCK_END: f64 = 0.03;

/// A spring's lone corners: drawn in by this much of a cell, and standing at this share of their height.
const SPRING_INSET: f64 = 0.14;
const SPRING_DROP: f64 = 0.8;
/// How far a spring's middle rises from its corners' height toward its own (1 = all the way: a point).
const SPRING_RISE: f64 = 0.35;

static SIMPLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
/// The simple, Minecraft-like water (on by default) or the surface net with its films (off).
pub fn draw_water_simple(on: bool) {
    SIMPLE.store(on, std::sync::atomic::Ordering::Relaxed);
}

fn build_simple<G: Fn(i32, i32, i32) -> u8>(get: &G, profile: &dyn Fn(i32, i32, i32) -> u8, cells: &[[i32; 3]]) -> Option<WaterMesh> {
    let mut b = Builder {
        streams: false,
        lat_cache: Default::default(),
        origin_cache: FxHashMap::default(),
        serial: 0,
        get,
        profile,
        nodes: Vec::new(),
        sequence: 0,
        cache: FxHashMap::default(),
        edge_cache: FxHashMap::default(),
        depth_cache: FxHashMap::default(),
        sample_cache: FxHashMap::default(),
        sheet_cache: FxHashMap::default(),
        vertex: FxHashMap::default(),
        out: WaterMesh::default(),
    };
    for &[x, y, z] in cells {
        let id = b.get(x, y, z);
        if is_water(id) {
            b.simple_cell(x, y, z, id);
        }
    }
    if b.out.indices.is_empty() && b.out.closure.is_empty() {
        None
    } else {
        Some(b.out)
    }
}

/// What one corner of a cell's box carries besides its place.
#[derive(Clone, Copy)]
struct Corner {
    p: V3,
    n: V3,
    wave: f64,
    wet: f64,
}

impl<G: Fn(i32, i32, i32) -> u8> Builder<'_, G> {
    /// The height of the water's top at the lattice corner (cx, cz) of layer y — the corner shared
    /// by the four cells (cx-1..cx, cz-1..cz): full where any of them has water over it, else the
    /// average of the water cells' own heights. Also how many of the four hold water.
    ///
    /// A corner that only LIPS share — running water with a fall under it, the cell a fall starts
    /// in — stands at the cell's floor: the lip runs down to the fall under it. Standing at its
    /// own height it was a slab hung over the edge, with an upright step all round a platform and
    /// a pane at each corner, where water of two heights met.
    fn corner_height(&self, cx: i32, y: i32, cz: i32) -> Option<(f64, f64)> {
        // (lips: how many of the water cells are lips; open: is one of the four cells open air)
        let (mut sum, mut n, mut full, mut lips, mut open) = (0.0, 0.0, false, 0.0, false);
        for dx in -1..=0 {
            for dz in -1..=0 {
                let (x, z) = (cx + dx, cz + dz);
                let id = self.get(x, y, z);
                if !is_water(id) {
                    open |= !SOLID[id as usize];
                    continue;
                }
                if is_water(self.get(x, y + 1, z)) {
                    full = true;
                }
                if water_level(id) > 0 && id != WATER_FALLING && self.get(x, y - 1, z) == WATER_FALLING {
                    lips += 1.0;
                }
                sum += water_height(id, false);
                n += 1.0;
            }
        }
        if n == 0.0 {
            None
        } else {
            // (...and so does the corner two lips turn round — a platform's corner: the water on it
            // thins to nothing at that point, where it stood up as a little wall either side)
            let down = lips == n || (lips >= 2.0 && open);
            Some((if full { 1.0 } else if down { 0.0 } else { sum / n }, n))
        }
    }

    /// Where the water's vertex at the lattice point (cx, level, cz) is pushed, in x and z: into
    /// the blocks the water stands AGAINST there (see `TUCK`). A function of the point alone, so
    /// every face that has a vertex there moves it alike and the volume stays closed. `both`: a
    /// vertex ON the level (a foot, or a full top) looks at the cells under and over it; a top
    /// below its cell's top only at its own layer.
    ///
    /// Along an axis the vertex goes the whole way only toward a block that has water across the
    /// point on that axis (water face to face with it). At a wall's END the water's free side
    /// runs past the block's corner: pushed the whole way on both axes it leaned 7 cm into the
    /// wall — a dent at every corner; there the other axis moves only by the bricks' own inset.
    fn tuck(&self, cx: i32, level: i32, cz: i32, both: bool) -> (f64, f64) {
        // (toward the block on x / on z, and which way the blocks pushing on the OTHER axis lie)
        let (mut sx, mut sz, mut ex, mut ez) = (0.0, 0.0, 0.0, 0.0);
        // (...and away from a block's corner that water stands against on BOTH sides with open air
        // past it: the two sides meet round the corner. Drawn into the block there, they crossed
        // inside it and the block's own edge stood out of the water — a bright line down every
        // pillar's corner.)
        let (mut ox, mut oz) = (0.0, 0.0);
        for y in (if both { level - 1 } else { level })..=level {
            for dx in -1..=0 {
                for dz in -1..=0 {
                    if !SOLID[self.get(cx + dx, y, cz + dz) as usize] {
                        continue;
                    }
                    let (px, pz) = (dx as f64 + 0.5, dz as f64 + 0.5);
                    let (on_x, on_z) = (is_water(self.get(cx - 1 - dx, y, cz + dz)), is_water(self.get(cx + dx, y, cz - 1 - dz)));
                    let past = self.get(cx - 1 - dx, y, cz - 1 - dz);
                    if on_x && on_z && !is_water(past) && !SOLID[past as usize] {
                        ox -= px;
                        oz -= pz;
                        continue;
                    }
                    if on_x {
                        sx += px;
                        ez += pz;
                    }
                    if on_z {
                        sz += pz;
                        ex += px;
                    }
                }
            }
        }
        let toward = |v: f64, by: f64| if v > 0.0 { by } else if v < 0.0 { -by } else { 0.0 };
        if ox != 0.0 || oz != 0.0 {
            return (toward(ox, TUCK_END), toward(oz, TUCK_END));
        }
        (if sx != 0.0 { toward(sx, TUCK) } else { toward(ex, TUCK_END) }, if sz != 0.0 { toward(sz, TUCK) } else { toward(ez, TUCK_END) })
    }

    #[allow(clippy::too_many_arguments)]
    fn simple_quad(&mut self, cell: [i32; 3], face: u32, corners: [Corner; 4], flow: V3, depth: f64, foam: f64, impact: V3) {
        // faces 16 and up are the closing faces against blocks (see `WaterMesh::closure`)
        let closing = face >= 16;
        let base = (self.out.position.len() / 3) as u32;
        for (k, c) in corners.iter().enumerate() {
            let o = &mut self.out;
            o.position.extend(c.p.map(|v| v as f32));
            o.normal.extend(c.n.map(|v| v as f32));
            o.grid.extend([cell[0] as f32, cell[1] as f32, cell[2] as f32, (face * 4 + k as u32) as f32]);
            o.wave.push(c.wave as f32);
            o.wet.push(if closing { -1.0 } else { c.wet as f32 });
            o.foam.push(foam as f32);
            o.depth.push(depth as f32);
            o.flow.extend(flow.map(|v| v as f32));
            o.impact.extend([(impact[0] * impact[2]) as f32, (impact[1] * impact[2]) as f32, impact[2] as f32]);
        }
        let list = if closing { &mut self.out.closure } else { &mut self.out.indices };
        list.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
    }

    fn simple_cell(&mut self, x: i32, y: i32, z: i32, id: u8) {
        let s = self.sample(x, y, z, id);
        let len = js_hypot(s.fx, s.fz);
        let scale = if len != 0.0 { f64::min(1.0, len / 4.0) / len } else { 0.0 };
        let flow: V3 = [s.fx * scale, s.fall, s.fz * scale];
        let foam = if s.impact { 1.0 } else { 0.0 };
        let impact: V3 = if s.impact { [x as f64 + 0.5, z as f64 + 0.5, 0.25] } else { [0.0; 3] };
        // How much a corner swells is a matter of the CORNER (its height), never of the cell: taken
        // from each cell's own depth and foam, the cells round one corner lifted it by different
        // amounts — a hairline crack along every cell's edge, lines all over the water, and (the
        // count pass sees through everything) dotted lines over whatever stood in front of it.
        let corner_swell = |h: f64| f64::min(1.0, h * 3.0);
        let swell = if id == WATER_FALLING { 0.0 } else { corner_swell(water_height(id, false)) };
        let (xf, yf, zf) = (x as f64, y as f64, z as f64);
        // the top's four corners: (x, z), (x, z+1), (x+1, z+1), (x+1, z)
        let at = [[0, 0], [0, 1], [1, 1], [1, 0]];
        let mut tops = [Corner { p: [0.0; 3], n: [0.0, 1.0, 0.0], wave: 0.0, wet: 1.0 }; 4];
        let up = self.get(x, y + 1, z);
        // Standing water with open air over it — a spring, above all — is not a box: its middle
        // stands at its own height and a corner that no other water shares is drawn in and down,
        // so a spring is a mound the water runs off (it was a rectangle with a flat lid).
        let standing = water_level(id) == 0 && id != WATER_FALLING && !is_water(up) && !SOLID[up as usize];
        let mut lone = false;
        for (k, [dx, dz]) in at.into_iter().enumerate() {
            let (cx, cz) = (x + dx, z + dz);
            let (mut h, wet) = self.corner_height(cx, y, cz).unwrap_or((water_height(id, false), 1.0));
            // (a corner at a block stays on it: drawn in there, the spring stood 14 cm off the wall
            // it was set against, and the gap showed the inside of the water)
            let walled = (-1..=0).any(|ox| (-1..=0).any(|oz| SOLID[self.get(cx + ox, y, cz + oz) as usize]));
            let alone = standing && wet == 1.0 && !walled;
            if alone {
                h *= SPRING_DROP;
                lone = true;
            }
            // the surface's slope here, from the corners either side (their own height where they have none)
            let side = |b: &Self, ox: i32, oz: i32| b.corner_height(cx + ox, y, cz + oz).map_or(h, |v| v.0);
            let gx = (side(self, 1, 0) - side(self, -1, 0)) / 2.0;
            let gz = (side(self, 0, 1) - side(self, 0, -1)) / 2.0;
            let inset = if alone { SPRING_INSET } else { 0.0 };
            // (a corner on a lattice level — a full top, or a lip's at its floor — is the same point as the
            // foot or the full top of the cells over and under it: tucked as they are)
            let (tx, tz) = if alone { (0.0, 0.0) } else if h >= 1.0 { self.tuck(cx, y + 1, cz, true) } else if h <= 0.0 { self.tuck(cx, y, cz, true) } else { self.tuck(cx, y, cz, false) };
            let p = [xf + dx as f64 + (0.5 - dx as f64) * 2.0 * inset + tx, yf + h, zf + dz as f64 + (0.5 - dz as f64) * 2.0 * inset + tz];
            let n = if alone { normalize([(dx as f64 - 0.5) * 1.2, 1.0, (dz as f64 - 0.5) * 1.2]) } else { normalize([-gx, 1.0, -gz]) };
            tops[k] = Corner { p, n, wave: if h >= 1.0 || h <= 0.0 || alone { 0.0 } else { corner_swell(h) }, wet: wet / 4.0 };
        }
        // (a standing cell level with everything round it — the inside of a pond's surface — has no
        // mound to draw: one quad like any other top, a quarter of the vertices)
        let own_height = water_height(id, false);
        let mound = standing && (lone || own_height - tops.iter().map(|c| c.p[1] - yf).sum::<f64>() / 4.0 > 1e-9);
        if mound {
            // four quads round the middle: (middle, the edge's midpoint before, the corner, the one after)
            let own = water_height(id, false);
            let mean = tops.iter().map(|c| c.p[1] - yf).sum::<f64>() / 4.0;
            // (the middle only a little over its corners: at its full height over them the spring
            // came to a point, a pyramid)
            let centre = Corner { p: [xf + 0.5, yf + mean + (own - mean).max(0.0) * SPRING_RISE, zf + 0.5], n: [0.0, 1.0, 0.0], wave: swell, wet: 1.0 };
            // (a fan over the corners only: a point on an edge's middle swells by its own place,
            // off the straight edge of the side and of the next cell — a crack in the closed volume)
            // (one triangle each, as a quad with its last corner twice)
            for k in 0..4 {
                let next = tops[(k + 1) % 4];
                self.simple_quad([x, y, z], 6 + k as u32, [centre, tops[k], next, next], flow, s.depth, foam, impact);
            }
        } else if !is_water(up) || standing {
            let closing = SOLID[up as usize] && tops.iter().all(|c| c.p[1] >= yf + 1.0);
            // The top folds along the diagonal whose two ends stand most alike. Always folded
            // along the same one, a cell with ONE corner high (beside a fall, where streams of two
            // heights meet) was a ridge from that corner right across it — the surface twisted;
            // folded the other way it is level but for that corner. (`waterDepthAt` reads the same.)
            let h = |k: usize| tops[k].p[1];
            let quad = if (h(0) - h(2)).abs() <= (h(1) - h(3)).abs() { tops } else { [tops[1], tops[2], tops[3], tops[0]] };
            self.simple_quad([x, y, z], if closing { 16 } else { 0 }, quad, flow, s.depth, foam, impact);
        }
        let feet: [V3; 4] = std::array::from_fn(|k| {
            let (tx, tz) = self.tuck(x + at[k][0], y, z + at[k][1], true);
            [xf + at[k][0] as f64 + tx, yf, zf + at[k][1] as f64 + tz]
        });
        let over_fall = self.get(x, y - 1, z) == WATER_FALLING;
        // sides: toward -x (corners 0,1), +z (1,2), +x (2,3), -z (3,0)
        let sides: [(usize, usize, [i32; 2]); 4] = [(0, 1, [-1, 0]), (1, 2, [0, 1]), (2, 3, [1, 0]), (3, 0, [0, -1])];
        for (f, (a, b, [nx, nz])) in sides.into_iter().enumerate() {
            let other = self.get(x + nx, y, z + nz);
            if is_water(other) {
                continue;
            }
            let closing = SOLID[other as usize];
            let n: V3 = [nx as f64, 0.0, nz as f64];
            let (ta, tb) = (tops[a], tops[b]);
            let foot = |k: usize| Corner { p: feet[k], n, wave: 0.0, wet: tops[k].wet };
            let quad = [foot(a), foot(b), Corner { n, ..tb }, Corner { n, ..ta }];
            // the side of the cell a fall starts in is falling water too: with the lying water's
            // look it was a blue pane standing on top of every fall
            let side_flow = if over_fall { [flow[0], 1.0, flow[2]] } else { flow };
            self.simple_quad([x, y, z], if closing { 17 } else { 1 } + f as u32, quad, side_flow, s.depth, foam, impact);
        }
        let below = self.get(x, y - 1, z);
        if !is_water(below) {
            let n: V3 = [0.0, -1.0, 0.0];
            let foot = |k: usize| Corner { p: feet[k], n, wave: 0.0, wet: tops[k].wet };
            self.simple_quad([x, y, z], if SOLID[below as usize] { 21 } else { 5 }, [foot(3), foot(2), foot(1), foot(0)], flow, s.depth, foam, impact);
        }
    }
}
