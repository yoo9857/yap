//! A line-for-line port of earcut 3.0.1 as three.js r176 ships it
//! (`three/src/extras/lib/earcut.js`), so a triangulation here returns the SAME triangles in the
//! SAME order as `THREE.ShapeUtils.triangulateShape` in the game. `kit.rs` depends on that for
//! bit-identical brick shells (checked by `apps/client/test/rust-kit.test.ts`).
//!
//! Nodes live in an arena (`Vec<Node>`) and link by index; `NIL` stands for JS `null`.

const NIL: usize = usize::MAX;

#[derive(Clone)]
struct Node {
    i: usize,
    x: f64,
    y: f64,
    prev: usize,
    next: usize,
    z: i32,
    prev_z: usize,
    next_z: usize,
    steiner: bool,
}

struct Ctx {
    n: Vec<Node>,
}

impl Ctx {
    #[inline]
    fn x(&self, p: usize) -> f64 {
        self.n[p].x
    }
    #[inline]
    fn y(&self, p: usize) -> f64 {
        self.n[p].y
    }
    #[inline]
    fn next(&self, p: usize) -> usize {
        self.n[p].next
    }
    #[inline]
    fn prev(&self, p: usize) -> usize {
        self.n[p].prev
    }

    fn create_node(&mut self, i: usize, x: f64, y: f64) -> usize {
        self.n.push(Node { i, x, y, prev: NIL, next: NIL, z: 0, prev_z: NIL, next_z: NIL, steiner: false });
        self.n.len() - 1
    }

    fn insert_node(&mut self, i: usize, x: f64, y: f64, last: usize) -> usize {
        let p = self.create_node(i, x, y);
        if last == NIL {
            self.n[p].prev = p;
            self.n[p].next = p;
        } else {
            let ln = self.n[last].next;
            self.n[p].next = ln;
            self.n[p].prev = last;
            self.n[ln].prev = p;
            self.n[last].next = p;
        }
        p
    }

    fn remove_node(&mut self, p: usize) {
        let (pn, pp) = (self.n[p].next, self.n[p].prev);
        self.n[pn].prev = pp;
        self.n[pp].next = pn;
        let (pz, nz) = (self.n[p].prev_z, self.n[p].next_z);
        if pz != NIL {
            self.n[pz].next_z = nz;
        }
        if nz != NIL {
            self.n[nz].prev_z = pz;
        }
    }

    #[inline]
    fn area(&self, p: usize, q: usize, r: usize) -> f64 {
        (self.y(q) - self.y(p)) * (self.x(r) - self.x(q)) - (self.x(q) - self.x(p)) * (self.y(r) - self.y(q))
    }
    #[inline]
    fn equals(&self, a: usize, b: usize) -> bool {
        self.x(a) == self.x(b) && self.y(a) == self.y(b)
    }

    fn linked_list(&mut self, data: &[f64], start: usize, end: usize, dim: usize, clockwise: bool) -> usize {
        let mut last = NIL;
        if clockwise == (signed_area(data, start, end, dim) > 0.0) {
            let mut i = start;
            while i < end {
                last = self.insert_node(i / dim, data[i], data[i + 1], last);
                i += dim;
            }
        } else {
            let mut i = end as isize - dim as isize;
            while i >= start as isize {
                let u = i as usize;
                last = self.insert_node(u / dim, data[u], data[u + 1], last);
                i -= dim as isize;
            }
        }
        if last != NIL && self.equals(last, self.next(last)) {
            self.remove_node(last);
            last = self.next(last);
        }
        last
    }

    fn filter_points(&mut self, start: usize, end: usize) -> usize {
        if start == NIL {
            return start;
        }
        let mut end = if end == NIL { start } else { end };
        let mut p = start;
        loop {
            let mut again = false;
            if !self.n[p].steiner && (self.equals(p, self.next(p)) || self.area(self.prev(p), p, self.next(p)) == 0.0) {
                self.remove_node(p);
                p = self.prev(p);
                end = p;
                if p == self.next(p) {
                    break;
                }
                again = true;
            } else {
                p = self.next(p);
            }
            if !(again || p != end) {
                break;
            }
        }
        end
    }

    #[allow(clippy::too_many_arguments)]
    fn earcut_linked(&mut self, ear: usize, tri: &mut Vec<u32>, dim: usize, min_x: f64, min_y: f64, inv_size: f64, pass: u8) {
        if ear == NIL {
            return;
        }
        let mut ear = ear;
        if pass == 0 && inv_size != 0.0 {
            self.index_curve(ear, min_x, min_y, inv_size);
        }
        let mut stop = ear;
        while self.prev(ear) != self.next(ear) {
            let prev = self.prev(ear);
            let next = self.next(ear);
            let is_ear = if inv_size != 0.0 { self.is_ear_hashed(ear, min_x, min_y, inv_size) } else { self.is_ear(ear) };
            if is_ear {
                tri.push(self.n[prev].i as u32);
                tri.push(self.n[ear].i as u32);
                tri.push(self.n[next].i as u32);
                self.remove_node(ear);
                ear = self.next(next);
                stop = self.next(next);
                continue;
            }
            ear = next;
            if ear == stop {
                if pass == 0 {
                    let f = self.filter_points(ear, NIL);
                    self.earcut_linked(f, tri, dim, min_x, min_y, inv_size, 1);
                } else if pass == 1 {
                    let f = self.filter_points(ear, NIL);
                    let e = self.cure_local_intersections(f, tri);
                    self.earcut_linked(e, tri, dim, min_x, min_y, inv_size, 2);
                } else if pass == 2 {
                    self.split_earcut(ear, tri, dim, min_x, min_y, inv_size);
                }
                break;
            }
        }
    }

    fn is_ear(&self, ear: usize) -> bool {
        let (a, b, c) = (self.prev(ear), ear, self.next(ear));
        if self.area(a, b, c) >= 0.0 {
            return false;
        }
        let (ax, bx, cx, ay, by, cy) = (self.x(a), self.x(b), self.x(c), self.y(a), self.y(b), self.y(c));
        let x0 = js_min3(ax, bx, cx);
        let y0 = js_min3(ay, by, cy);
        let x1 = js_max3(ax, bx, cx);
        let y1 = js_max3(ay, by, cy);
        let mut p = self.next(c);
        while p != a {
            let (px, py) = (self.x(p), self.y(p));
            if px >= x0
                && px <= x1
                && py >= y0
                && py <= y1
                && point_in_triangle_except_first(ax, ay, bx, by, cx, cy, px, py)
                && self.area(self.prev(p), p, self.next(p)) >= 0.0
            {
                return false;
            }
            p = self.next(p);
        }
        true
    }

    fn is_ear_hashed(&self, ear: usize, min_x: f64, min_y: f64, inv_size: f64) -> bool {
        let (a, b, c) = (self.prev(ear), ear, self.next(ear));
        if self.area(a, b, c) >= 0.0 {
            return false;
        }
        let (ax, bx, cx, ay, by, cy) = (self.x(a), self.x(b), self.x(c), self.y(a), self.y(b), self.y(c));
        let x0 = js_min3(ax, bx, cx);
        let y0 = js_min3(ay, by, cy);
        let x1 = js_max3(ax, bx, cx);
        let y1 = js_max3(ay, by, cy);
        let min_z = z_order(x0, y0, min_x, min_y, inv_size);
        let max_z = z_order(x1, y1, min_x, min_y, inv_size);
        let mut p = self.n[ear].prev_z;
        let mut n = self.n[ear].next_z;
        let inside = |q: usize| -> bool {
            let (qx, qy) = (self.x(q), self.y(q));
            qx >= x0
                && qx <= x1
                && qy >= y0
                && qy <= y1
                && q != a
                && q != c
                && point_in_triangle_except_first(ax, ay, bx, by, cx, cy, qx, qy)
                && self.area(self.prev(q), q, self.next(q)) >= 0.0
        };
        while p != NIL && self.n[p].z >= min_z && n != NIL && self.n[n].z <= max_z {
            if inside(p) {
                return false;
            }
            p = self.n[p].prev_z;
            if inside(n) {
                return false;
            }
            n = self.n[n].next_z;
        }
        while p != NIL && self.n[p].z >= min_z {
            if inside(p) {
                return false;
            }
            p = self.n[p].prev_z;
        }
        while n != NIL && self.n[n].z <= max_z {
            if inside(n) {
                return false;
            }
            n = self.n[n].next_z;
        }
        true
    }

    fn cure_local_intersections(&mut self, start: usize, tri: &mut Vec<u32>) -> usize {
        let mut start = start;
        let mut p = start;
        loop {
            let a = self.prev(p);
            let b = self.next(self.next(p));
            if !self.equals(a, b) && self.intersects(a, p, self.next(p), b) && self.locally_inside(a, b) && self.locally_inside(b, a) {
                tri.push(self.n[a].i as u32);
                tri.push(self.n[p].i as u32);
                tri.push(self.n[b].i as u32);
                self.remove_node(p);
                let pn = self.next(p);
                self.remove_node(pn);
                p = b;
                start = b;
            }
            p = self.next(p);
            if p == start {
                break;
            }
        }
        self.filter_points(p, NIL)
    }

    fn split_earcut(&mut self, start: usize, tri: &mut Vec<u32>, dim: usize, min_x: f64, min_y: f64, inv_size: f64) {
        let mut a = start;
        loop {
            let mut b = self.next(self.next(a));
            while b != self.prev(a) {
                if self.n[a].i != self.n[b].i && self.is_valid_diagonal(a, b) {
                    let mut c = self.split_polygon(a, b);
                    let an = self.next(a);
                    a = self.filter_points(a, an);
                    let cn = self.next(c);
                    c = self.filter_points(c, cn);
                    self.earcut_linked(a, tri, dim, min_x, min_y, inv_size, 0);
                    self.earcut_linked(c, tri, dim, min_x, min_y, inv_size, 0);
                    return;
                }
                b = self.next(b);
            }
            a = self.next(a);
            if a == start {
                break;
            }
        }
    }

    fn eliminate_holes(&mut self, data: &[f64], hole_indices: &[usize], outer: usize, dim: usize) -> usize {
        let mut queue: Vec<usize> = Vec::with_capacity(hole_indices.len());
        let len = hole_indices.len();
        for i in 0..len {
            let start = hole_indices[i] * dim;
            let end = if i < len - 1 { hole_indices[i + 1] * dim } else { data.len() };
            let list = self.linked_list(data, start, end, dim, false);
            if list == self.next(list) {
                self.n[list].steiner = true;
            }
            queue.push(self.get_leftmost(list));
        }
        js_sort(&mut queue, |a, b| self.compare_xy_slope(*a, *b));
        let mut outer = outer;
        for h in queue {
            outer = self.eliminate_hole(h, outer);
        }
        outer
    }

    fn compare_xy_slope(&self, a: usize, b: usize) -> f64 {
        let mut result = self.x(a) - self.x(b);
        if result == 0.0 {
            result = self.y(a) - self.y(b);
            if result == 0.0 {
                let (an, bn) = (self.next(a), self.next(b));
                let a_slope = (self.y(an) - self.y(a)) / (self.x(an) - self.x(a));
                let b_slope = (self.y(bn) - self.y(b)) / (self.x(bn) - self.x(b));
                result = a_slope - b_slope;
            }
        }
        result
    }

    fn eliminate_hole(&mut self, hole: usize, outer: usize) -> usize {
        let bridge = self.find_hole_bridge(hole, outer);
        if bridge == NIL {
            return outer;
        }
        let bridge_reverse = self.split_polygon(bridge, hole);
        let brn = self.next(bridge_reverse);
        self.filter_points(bridge_reverse, brn);
        let bn = self.next(bridge);
        self.filter_points(bridge, bn)
    }

    fn find_hole_bridge(&self, hole: usize, outer: usize) -> usize {
        let mut p = outer;
        let hx = self.x(hole);
        let hy = self.y(hole);
        let mut qx = f64::NEG_INFINITY;
        let mut m = NIL;
        if self.equals(hole, p) {
            return p;
        }
        loop {
            let pn = self.next(p);
            if self.equals(hole, pn) {
                return pn;
            } else if hy <= self.y(p) && hy >= self.y(pn) && self.y(pn) != self.y(p) {
                let x = self.x(p) + (hy - self.y(p)) * (self.x(pn) - self.x(p)) / (self.y(pn) - self.y(p));
                if x <= hx && x > qx {
                    qx = x;
                    m = if self.x(p) < self.x(pn) { p } else { pn };
                    if x == hx {
                        return m;
                    }
                }
            }
            p = pn;
            if p == outer {
                break;
            }
        }
        if m == NIL {
            return NIL;
        }
        let stop = m;
        let mx = self.x(m);
        let my = self.y(m);
        let mut tan_min = f64::INFINITY;
        p = m;
        loop {
            let (px, py) = (self.x(p), self.y(p));
            if hx >= px
                && px >= mx
                && hx != px
                && point_in_triangle(if hy < my { hx } else { qx }, hy, mx, my, if hy < my { qx } else { hx }, hy, px, py)
            {
                let tan = (hy - py).abs() / (hx - px);
                if self.locally_inside(p, hole)
                    && (tan < tan_min || (tan == tan_min && (px > self.x(m) || (px == self.x(m) && self.sector_contains_sector(m, p)))))
                {
                    m = p;
                    tan_min = tan;
                }
            }
            p = self.next(p);
            if p == stop {
                break;
            }
        }
        m
    }

    fn sector_contains_sector(&self, m: usize, p: usize) -> bool {
        self.area(self.prev(m), m, self.prev(p)) < 0.0 && self.area(self.next(p), m, self.next(m)) < 0.0
    }

    fn index_curve(&mut self, start: usize, min_x: f64, min_y: f64, inv_size: f64) {
        let mut p = start;
        loop {
            if self.n[p].z == 0 {
                self.n[p].z = z_order(self.x(p), self.y(p), min_x, min_y, inv_size);
            }
            self.n[p].prev_z = self.n[p].prev;
            self.n[p].next_z = self.n[p].next;
            p = self.next(p);
            if p == start {
                break;
            }
        }
        let pz = self.n[p].prev_z;
        self.n[pz].next_z = NIL;
        self.n[p].prev_z = NIL;
        self.sort_linked(p);
    }

    fn sort_linked(&mut self, list: usize) -> usize {
        let mut list = list;
        let mut in_size = 1;
        loop {
            let mut p = list;
            list = NIL;
            let mut tail = NIL;
            let mut num_merges = 0;
            while p != NIL {
                num_merges += 1;
                let mut q = p;
                let mut p_size = 0;
                for _ in 0..in_size {
                    p_size += 1;
                    q = self.n[q].next_z;
                    if q == NIL {
                        break;
                    }
                }
                let mut q_size = in_size;
                while p_size > 0 || (q_size > 0 && q != NIL) {
                    let e;
                    if p_size != 0 && (q_size == 0 || q == NIL || self.n[p].z <= self.n[q].z) {
                        e = p;
                        p = self.n[p].next_z;
                        p_size -= 1;
                    } else {
                        e = q;
                        q = self.n[q].next_z;
                        q_size -= 1;
                    }
                    if tail != NIL {
                        self.n[tail].next_z = e;
                    } else {
                        list = e;
                    }
                    self.n[e].prev_z = tail;
                    tail = e;
                }
                p = q;
            }
            self.n[tail].next_z = NIL;
            in_size *= 2;
            if num_merges <= 1 {
                break;
            }
        }
        list
    }

    fn get_leftmost(&self, start: usize) -> usize {
        let mut p = start;
        let mut leftmost = start;
        loop {
            if self.x(p) < self.x(leftmost) || (self.x(p) == self.x(leftmost) && self.y(p) < self.y(leftmost)) {
                leftmost = p;
            }
            p = self.next(p);
            if p == start {
                break;
            }
        }
        leftmost
    }

    fn is_valid_diagonal(&self, a: usize, b: usize) -> bool {
        let truthy = |v: f64| v != 0.0 && !v.is_nan();
        self.n[self.next(a)].i != self.n[b].i
            && self.n[self.prev(a)].i != self.n[b].i
            && !self.intersects_polygon(a, b)
            && ((self.locally_inside(a, b)
                && self.locally_inside(b, a)
                && self.middle_inside(a, b)
                && (truthy(self.area(self.prev(a), a, self.prev(b))) || truthy(self.area(a, self.prev(b), b))))
                || (self.equals(a, b) && self.area(self.prev(a), a, self.next(a)) > 0.0 && self.area(self.prev(b), b, self.next(b)) > 0.0))
    }

    fn intersects(&self, p1: usize, q1: usize, p2: usize, q2: usize) -> bool {
        let o1 = sign(self.area(p1, q1, p2));
        let o2 = sign(self.area(p1, q1, q2));
        let o3 = sign(self.area(p2, q2, p1));
        let o4 = sign(self.area(p2, q2, q1));
        if o1 != o2 && o3 != o4 {
            return true;
        }
        if o1 == 0 && self.on_segment(p1, p2, q1) {
            return true;
        }
        if o2 == 0 && self.on_segment(p1, q2, q1) {
            return true;
        }
        if o3 == 0 && self.on_segment(p2, p1, q2) {
            return true;
        }
        if o4 == 0 && self.on_segment(p2, q1, q2) {
            return true;
        }
        false
    }

    fn on_segment(&self, p: usize, q: usize, r: usize) -> bool {
        self.x(q) <= js_max2(self.x(p), self.x(r))
            && self.x(q) >= js_min2(self.x(p), self.x(r))
            && self.y(q) <= js_max2(self.y(p), self.y(r))
            && self.y(q) >= js_min2(self.y(p), self.y(r))
    }

    fn intersects_polygon(&self, a: usize, b: usize) -> bool {
        let mut p = a;
        loop {
            let pn = self.next(p);
            let (pi, pni, ai, bi) = (self.n[p].i, self.n[pn].i, self.n[a].i, self.n[b].i);
            if pi != ai && pni != ai && pi != bi && pni != bi && self.intersects(p, pn, a, b) {
                return true;
            }
            p = pn;
            if p == a {
                break;
            }
        }
        false
    }

    fn locally_inside(&self, a: usize, b: usize) -> bool {
        if self.area(self.prev(a), a, self.next(a)) < 0.0 {
            self.area(a, b, self.next(a)) >= 0.0 && self.area(a, self.prev(a), b) >= 0.0
        } else {
            self.area(a, b, self.prev(a)) < 0.0 || self.area(a, self.next(a), b) < 0.0
        }
    }

    fn middle_inside(&self, a: usize, b: usize) -> bool {
        let mut p = a;
        let mut inside = false;
        let px = (self.x(a) + self.x(b)) / 2.0;
        let py = (self.y(a) + self.y(b)) / 2.0;
        loop {
            let pn = self.next(p);
            if ((self.y(p) > py) != (self.y(pn) > py))
                && self.y(pn) != self.y(p)
                && (px < (self.x(pn) - self.x(p)) * (py - self.y(p)) / (self.y(pn) - self.y(p)) + self.x(p))
            {
                inside = !inside;
            }
            p = pn;
            if p == a {
                break;
            }
        }
        inside
    }

    fn split_polygon(&mut self, a: usize, b: usize) -> usize {
        let a2 = self.create_node(self.n[a].i, self.x(a), self.y(a));
        let b2 = self.create_node(self.n[b].i, self.x(b), self.y(b));
        let an = self.next(a);
        let bp = self.prev(b);
        self.n[a].next = b;
        self.n[b].prev = a;
        self.n[a2].next = an;
        self.n[an].prev = a2;
        self.n[b2].next = a2;
        self.n[a2].prev = b2;
        self.n[bp].next = b2;
        self.n[b2].prev = bp;
        b2
    }
}

/// `earcut(data, holeIndices, 2)`: triangle vertex indices, three per triangle.
pub fn earcut(data: &[f64], hole_indices: &[usize]) -> Vec<u32> {
    let dim = 2;
    let has_holes = !hole_indices.is_empty();
    let outer_len = if has_holes { hole_indices[0] * dim } else { data.len() };
    let mut ctx = Ctx { n: Vec::with_capacity(data.len() / dim + 8) };
    let mut outer = ctx.linked_list(data, 0, outer_len, dim, true);
    let mut tri = Vec::new();
    if outer == NIL || ctx.next(outer) == ctx.prev(outer) {
        return tri;
    }
    let (mut min_x, mut min_y, mut inv_size) = (f64::NAN, f64::NAN, 0.0);
    if has_holes {
        outer = ctx.eliminate_holes(data, hole_indices, outer, dim);
    }
    if data.len() > 80 * dim {
        min_x = f64::INFINITY;
        min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        let mut i = dim;
        while i < outer_len {
            let (x, y) = (data[i], data[i + 1]);
            if x < min_x {
                min_x = x;
            }
            if y < min_y {
                min_y = y;
            }
            if x > max_x {
                max_x = x;
            }
            if y > max_y {
                max_y = y;
            }
            i += dim;
        }
        inv_size = js_max2(max_x - min_x, max_y - min_y);
        inv_size = if inv_size != 0.0 { 32767.0 / inv_size } else { 0.0 };
    }
    ctx.earcut_linked(outer, &mut tri, dim, min_x, min_y, inv_size, 0);
    tri
}

fn signed_area(data: &[f64], start: usize, end: usize, dim: usize) -> f64 {
    let mut sum = 0.0;
    let mut i = start;
    let mut j = end.wrapping_sub(dim);
    while i < end {
        sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
        j = i;
        i += dim;
    }
    sum
}

fn z_order(x: f64, y: f64, min_x: f64, min_y: f64, inv_size: f64) -> i32 {
    let mut x = to_int32((x - min_x) * inv_size);
    let mut y = to_int32((y - min_y) * inv_size);
    x = (x | (x << 8)) & 0x00FF00FF;
    x = (x | (x << 4)) & 0x0F0F0F0F;
    x = (x | (x << 2)) & 0x33333333;
    x = (x | (x << 1)) & 0x55555555;
    y = (y | (y << 8)) & 0x00FF00FF;
    y = (y | (y << 4)) & 0x0F0F0F0F;
    y = (y | (y << 2)) & 0x33333333;
    y = (y | (y << 1)) & 0x55555555;
    x | (y << 1)
}

#[allow(clippy::too_many_arguments)]
fn point_in_triangle(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, px: f64, py: f64) -> bool {
    (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) && (bx - px) * (cy - py) >= (cx - px) * (by - py)
}
#[allow(clippy::too_many_arguments)]
fn point_in_triangle_except_first(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, px: f64, py: f64) -> bool {
    !(ax == px && ay == py) && point_in_triangle(ax, ay, bx, by, cx, cy, px, py)
}

fn sign(v: f64) -> i32 {
    if v > 0.0 {
        1
    } else if v < 0.0 {
        -1
    } else {
        0
    }
}

/// JS `x | 0` (ToInt32).
pub fn to_int32(v: f64) -> i32 {
    if !v.is_finite() {
        return 0;
    }
    let t = v.trunc();
    let m = t.rem_euclid(4294967296.0);
    (if m >= 2147483648.0 { m - 4294967296.0 } else { m }) as i32
}

/// `Math.min`/`Math.max` (NaN wins; -0 below +0).
pub fn js_min2(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}
pub fn js_max2(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && a.is_sign_positive()) {
        a
    } else {
        b
    }
}
fn js_min3(a: f64, b: f64, c: f64) -> f64 {
    js_min2(js_min2(a, b), c)
}
fn js_max3(a: f64, b: f64, c: f64) -> f64 {
    js_max2(js_max2(a, b), c)
}

/// `Array.prototype.sort(cmp)` as V8 runs it (TimSort; arrays this small are one run made by
/// `CountAndMakeRun` + binary insertion). Same result as V8 even for a comparator that is not a
/// consistent order (NaN, ties), which a plain stable sort would not promise.
pub fn js_sort<T: Copy>(v: &mut [T], mut cmp: impl FnMut(&T, &T) -> f64) {
    let n = v.len();
    if n < 2 {
        return;
    }
    // V8 merges runs of >= minrun (32..64) for larger arrays; every caller here sorts a handful.
    // For long arrays fall back to the same binary insertion over the whole range (identical for a
    // consistent comparator, which every long caller has).
    // CountAndMakeRun
    let mut run_end = 1;
    let mut order = cmp(&v[1], &v[0]);
    let descending = order < 0.0;
    let mut previous = v[1];
    run_end += 1;
    while run_end < n {
        let current = v[run_end];
        order = cmp(&current, &previous);
        if descending {
            if order >= 0.0 || order.is_nan() {
                break;
            }
        } else if order < 0.0 {
            break;
        }
        previous = current;
        run_end += 1;
    }
    if descending {
        v[..run_end].reverse();
    }
    // BinaryInsertionSort(low = 0, start = run_end, high = n)
    for start in run_end..n {
        let pivot = v[start];
        let (mut left, mut right) = (0usize, start);
        while left < right {
            let mid = left + ((right - left) >> 1);
            let o = cmp(&pivot, &v[mid]);
            if o < 0.0 {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        let mut p = start;
        while p > left {
            v[p] = v[p - 1];
            p -= 1;
        }
        v[left] = pivot;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_square_is_two_triangles() {
        let t = earcut(&[0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0], &[]);
        assert_eq!(t.len(), 6);
    }

    #[test]
    fn a_square_with_a_hole() {
        let t = earcut(&[0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0, 1.0, 1.0, 3.0, 1.0, 3.0, 3.0, 1.0, 3.0], &[4]);
        assert_eq!(t.len(), 8 * 3);
    }

    #[test]
    fn int32_matches_js() {
        assert_eq!(to_int32(3.9), 3);
        assert_eq!(to_int32(-3.9), -3);
        assert_eq!(to_int32(4294967297.0), 1);
        assert_eq!(to_int32(f64::NAN), 0);
    }

    #[test]
    fn sort_is_stable_and_handles_descending_runs() {
        let mut v = [(3, 0), (1, 1), (3, 2), (2, 3), (1, 4)];
        js_sort(&mut v, |a, b| (a.0 - b.0) as f64);
        assert_eq!(v, [(1, 1), (1, 4), (2, 3), (3, 0), (3, 2)]);
        let mut d = [5, 4, 3, 2, 1, 9];
        js_sort(&mut d, |a, b| (a - b) as f64);
        assert_eq!(d, [1, 2, 3, 4, 5, 9]);
    }
}
