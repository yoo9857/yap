//! Block shape geometry for bodies: a line-for-line port of the parts of
//! `packages/shared/src/blockShapes.ts` that physics reads (shapeIntersectsBox, rampHeight and what
//! they call). Shape codes are the persisted ones (0..=82), never renumbered.
//! Parity: apps/client/test/rust-body.test.ts runs bodies through mixed shapes on both sides.

pub const CUBE: u8 = 0;
pub const ROUND: u8 = 1;
pub const SLOPE_BASE: u8 = 2;
pub const SLOPE_MAX: u8 = 17;
pub const KIT_CUBE: u8 = 18;
pub const KIT_SLOPE_BASE: u8 = 19;
pub const CORNER_BASE: u8 = 35;
pub const SLAB_BASE: u8 = 51;
pub const STAIRS_BASE: u8 = 67;
pub const MAX_BLOCK_SHAPE: u8 = 82;

const EPS: f64 = 1e-7;

pub type Point = [f64; 3];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShapeBox {
    pub min: Point,
    pub max: Point,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    Cube,
    Round,
    Slope,
    Corner,
    Slab,
    Stairs,
}

fn is_slope(n: u8) -> bool {
    (SLOPE_BASE..=SLOPE_MAX).contains(&n)
}

fn rotation_base(n: u8) -> u8 {
    if (STAIRS_BASE..=MAX_BLOCK_SHAPE).contains(&n) {
        STAIRS_BASE
    } else if (SLAB_BASE..STAIRS_BASE).contains(&n) {
        SLAB_BASE
    } else if (CORNER_BASE..SLAB_BASE).contains(&n) {
        CORNER_BASE
    } else if (KIT_SLOPE_BASE..CORNER_BASE).contains(&n) {
        KIT_SLOPE_BASE
    } else if is_slope(n) {
        SLOPE_BASE
    } else {
        0
    }
}

pub fn is_oriented_shape(n: u8) -> bool {
    rotation_base(n) != 0
}
pub fn shape_yaw(n: u8) -> u8 {
    n.wrapping_sub(rotation_base(n)) & 3
}
pub fn shape_tilt(n: u8) -> u8 {
    (n.wrapping_sub(rotation_base(n)) >> 2) & 3
}
pub fn is_full_cube_shape(n: u8) -> bool {
    n == CUBE || n == KIT_CUBE
}

pub fn family(n: u8) -> Family {
    if n == ROUND {
        Family::Round
    } else if n >= STAIRS_BASE {
        Family::Stairs
    } else if n >= SLAB_BASE {
        Family::Slab
    } else if n >= CORNER_BASE {
        Family::Corner
    } else if is_oriented_shape(n) {
        Family::Slope
    } else {
        Family::Cube
    }
}

/// `shapeBoxes`: box families as unions of axis boxes in the unrotated cell.
pub fn shape_boxes(f: Family) -> Option<&'static [ShapeBox]> {
    const SLAB: [ShapeBox; 1] = [ShapeBox { min: [0.0, 0.0, 0.0], max: [1.0, 0.5, 1.0] }];
    const STAIRS: [ShapeBox; 2] = [ShapeBox { min: [0.0, 0.0, 0.0], max: [1.0, 0.5, 1.0] }, ShapeBox { min: [0.0, 0.5, 0.0], max: [1.0, 1.0, 0.5] }];
    match f {
        Family::Slab => Some(&SLAB),
        Family::Stairs => Some(&STAIRS),
        _ => None,
    }
}

/// `rotateShapeVector`: yaw then tilt (inverse: tilt back, then yaw back).
pub fn rotate_shape_vector(p: Point, shape: u8, inverse: bool) -> Point {
    let [mut x, mut y, mut z] = p;
    let (yaw, tilt) = if is_oriented_shape(shape) { (shape_yaw(shape), shape_tilt(shape)) } else { (0, 0) };
    if inverse {
        for _ in 0..tilt {
            let t = y;
            y = z;
            z = -t;
        }
        for _ in 0..yaw {
            let t = x;
            x = -z;
            z = t;
        }
    } else {
        for _ in 0..yaw {
            let t = x;
            x = z;
            z = -t;
        }
        for _ in 0..tilt {
            let t = y;
            y = -z;
            z = t;
        }
    }
    [x, y, z]
}

pub fn to_shape_local(p: Point, shape: u8) -> Point {
    let v = rotate_shape_vector([p[0] - 0.5, p[1] - 0.5, p[2] - 0.5], shape, true);
    [v[0] + 0.5, v[1] + 0.5, v[2] + 0.5]
}

/// `shapeIntersectsBox`: exact for our quarter-turn grid shapes; touching is clear.
pub fn shape_intersects_box(shape: u8, b: &ShapeBox) -> bool {
    let mut min = [b.min[0].max(0.0), b.min[1].max(0.0), b.min[2].max(0.0)];
    let mut max = [b.max[0].min(1.0), b.max[1].min(1.0), b.max[2].min(1.0)];
    if (0..3).any(|i| min[i] >= max[i] - EPS) {
        return false;
    }
    if is_full_cube_shape(shape) {
        return true;
    }
    if is_oriented_shape(shape) {
        let mut corners = Vec::with_capacity(8);
        for x in [min[0], max[0]] {
            for y in [min[1], max[1]] {
                for z in [min[2], max[2]] {
                    corners.push(to_shape_local([x, y, z], shape));
                }
            }
        }
        // Math.min(...) / Math.max(...) over the eight corners
        min = [0, 1, 2].map(|i| corners.iter().fold(f64::INFINITY, |m, p| m.min(p[i])));
        max = [0, 1, 2].map(|i| corners.iter().fold(f64::NEG_INFINITY, |m, p| m.max(p[i])));
    }
    let fam = family(shape);
    if let Some(boxes) = shape_boxes(fam) {
        return boxes.iter().any(|bx| (0..3).all(|i| min[i] < bx.max[i] - EPS && max[i] > bx.min[i] + EPS));
    }
    if fam == Family::Round {
        let x = min[0].max(0.5f64.min(max[0])) - 0.5;
        let z = min[2].max(0.5f64.min(max[2])) - 0.5;
        return x * x + z * z < 0.25 - EPS;
    }
    min[1] + min[2] < 1.0 - EPS && (fam != Family::Corner || min[1] + min[0] < 1.0 - EPS)
}

/// `rampHeight`: the floor height of an upright ramp at (x, z) in the cell, else None.
pub fn ramp_height(shape: u8, x: f64, z: f64) -> Option<f64> {
    if !is_oriented_shape(shape) || shape_tilt(shape) != 0 || shape_boxes(family(shape)).is_some() {
        return None;
    }
    let p = to_shape_local([x, 0.0, z], shape);
    if p[0] < -EPS || p[0] > 1.0 + EPS || p[2] < -EPS || p[2] > 1.0 + EPS {
        return None;
    }
    let h = if family(shape) == Family::Corner { (1.0 - p[0]).min(1.0 - p[2]) } else { 1.0 - p[2] };
    Some(h.clamp(0.0, 1.0))
}

/// `blockShapePlanes`: outward planes n·p <= d in the unrotated unit cell.
fn block_shape_planes(f: Family) -> Vec<[f64; 4]> {
    let mut planes = vec![[-1.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 1.0], [0.0, -1.0, 0.0, 0.0], [0.0, 1.0, 0.0, 1.0], [0.0, 0.0, -1.0, 0.0], [0.0, 0.0, 1.0, 1.0]];
    if f == Family::Slab {
        planes[3] = [0.0, 1.0, 0.0, 0.5];
    }
    if f == Family::Slope || f == Family::Corner {
        planes.push([0.0, 1.0, 1.0, 1.0]);
    }
    if f == Family::Corner {
        planes.push([1.0, 1.0, 0.0, 1.0]);
    }
    planes
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShapeRayHit {
    pub distance: f64,
    pub normal: Point,
}

/// Slab-method ray vs an axis box in local space (`rayBox`).
fn ray_box(o: Point, d: Point, b: &ShapeBox, max_distance: f64) -> Option<ShapeRayHit> {
    let (mut enter, mut exit, mut normal) = (0.0f64, max_distance, [0.0f64; 3]);
    for i in 0..3 {
        if d[i].abs() < 1e-12 {
            if o[i] < b.min[i] || o[i] > b.max[i] {
                return None;
            }
            continue;
        }
        let (mut t0, mut t1, mut sign) = ((b.min[i] - o[i]) / d[i], (b.max[i] - o[i]) / d[i], -1.0);
        if t0 > t1 {
            std::mem::swap(&mut t0, &mut t1);
            sign = 1.0;
        }
        if t0 > enter {
            enter = t0;
            normal = [0.0; 3];
            normal[i] = sign;
        }
        exit = exit.min(t1);
        if enter > exit + EPS {
            return None;
        }
    }
    if enter < 0.0 || enter > max_distance { None } else { Some(ShapeRayHit { distance: enter, normal }) }
}

/// `raycastBlockShape`: a ray (cell-local origin) against a shaped block.
pub fn raycast_block_shape(shape: u8, origin: Point, direction: Point, max_distance: f64) -> Option<ShapeRayHit> {
    let fam = family(shape);
    if fam == Family::Stairs {
        let o = to_shape_local(origin, shape);
        let d = rotate_shape_vector(direction, shape, true);
        let mut best: Option<ShapeRayHit> = None;
        for b in shape_boxes(Family::Stairs).unwrap_or(&[]) {
            if let Some(hit) = ray_box(o, d, b, max_distance) {
                if best.is_none_or(|bb| hit.distance < bb.distance) {
                    best = Some(hit);
                }
            }
        }
        let best = best?;
        return Some(ShapeRayHit { distance: best.distance, normal: rotate_shape_vector(best.normal, shape, false) });
    }
    let o = to_shape_local(origin, shape);
    let d = rotate_shape_vector(direction, shape, true);
    let (mut enter, mut exit, mut normal) = (0.0f64, max_distance, [0.0f64; 3]);
    let mut clip = |n: Point, limit: f64, enter: &mut f64, exit: &mut f64| -> bool {
        let denom = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
        let gap = limit - n[0] * o[0] - n[1] * o[1] - n[2] * o[2];
        if denom.abs() < 1e-12 {
            return gap >= 0.0;
        }
        let t = gap / denom;
        if denom < 0.0 {
            if t > *enter {
                *enter = t;
                normal = n;
            }
        } else {
            *exit = exit.min(t);
        }
        *enter <= *exit + EPS
    };
    if fam == Family::Round {
        if !clip([0.0, -1.0, 0.0], 0.0, &mut enter, &mut exit) || !clip([0.0, 1.0, 0.0], 1.0, &mut enter, &mut exit) {
            return None;
        }
        let (x, z) = (o[0] - 0.5, o[2] - 0.5);
        let a = d[0].powi(2) + d[2].powi(2);
        let b = 2.0 * (x * d[0] + z * d[2]);
        let c = x * x + z * z - 0.25;
        if a < 1e-12 {
            if c > 0.0 {
                return None;
            }
        } else {
            let disc = b * b - 4.0 * a * c;
            if disc < 0.0 {
                return None;
            }
            let lo = (-b - disc.sqrt()) / (2.0 * a);
            let hi = (-b + disc.sqrt()) / (2.0 * a);
            if lo > enter {
                enter = lo;
                normal = [x + lo * d[0], 0.0, z + lo * d[2]];
            }
            exit = exit.min(hi);
        }
    } else {
        for [x, y, z, limit] in block_shape_planes(fam) {
            if !clip([x, y, z], limit, &mut enter, &mut exit) {
                return None;
            }
        }
    }
    if enter < 0.0 || enter > max_distance || enter > exit + EPS {
        return None;
    }
    let n = rotate_shape_vector(normal, shape, false);
    let len = crate::kit::js_hypot_n(&n);
    let len = if len == 0.0 { 1.0 } else { len };
    Some(ShapeRayHit { distance: enter, normal: [n[0] / len, n[1] / len, n[2] / len] })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_and_turns_follow_the_codes() {
        assert_eq!(family(0), Family::Cube);
        assert_eq!(family(18), Family::Cube);
        assert_eq!(family(1), Family::Round);
        assert_eq!(family(2), Family::Slope);
        assert_eq!(family(19), Family::Slope);
        assert_eq!(family(35), Family::Corner);
        assert_eq!(family(51), Family::Slab);
        assert_eq!(family(82), Family::Stairs);
        assert_eq!((shape_yaw(2 + 3 + 4), shape_tilt(2 + 3 + 4)), (3, 1));
    }

    #[test]
    fn a_half_block_fills_only_its_lower_half() {
        let lower = ShapeBox { min: [0.2, 0.1, 0.2], max: [0.8, 0.4, 0.8] };
        let upper = ShapeBox { min: [0.2, 0.6, 0.2], max: [0.8, 0.9, 0.8] };
        assert!(shape_intersects_box(SLAB_BASE, &lower));
        assert!(!shape_intersects_box(SLAB_BASE, &upper));
        // upside down (tilt 2): the other way round
        assert!(shape_intersects_box(SLAB_BASE + 8, &upper));
        assert!(!shape_intersects_box(SLAB_BASE + 8, &lower));
    }

    #[test]
    fn an_upright_ramp_rises_toward_its_back() {
        assert_eq!(ramp_height(SLOPE_BASE, 0.5, 1.0), Some(0.0));
        assert_eq!(ramp_height(SLOPE_BASE, 0.5, 0.0), Some(1.0));
        assert_eq!(ramp_height(SLOPE_BASE + 4, 0.5, 0.5), None, "tilted: not a floor");
        assert_eq!(ramp_height(SLAB_BASE, 0.5, 0.5), None, "a step, not a ramp");
    }
}
