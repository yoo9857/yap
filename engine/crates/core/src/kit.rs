//! The joined brick shell of a chunk's full cubes: a line-for-line port of
//! `apps/client/src/craft/kitShell.ts` (`kitCellsGeometry` without connectors, `kitFootprintGeometry`,
//! `kitContours`, `section`, `cleanLoop`, `KitMesh`) plus the three.js steps it runs through
//! (`computeVertexNormals`, the planar UVs, `translate`). The TypeScript stays the reference:
//! `apps/client/test/rust-kit.test.ts` requires the SAME float32 vertices, normals, colours and UVs.
//!
//! JavaScript computes in f64 and stores into Float32Array; this does the same (`as f32` rounds to
//! nearest-even like Float32Array). `Math.hypot` is V8's algorithm, not libm's, and triangulation
//! is three's earcut (`earcut.rs`).

use crate::earcut::{earcut, js_sort};
use rustc_hash::{FxHashMap, FxHashSet};

type P = (f64, f64);
type V = [f64; 3];

/// Is (x, y, z) a joined neighbour (a solid full cube the shell runs on into)? Answered from a box
/// the host fills; a question outside it counts as "no" and is recorded in `missed`.
pub struct JoinMask<'a> {
    pub x0: i32,
    pub y0: i32,
    pub z0: i32,
    pub sx: i32,
    pub sy: i32,
    pub sz: i32,
    pub cells: &'a [u8],
    pub missed: std::cell::Cell<u32>,
}

impl JoinMask<'_> {
    fn get(&self, x: f64, y: f64, z: f64) -> bool {
        let (x, y, z) = (x as i32 - self.x0, y as i32 - self.y0, z as i32 - self.z0);
        if x < 0 || y < 0 || z < 0 || x >= self.sx || y >= self.sy || z >= self.sz {
            self.missed.set(self.missed.get() + 1);
            return false;
        }
        self.cells[((y * self.sz + z) * self.sx + x) as usize] != 0
    }
}

/// V8's `Math.hypot` for two arguments (Kahan-compensated sum of squares scaled by the max).
pub fn js_hypot(a: f64, b: f64) -> f64 {
    let (aa, ab) = (a.abs(), b.abs());
    let nan = a.is_nan() || b.is_nan();
    let mut max = 0.0;
    if !a.is_nan() && aa > max {
        max = aa;
    }
    if !b.is_nan() && ab > max {
        max = ab;
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut compensation) = (0.0f64, 0.0f64);
    for v in [aa, ab] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

#[inline]
fn key(p: P) -> (i64, i64) {
    // contour points are whole cell corners; JS keys them by `p.join(",")`
    (p.0 as i64, p.1 as i64)
}

/// `KitMesh`: explicit winding, positions and colours as JS numbers until `geometry()`.
#[derive(Default)]
struct KitMesh {
    pos: Vec<f64>,
    colours: Vec<f64>,
}

impl KitMesh {
    fn tri(&mut self, a: V, b: V, c: V, n: V, shade: f64) {
        let (ux, uy, uz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        let (vx, vy, vz) = (c[0] - a[0], c[1] - a[1], c[2] - a[2]);
        let cx = uy * vz - uz * vy;
        let cy = uz * vx - ux * vz;
        let cz = ux * vy - uy * vx;
        if cx * cx + cy * cy + cz * cz < 1e-16 {
            return;
        }
        let (b, c) = if cx * n[0] + cy * n[1] + cz * n[2] < 0.0 { (c, b) } else { (b, c) };
        self.pos.extend_from_slice(&a);
        self.pos.extend_from_slice(&b);
        self.pos.extend_from_slice(&c);
        for _ in 0..9 {
            self.colours.push(shade);
        }
    }
    fn quad(&mut self, a: V, b: V, c: V, d: V, n: V, shade: f64) {
        self.tri(a, b, c, n, shade);
        self.tri(a, c, d, n, shade);
    }
    fn plane(&mut self, outline: &[P], holes: &[&[P]], y: f64, up: bool, shade: f64) {
        let mut outer = clean_loop(outline, 1e-6);
        let mut inner: Vec<Vec<P>> = holes.iter().map(|h| clean_loop(h, 1e-6)).filter(|h| h.len() >= 3).collect();
        let mut all: Vec<P> = outer.clone();
        for h in &inner {
            all.extend_from_slice(h);
        }
        if outer.len() < 3 {
            return;
        }
        // THREE.ShapeUtils.triangulateShape (removeDupEndPts mutates the loops, not `all`)
        let remove_dup_end = |pts: &mut Vec<P>| {
            let l = pts.len();
            if l > 2 && pts[l - 1] == pts[0] {
                pts.pop();
            }
        };
        let mut vertices: Vec<f64> = Vec::with_capacity(all.len() * 2);
        remove_dup_end(&mut outer);
        for p in &outer {
            vertices.push(p.0);
            vertices.push(p.1);
        }
        let mut hole_index = outer.len();
        for h in inner.iter_mut() {
            remove_dup_end(h);
        }
        let mut hole_indices = Vec::with_capacity(inner.len());
        for h in &inner {
            hole_indices.push(hole_index);
            hole_index += h.len();
            for p in h {
                vertices.push(p.0);
                vertices.push(p.1);
            }
        }
        let tris = earcut(&vertices, &hole_indices);
        let ny = if up { 1.0 } else { -1.0 };
        for t in tris.as_chunks::<3>().0 {
            let (pa, pb, pc) = (all[t[0] as usize], all[t[1] as usize], all[t[2] as usize]);
            self.tri([pa.0, y, pa.1], [pb.0, y, pb.1], [pc.0, y, pc.1], [0.0, ny, 0.0], shade);
        }
    }
    fn wall(&mut self, lower: &[P], upper: &[P], low: f64, high: f64, shade: f64) {
        let len = lower.len();
        for i in 0..len {
            let j = (i + 1) % len;
            let (a, b, c, d) = (lower[i], lower[j], upper[j], upper[i]);
            let s = 1.0;
            self.quad([a.0, low, a.1], [b.0, low, b.1], [c.0, high, c.1], [d.0, high, d.1], [s * (b.1 - a.1), 0.0, s * (a.0 - b.0)], shade);
        }
    }
}

/// `KitMesh.geometry()`: Float32 attributes, `computeVertexNormals` (triangle soup), planar UVs.
pub struct Geometry {
    pub pos: Vec<f32>,
    pub nrm: Vec<f32>,
    pub col: Vec<f32>,
    pub uv: Vec<f32>,
}

fn normalize3(x: f64, y: f64, z: f64) -> (f64, f64, f64) {
    let len = (x * x + y * y + z * z).sqrt();
    let scalar = if len == 0.0 || len.is_nan() { 1.0 } else { len };
    let s = 1.0 / scalar;
    (x * s, y * s, z * s)
}

impl KitMesh {
    fn geometry(self) -> Geometry {
        let pos: Vec<f32> = self.pos.iter().map(|v| *v as f32).collect();
        let col: Vec<f32> = self.colours.iter().map(|v| *v as f32).collect();
        let count = pos.len() / 3;
        let mut nrm = vec![0f32; pos.len()];
        let at = |i: usize| (pos[i * 3] as f64, pos[i * 3 + 1] as f64, pos[i * 3 + 2] as f64);
        let mut i = 0;
        while i < count {
            let (a, b, c) = (at(i), at(i + 1), at(i + 2));
            let (cbx, cby, cbz) = (c.0 - b.0, c.1 - b.1, c.2 - b.2);
            let (abx, aby, abz) = (a.0 - b.0, a.1 - b.1, a.2 - b.2);
            let x = cby * abz - cbz * aby;
            let y = cbz * abx - cbx * abz;
            let z = cbx * aby - cby * abx;
            for k in 0..3 {
                nrm[(i + k) * 3] = x as f32;
                nrm[(i + k) * 3 + 1] = y as f32;
                nrm[(i + k) * 3 + 2] = z as f32;
            }
            i += 3;
        }
        for k in 0..count {
            let (x, y, z) = normalize3(nrm[k * 3] as f64, nrm[k * 3 + 1] as f64, nrm[k * 3 + 2] as f64);
            nrm[k * 3] = x as f32;
            nrm[k * 3 + 1] = y as f32;
            nrm[k * 3 + 2] = z as f32;
        }
        let mut uv = vec![0f32; count * 2];
        for k in 0..count {
            let (nx, ny, nz) = (nrm[k * 3] as f64, nrm[k * 3 + 1] as f64, nrm[k * 3 + 2] as f64);
            let (ax, ay, az) = (nx.abs(), ny.abs(), nz.abs());
            let (u, v);
            if ay >= ax && ay >= az {
                let s = -nx;
                let uu = normalize3(1.0 + nx * s, 0.0 + ny * s, 0.0 + nz * s);
                u = uu;
                v = (ny * uu.2 - nz * uu.1, nz * uu.0 - nx * uu.2, nx * uu.1 - ny * uu.0);
            } else {
                let s = -ny;
                let vv = normalize3(0.0 + nx * s, 1.0 + ny * s, 0.0 + nz * s);
                v = vv;
                u = (vv.1 * nz - vv.2 * ny, vv.2 * nx - vv.0 * nz, vv.0 * ny - vv.1 * nx);
            }
            let p = at(k);
            uv[k * 2] = (p.0 * u.0 + p.1 * u.1 + p.2 * u.2) as f32;
            uv[k * 2 + 1] = (p.0 * v.0 + p.1 * v.1 + p.2 * v.2) as f32;
        }
        Geometry { pos, nrm, col, uv }
    }
}

/// `cleanLoop`: no near-duplicate points, no (near-)collinear ones.
pub fn clean_loop(lp: &[P], eps: f64) -> Vec<P> {
    let n = lp.len();
    let mut pts: Vec<P> = (0..n)
        .filter(|&i| {
            let (p, q) = (lp[i], lp[(i + 1) % n]);
            js_hypot(p.0 - q.0, p.1 - q.1) > eps
        })
        .map(|i| lp[i])
        .collect();
    let mut changed = true;
    while changed && pts.len() > 3 {
        changed = false;
        let mut i: isize = 0;
        while (i as usize) < pts.len() && pts.len() > 3 {
            let len = pts.len();
            let iu = i as usize;
            let (a, p, b) = (pts[(iu + len - 1) % len], pts[iu], pts[(iu + 1) % len]);
            if ((p.0 - a.0) * (b.1 - a.1) - (p.1 - a.1) * (b.0 - a.0)).abs() <= eps * eps * 10.0 {
                pts.remove(iu);
                changed = true;
                i -= 1;
            }
            i += 1;
        }
    }
    pts
}

fn area(lp: &[P]) -> f64 {
    let n = lp.len();
    let mut v = 0.0;
    for i in 0..n {
        let (p, q) = (lp[i], lp[(i + 1) % n]);
        // JS: `v + p[0]*q[1] - q[0]*p[1]` (left to right)
        v = v + p.0 * q.1 - q.0 * p.1;
    }
    v / 2.0
}

struct Edge {
    a: P,
    b: P,
    used: bool,
}

/// `kitContours`: the union outline loops of a layer's cells (holes kept).
pub fn kit_contours(cells: &[(i32, i32)]) -> Result<Vec<Vec<P>>, &'static str> {
    let occupied: FxHashSet<(i32, i32)> = cells.iter().copied().collect();
    let mut edges: Vec<Edge> = Vec::with_capacity(cells.len() * 2);
    for &(x, z) in cells {
        let (fx, fz) = (x as f64, z as f64);
        if !occupied.contains(&(x, z - 1)) {
            edges.push(Edge { a: (fx, fz), b: (fx + 1.0, fz), used: false });
        }
        if !occupied.contains(&(x + 1, z)) {
            edges.push(Edge { a: (fx + 1.0, fz), b: (fx + 1.0, fz + 1.0), used: false });
        }
        if !occupied.contains(&(x, z + 1)) {
            edges.push(Edge { a: (fx + 1.0, fz + 1.0), b: (fx, fz + 1.0), used: false });
        }
        if !occupied.contains(&(x - 1, z)) {
            edges.push(Edge { a: (fx, fz + 1.0), b: (fx, fz), used: false });
        }
    }
    let mut starts: FxHashMap<(i64, i64), Vec<usize>> = FxHashMap::default();
    for (i, e) in edges.iter().enumerate() {
        starts.entry(key(e.a)).or_default().push(i);
    }
    let mut loops = Vec::new();
    for first in 0..edges.len() {
        if edges[first].used {
            continue;
        }
        let mut lp: Vec<P> = Vec::new();
        let mut e = first;
        for _guard in 0..=edges.len() {
            edges[e].used = true;
            lp.push(edges[e].a);
            if key(edges[e].b) == key(edges[first].a) {
                break;
            }
            let (ea, eb) = (edges[e].a, edges[e].b);
            let mut choices: Vec<usize> = starts.get(&key(eb)).map(|l| l.iter().copied().filter(|&v| !edges[v].used).collect()).unwrap_or_default();
            let (dx, dz) = (eb.0 - ea.0, eb.1 - ea.1);
            let turn = |v: usize| {
                let (va, vb) = (edges[v].a, edges[v].b);
                (dx * (vb.1 - va.1) - dz * (vb.0 - va.0)).atan2(dx * (vb.0 - va.0) + dz * (vb.1 - va.1))
            };
            js_sort(&mut choices, |a, b| turn(*b) - turn(*a));
            match choices.first() {
                Some(&c) => e = c,
                None => return Err("Open kit contour"),
            }
        }
        if lp.len() >= 4 {
            loops.push(lp);
        }
    }
    Ok(loops)
}

/// `section`: a loop inset by `inset`, 0 along joined edges, 0.01 against `contact`, with
/// rounded corners (a quadratic Bézier, 4 points) where both sides are inset.
fn section(lp: &[P], inset: f64, joined: Option<&dyn Fn(f64, f64) -> bool>, contact: Option<&dyn Fn(f64, f64) -> bool>) -> Vec<P> {
    let count = lp.len() as isize;
    let at = |i: isize| lp[(((i % count) + count) % count) as usize];
    let edge = |i: isize| -> P {
        let (a, b) = (at(i), at(i + 1));
        let len = js_hypot(b.0 - a.0, b.1 - a.1);
        ((b.0 - a.0) / len, (b.1 - a.1) / len)
    };
    let distance = |i: isize| -> f64 {
        let (a, b, d) = (at(i), at(i + 1), edge(i));
        if let Some(j) = joined {
            if j(((a.0 + b.0) / 2.0 + d.1 * 0.1).floor(), ((a.1 + b.1) / 2.0 - d.0 * 0.1).floor()) {
                return 0.0;
            }
        }
        if let Some(c) = contact {
            if c(((a.0 + b.0) / 2.0 - d.1 * 0.1).floor(), ((a.1 + b.1) / 2.0 + d.0 * 0.1).floor()) {
                return 0.01;
            }
        }
        inset
    };
    let mut out = Vec::with_capacity(lp.len() * 4);
    for i in 0..count {
        let p = lp[i as usize];
        let (a, b, da, db) = (edge(i - 1), edge(i), distance(i - 1), distance(i));
        let cross = a.0 * b.1 - a.1 * b.0;
        if cross.abs() < 1e-6 {
            out.push((p.0 - b.1 * db, p.1 + b.0 * db));
            continue;
        }
        let c: P = (p.0 - a.1 * da - b.1 * db, p.1 + a.0 * da + b.0 * db);
        let r = if da == 0.0 || db == 0.0 { 0.0 } else { 0.035 };
        let f: P = (c.0 - a.0 * r, c.1 - a.1 * r);
        let t: P = (c.0 + b.0 * r, c.1 + b.1 * r);
        for j in 0..=3 {
            let v = j as f64 / 3.0;
            let u = 1.0 - v;
            out.push((u * u * f.0 + 2.0 * u * v * c.0 + v * v * t.0, u * u * f.1 + 2.0 * u * v * c.1 + v * v * t.1));
        }
    }
    out
}

const PROFILE: [(f64, f64, f64); 6] = [(0.0, 0.032, 1.0), (0.012, 0.016, 1.0), (0.04, 0.01, 1.0), (0.96, 0.01, 1.0), (0.988, 0.016, 1.0), (1.0, 0.032, 1.0)];

/// `kitFootprintGeometry(cells, joined, stacked)` for one layer.
fn footprint(cells: &[(i32, i32)], joined: &dyn Fn(f64, f64) -> bool, stacked: &dyn Fn(f64, f64, i32) -> bool) -> Result<Geometry, &'static str> {
    let mut mesh = KitMesh::default();
    let raw = kit_contours(cells)?;
    let joined_edge = |v: P, w: P| joined(((v.0 + w.0) / 2.0 + (w.1 - v.1) * 0.1).floor(), ((v.1 + w.1) / 2.0 - (w.0 - v.0) * 0.1).floor());
    let stacked_edge = |v: P, w: P, dy: i32| {
        let length = js_hypot(w.0 - v.0, w.1 - v.1);
        stacked(((v.0 + w.0) / 2.0 - (w.1 - v.1) / length * 0.1).floor(), ((v.1 + w.1) / 2.0 + (w.0 - v.0) / length * 0.1).floor(), dy)
    };
    let loops: Vec<Vec<P>> = raw
        .iter()
        .map(|lp| {
            let n = lp.len();
            (0..n)
                .filter(|&i| {
                    let (a, p, b) = (lp[(i + n - 1) % n], lp[i], lp[(i + 1) % n]);
                    if (p.0 - a.0) * (b.1 - p.1) - (p.1 - a.1) * (b.0 - p.0) != 0.0 {
                        return true;
                    }
                    joined_edge(a, p) != joined_edge(p, b) || stacked_edge(a, p, 1) != stacked_edge(p, b, 1) || stacked_edge(a, p, -1) != stacked_edge(p, b, -1)
                })
                .map(|i| lp[i])
                .collect()
        })
        .collect();
    let sections: Vec<Vec<Vec<P>>> = loops
        .iter()
        .map(|lp| {
            PROFILE
                .iter()
                .map(|&(y, d, _)| {
                    if y < 0.041 || y > 0.959 {
                        let dy = if y < 0.041 { -1 } else { 1 };
                        let contact = move |x: f64, z: f64| stacked(x, z, dy);
                        section(lp, d, Some(joined), Some(&contact))
                    } else {
                        section(lp, d, Some(joined), None)
                    }
                })
                .collect()
        })
        .collect();
    for s in &sections {
        for i in 1..PROFILE.len() {
            mesh.wall(&s[i - 1], &s[i], PROFILE[i - 1].0, PROFILE[i].0, PROFILE[i].2);
        }
    }
    let areas: Vec<f64> = loops.iter().map(|l| area(l)).collect();
    for l in 0..loops.len() {
        if areas[l] <= 0.0 {
            continue;
        }
        let poly = &loops[l];
        let contains = |p: P| {
            let mut inside = false;
            let n = poly.len();
            let mut j = n - 1;
            for i in 0..n {
                let (a, b) = (poly[i], poly[j]);
                if (a.1 > p.1) != (b.1 > p.1) && p.0 < (b.0 - a.0) * (p.1 - a.1) / (b.1 - a.1) + a.0 {
                    inside = !inside;
                }
                j = i;
            }
            inside
        };
        let holes: Vec<usize> = (0..loops.len()).filter(|&i| areas[i] < 0.0 && contains(loops[i][0])).collect();
        let top: Vec<&[P]> = holes.iter().map(|&h| sections[h].last().unwrap().as_slice()).collect();
        mesh.plane(sections[l].last().unwrap(), &top, 1.0, true, 1.0);
        let bottom: Vec<&[P]> = holes.iter().map(|&h| sections[h][0].as_slice()).collect();
        mesh.plane(&sections[l][0], &bottom, 0.0, false, 1.0);
    }
    Ok(mesh.geometry())
}

/// `kitCellsGeometry(cells, false, joined)`: one footprint per layer (in order of first
/// appearance), each translated to its height, concatenated.
pub fn kit_cells_geometry(cells: &[(i32, i32, i32)], mask: &JoinMask) -> Result<Geometry, &'static str> {
    let mut order: Vec<i32> = Vec::new();
    let mut layers: FxHashMap<i32, Vec<(i32, i32)>> = FxHashMap::default();
    let occupied: FxHashSet<(i32, i32, i32)> = cells.iter().copied().collect();
    for &(x, y, z) in cells {
        let layer = layers.entry(y).or_insert_with(|| {
            order.push(y);
            Vec::new()
        });
        layer.push((x, z));
    }
    let mut out = Geometry { pos: Vec::new(), nrm: Vec::new(), col: Vec::new(), uv: Vec::new() };
    for y in order {
        let layer = &layers[&y];
        let fy = y as f64;
        let joined = |x: f64, z: f64| mask.get(x, fy, z);
        let stacked = |x: f64, z: f64, dy: i32| occupied.contains(&(x as i32, y + dy, z as i32)) || mask.get(x, fy + dy as f64, z);
        let g = footprint(layer, &joined, &stacked)?;
        // BufferGeometry.translate(0, y, 0): applyMatrix4 on positions, the normal matrix on normals
        for k in 0..g.pos.len() / 3 {
            let (x, yy, z) = (g.pos[k * 3] as f64, g.pos[k * 3 + 1] as f64, g.pos[k * 3 + 2] as f64);
            let w = 1.0 / (0.0 * x + 0.0 * yy + 0.0 * z + 1.0);
            out.pos.push(((1.0 * x + 0.0 * yy + 0.0 * z + 0.0) * w) as f32);
            out.pos.push(((0.0 * x + 1.0 * yy + 0.0 * z + fy) * w) as f32);
            out.pos.push(((0.0 * x + 0.0 * yy + 1.0 * z + 0.0) * w) as f32);
            let (nx, ny, nz) = (g.nrm[k * 3] as f64, g.nrm[k * 3 + 1] as f64, g.nrm[k * 3 + 2] as f64);
            let (mx, my, mz) = normalize3(1.0 * nx + 0.0 * ny + 0.0 * nz, 0.0 * nx + 1.0 * ny + 0.0 * nz, 0.0 * nx + 0.0 * ny + 1.0 * nz);
            out.nrm.push(mx as f32);
            out.nrm.push(my as f32);
            out.nrm.push(mz as f32);
        }
        out.col.extend_from_slice(&g.col);
        out.uv.extend_from_slice(&g.uv);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hypot_matches_v8_on_simple_values() {
        assert_eq!(js_hypot(3.0, 4.0), 5.0);
        assert_eq!(js_hypot(0.0, -0.0), 0.0);
        assert!(js_hypot(f64::NAN, 1.0).is_nan());
        assert_eq!(js_hypot(f64::NAN, f64::INFINITY), f64::INFINITY);
    }

    #[test]
    fn an_l_shape_is_one_loop_of_six_corners() {
        let loops = kit_contours(&[(0, 0), (1, 0), (0, 1)]).unwrap();
        assert_eq!(loops.len(), 1);
        let corners = loops[0].len();
        assert!(corners >= 6, "{corners}");
    }

    #[test]
    fn a_ring_has_an_outer_loop_and_a_hole() {
        let mut cells = Vec::new();
        for x in 0..3 {
            for z in 0..3 {
                if (x, z) != (1, 1) {
                    cells.push((x, z));
                }
            }
        }
        let loops = kit_contours(&cells).unwrap();
        assert_eq!(loops.len(), 2);
        let areas: Vec<f64> = loops.iter().map(|l| area(l)).collect();
        assert!(areas.iter().any(|a| *a > 0.0) && areas.iter().any(|a| *a < 0.0));
    }

    #[test]
    fn one_cube_is_a_closed_shell() {
        let mask = JoinMask { x0: -1, y0: -1, z0: -1, sx: 3, sy: 3, sz: 3, cells: &[0; 27], missed: Default::default() };
        let g = kit_cells_geometry(&[(0, 0, 0)], &mask).unwrap();
        assert_eq!(mask.missed.get(), 0);
        assert!(g.pos.len() > 100);
        assert_eq!(g.pos.len(), g.nrm.len());
        assert_eq!(g.uv.len() / 2, g.pos.len() / 3);
        // inside the unit cell
        assert!(g.pos.iter().all(|v| (0.0..=1.0).contains(v)));
    }
}
