//! The water surface (rules and reasons in docs/WATER.md). THE mesher: the web calls it through
//! WASM (`apps/client/src/craft/waterMesher.ts`), the app directly. A box per water cell, the
//! corners of its top shared with the cells round it ("simple, like Minecraft" — the owner,
//! 2026-11-12). The surface net with its sheets, films and streams that stood here before, a port
//! of the web's `waterGeometry.ts`, was deleted on 2026-11-13 (git history has both). Checked by
//! the client's `water*.test.ts` on the committed WASM build.

use crate::blocks_gen::SOLID;
use crate::body::water_height;
use crate::fluid::{is_water, water_level, WATER_FALLING};
use crate::kit::{js_hypot, js_hypot_n};
use rustc_hash::FxHashMap;

type V3 = [f64; 3];

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
    depth_cache: FxHashMap<i64, f64>,
    sample_cache: FxHashMap<i64, Sample>,
    out: WaterMesh,
}

impl<G: Fn(i32, i32, i32) -> u8> Builder<'_, G> {
    fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        (self.get)(x, y, z)
    }
    fn solid(&self, x: i32, y: i32, z: i32) -> bool {
        SOLID[self.get(x, y, z) as usize]
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
}

// ---- the water: a box per cell ----------------------------------------------------------------
//
// The owner's call, 2026-11-12: "simple, like Minecraft — water that runs down". Every water cell
// is a box: its top stands at the cell's level, the four corners of that top are shared with the
// cells round them (so the surface runs on from cell to cell as one slope, from the spring to the
// last cell), falling water is a whole cell, and a cell under more water is full. A side is drawn
// toward air, the bottom over air; against a block only the closing faces (`WaterMesh::closure`),
// nothing against more water.

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

pub fn build_water_mesh<G: Fn(i32, i32, i32) -> u8>(get: &G, cells: &[[i32; 3]]) -> Option<WaterMesh> {
    let mut b = Builder { get, depth_cache: FxHashMap::default(), sample_cache: FxHashMap::default(), out: WaterMesh::default() };
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
