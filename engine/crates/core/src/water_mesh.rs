//! The water surface: a line-for-line port of `apps/client/src/craft/waterGeometry.ts`
//! `buildWaterGeometry` (component-aware surface nets on the voxel-centre lattice; see that file and
//! docs/WATER.md). The TypeScript stays the reference: `apps/client/test/rust-water-mesh.test.ts`
//! requires every attribute float32 and every index to be identical on randomized worlds, so a change
//! to waterGeometry.ts means the same change here. JavaScript's evaluation order and `Math.hypot`
//! (V8's, `kit::js_hypot` / `js_hypot_n`) are kept so the numbers agree bit for bit.

use crate::blocks_gen::SOLID;
use crate::body::water_height;
use crate::fluid::{is_water, water_level, WATER, WATER_FALLING};

/// How far a sheet of running water reaches from the face it runs down (m).
const SHEET: f64 = 0.34;
/// How far a fall's foot is pulled from the rounded average to the line where it meets the water below.
const JOIN: f64 = 0.8;
/// The same for running water's own foot (its height is exact).
const FOOT: f64 = 1.0;
/// How deep water lies over a shaped block it runs across (m).
const FILM: f64 = 0.22;
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
}

impl<G: Fn(i32, i32, i32) -> u8> Builder<'_, G> {
    fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        (self.get)(x, y, z)
    }
    fn solid(&self, x: i32, y: i32, z: i32) -> bool {
        SOLID[self.get(x, y, z) as usize]
    }
    fn deeply_inside_solid(&self, p: V3) -> bool {
        let (x, y, z) = (p[0].floor(), p[1].floor(), p[2].floor());
        self.solid(x as i32, y as i32, z as i32) && p[0] - x > 0.002 && p[1] - y > 0.002 && p[2] - z > 0.002 && p[0] - x < 0.998 && p[1] - y < 0.998 && p[2] - z < 0.998
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
        let loose = id == WATER_FALLING || id > WATER && id < WATER_FALLING && (below == 0 || below == WATER_FALLING);
        if loose {
            for (i, [sx, _, sz]) in HORIZONTAL.into_iter().enumerate() {
                if self.get(x + sx, y, z + sz) != 0 {
                    continue;
                }
                let back = self.get(x - sx, y, z - sz);
                // a shaped block holding water (any profile mark) is something to run off, like a solid
                let mut hug = SOLID[back as usize] || is_water(back) && (self.profile)(x - sx, y, z - sz) != 0;
                if !hug && is_water(back) {
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
                let wrap = solids == 1;
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
            let mut running = false;
            let mut constraints: [Option<f64>; 3] = [None; 3];
            let mut below: [Option<f64>; 3] = [None; 3];
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
                let h = if profile & 3 == 0 {
                    water_height(ids[wi], is_water(self.get(x, y + 1, z)))
                } else {
                    ((((profile >> (((1 - a[0]) + 2 * (1 - a[2])) * 2)) & 3) as f64 - 1.0) * 0.5 + FILM).min(1.0)
                };
                let mut p: V3 = [x as f64 + 0.5, y as f64 + h * 0.5, z as f64 + 0.5];
                let sign = (b[axis] - a[axis]) as f64;
                let code = self.sheet(x, y, z, ids[wi]);
                let thin = code & 7;
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
                        if near { SHEET } else { 1.0 }
                    } else if near {
                        0.0
                    } else {
                        1.0 - SHEET
                    };
                    p[axis] = (if axis == 0 { x } else { z }) as f64 + edge;
                } else if thin_axis != usize::MAX && {
                    let (wall, s) = (if near { -1 } else { 1 }, sign as i32);
                    SOLID[(if thin_axis == 0 { self.get(x + wall, y, z) } else { self.get(x, y, z + wall) }) as usize]
                        && is_water(if thin_axis == 0 { self.get(x + wall, y, z + s) } else { self.get(x + s, y, z + wall) })
                } {
                    // the sheet goes on round the block's corner, where the next face's sheet meets it
                    p[axis] += sign * (0.5 + SHEET);
                } else {
                    p[axis] += sign * 0.5;
                }
                points.push(p);
                axis_sum[axis] += p[axis];
                axis_count[axis] += 1.0;
                if axis == 1 && sign > 0.0 {
                    surface_heights.push(p[1]);
                } else if axis != 1 && a[1] == 1 {
                    side_sum[axis] += p[axis];
                    side_count[axis] += 1.0;
                }
                if ids[ai] == 0 || axis == 1 && sign > 0.0 && h < 0.999 {
                    normal[axis] += sign;
                }
                if SOLID[ids[ai] as usize] {
                    if axis == 1 || a[1] == 1 {
                        constraints[axis] = Some(p[axis]);
                    } else {
                        below[axis] = Some(p[axis]); // contact made by the water under what comes down
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
            if running {
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
                // the falling side keeps its own place where only the water below touches a block
                let held = constraints[axis].or(if side_count[axis] > 0.0 { None } else { below[axis] });
                if let Some(c) = held {
                    p[axis] = c;
                }
            }
            if normal[1] > 0.0 && normal[0] == 0.0 && normal[2] == 0.0 && !surface_heights.is_empty() {
                p[1] = surface_heights.iter().fold(0.0, |sum, h| sum + h) / surface_heights.len() as f64;
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
            let h = water_height(self.get(water[0], water[1], water[2]), is_water(self.get(water[0], water[1] + 1, water[2])));
            for cross in [u, v] {
                let sign = if water[cross] as f64 == a.grid[cross] { 1.0 } else { -1.0 };
                let mut point: V3 = [water[0] as f64 + 0.5, water[1] as f64 + h * 0.5, water[2] as f64 + 0.5];
                if cross == 1 {
                    point[1] = water[1] as f64 + if sign > 0.0 { h } else { 0.0 };
                } else {
                    point[cross] += sign * 0.5;
                }
                for j in 0..3 {
                    p[j] += point[j] / 2.0;
                }
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
    let mut b = Builder {
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
                let top_gap = axis == 1 && sign > 0 && SOLID[other_id as usize] && water_height(id, false) < 0.999;
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
    if b.out.indices.is_empty() {
        return Ok(None);
    }
    Ok(Some(b.out))
}

/// "Missing connected water surface component" (the TypeScript throws).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MissingComponent;
