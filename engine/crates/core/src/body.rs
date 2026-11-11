//! Character physics on the voxel grid: a line-for-line port of `apps/client/src/craft/voxelBody.ts`
//! (AABB vs voxels, axis-separated sweeps with bisected contact, step-up onto half blocks, ramps,
//! swimming). The grid IS the collision shape: no physics engine.
//! Parity: apps/client/test/rust-body.test.ts walks, jumps, swims and climbs bodies through the
//! same worlds on both sides and requires the same positions tick for tick.

use crate::fluid::{is_water, water_level, WATER_FALLING};
use crate::kit::js_hypot;
use crate::shapes::{is_full_cube_shape, ramp_height, shape_intersects_box, ShapeBox};
use crate::world::World;

pub const BODY_WIDTH: f64 = 0.6;
pub const BODY_HEIGHT: f64 = 1.8;
pub const GRAVITY: f64 = 24.0;
pub const JUMP_SPEED: f64 = 8.6;
pub const MOVE_SPEED: f64 = 4.6;
pub const WALK_SPEED: f64 = 2.7;
pub const RUN_SPEED: f64 = 5.2;
pub const SWIM_DEPTH: f64 = 0.35;
const WATER_GRAVITY: f64 = 6.0;
const WATER_DRAG: f64 = 4.0;
const SWIM_ACCEL: f64 = 14.0;
const CLIMB_OUT: f64 = 5.6;
const SWIM_SPEED: f64 = 0.6;
const EPS: f64 = 1e-4;
/// Sub-step cap keeps fast falls from tunnelling through 1 m cells.
const MAX_STEP: f64 = 0.45;
/// The tallest ledge a walking body climbs without jumping (a half block, one stair).
pub const STEP_UP: f64 = 0.51;
const WORLD_UNSTICK_LIMIT: usize = 120;

/// What a body collides with. `World` is one; the native client adds furniture later
/// (`prop_solid`, VoxelWorld.propSolid).
pub trait BodyWorld {
    fn is_solid(&self, x: i32, y: i32, z: i32) -> bool;
    fn get_shape(&self, x: i32, y: i32, z: i32) -> u8;
    fn water_at(&self, x: i32, y: i32, z: i32) -> u8;
    fn prop_solid(&self, _x: i32, _y: i32, _z: i32) -> bool {
        false
    }
    fn is_blocked(&self, x: i32, y: i32, z: i32) -> bool {
        self.is_solid(x, y, z) || self.prop_solid(x, y, z)
    }
}

impl BodyWorld for World {
    fn is_solid(&self, x: i32, y: i32, z: i32) -> bool {
        World::is_solid(self, x, y, z)
    }
    fn get_shape(&self, x: i32, y: i32, z: i32) -> u8 {
        World::get_shape(self, x, y, z)
    }
    fn water_at(&self, x: i32, y: i32, z: i32) -> u8 {
        World::water_at(self, x, y, z)
    }
}

/// fluid.ts `waterHeight`: a water cell's surface height in its cell.
pub fn water_height(id: u8, covered: bool) -> f64 {
    if !is_water(id) {
        return 0.0;
    }
    if covered || id == WATER_FALLING {
        return 1.0;
    }
    // standing water fills most of its cell; running water is a shallow stream (fluid.ts)
    let level = water_level(id);
    if level == 0 {
        0.875
    } else {
        0.64 - level as f64 * 0.077
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Body {
    /// Feet-centre position.
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub vx: f64,
    pub vy: f64,
    pub vz: f64,
    pub grounded: bool,
    /// Footprint / height / hop overrides (None = the player's).
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub jump_speed: Option<f64>,
    /// Set by `step_body`: how much of the body was underwater this tick (0..1).
    pub wet: f64,
}

impl Body {
    pub fn at(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z, vx: 0.0, vy: 0.0, vz: 0.0, grounded: false, w: None, h: None, jump_speed: None, wet: 0.0 }
    }
    /// Every number finite (a NaN position could only come from outside the physics).
    pub fn is_sane(&self) -> bool {
        [self.x, self.y, self.z, self.vx, self.vy, self.vz].iter().all(|v| v.is_finite())
    }
    fn half(&self) -> f64 {
        self.w.unwrap_or(BODY_WIDTH) / 2.0
    }
    fn height(&self) -> f64 {
        self.h.unwrap_or(BODY_HEIGHT)
    }
}

#[derive(Clone, Copy)]
enum Axis {
    X,
    Y,
    Z,
}

fn get(b: &Body, a: Axis) -> f64 {
    match a {
        Axis::X => b.x,
        Axis::Y => b.y,
        Axis::Z => b.z,
    }
}
fn put(b: &mut Body, a: Axis, v: f64) {
    match a {
        Axis::X => b.x = v,
        Axis::Y => b.y = v,
        Axis::Z => b.z = v,
    }
}

/// `submersion`: how much of the body is underwater, 0..1, down its centre column.
pub fn submersion<W: BodyWorld + ?Sized>(world: &W, body: &Body) -> f64 {
    let h = body.height();
    let (cx, cz) = (body.x.floor() as i32, body.z.floor() as i32);
    let mut surface = f64::NEG_INFINITY;
    let mut y = body.y.floor() as i32;
    while y as f64 <= (body.y + h).floor() {
        let id = world.water_at(cx, y, cz);
        if is_water(id) {
            surface = surface.max(y as f64 + water_height(id, is_water(world.water_at(cx, y + 1, cz))));
        }
        y += 1;
    }
    if surface == f64::NEG_INFINITY {
        return 0.0;
    }
    ((surface - body.y) / h).clamp(0.0, 1.0)
}

/// `pointInWater`: is this point (the camera's eye) underwater?
pub fn point_in_water<W: BodyWorld + ?Sized>(world: &W, x: f64, y: f64, z: f64) -> bool {
    let cy = y.floor() as i32;
    let (cx, cz) = (x.floor() as i32, z.floor() as i32);
    let id = world.water_at(cx, cy, cz);
    if !is_water(id) {
        return false;
    }
    y < cy as f64 + water_height(id, is_water(world.water_at(cx, cy + 1, cz)))
}

/// `wishFromInput`: camera-relative wish direction from raw axes (fwd / strafe in -1..1), normalised.
pub fn wish_from_input(yaw: f64, fwd: f64, strafe: f64) -> (f64, f64) {
    let l = js_hypot(fwd, strafe);
    let len = if l == 0.0 { 1.0 } else { l };
    let (sin, cos) = (yaw.sin(), yaw.cos());
    ((sin * fwd - cos * strafe) / len, (cos * fwd + sin * strafe) / len)
}

fn collides<W: BodyWorld + ?Sized>(world: &W, body: &Body) -> bool {
    let (x, y, z) = (body.x, body.y, body.z);
    let half = body.half();
    let h = body.height();
    let (x0, x1) = ((x - half).floor() as i32, (x + half - EPS).floor() as i32);
    let (y0, y1) = (y.floor() as i32, (y + h - EPS).floor() as i32);
    let (z0, z1) = ((z - half).floor() as i32, (z + half - EPS).floor() as i32);
    for ix in x0..=x1 {
        for iy in y0..=y1 {
            for iz in z0..=z1 {
                if world.is_blocked(ix, iy, iz) {
                    let shape = world.get_shape(ix, iy, iz);
                    let (fx, fy, fz) = (ix as f64, iy as f64, iz as f64);
                    if world.prop_solid(ix, iy, iz) || is_full_cube_shape(shape) || shape_intersects_box(shape, &ShapeBox { min: [x - half - fx, y - fy, z - half - fz], max: [x + half - fx, y + h - fy, z + half - fz] }) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// `unstick`: lift a body embedded in terrain straight up to the first clear position.
pub fn unstick<W: BodyWorld + ?Sized>(world: &W, body: &mut Body) {
    if !collides(world, body) {
        return;
    }
    for _ in 0..WORLD_UNSTICK_LIMIT {
        body.y += 0.5;
        if !collides(world, body) {
            break;
        }
    }
    body.vy = 0.0;
    body.grounded = false;
}

/// `canOccupy`: would the body fit at this height (a posture change)?
pub fn can_occupy<W: BodyWorld + ?Sized>(world: &W, body: &Body, height: f64) -> bool {
    height.is_finite() && height > 0.0 && !collides(world, &Body { h: Some(height), ..*body })
}

/// `overlapsVoxel`: would a block placed at this cell overlap the body (deny self-burial)?
pub fn overlaps_voxel(body: &Body, vx: i32, vy: i32, vz: i32) -> bool {
    let half = body.half();
    let (vx, vy, vz) = (vx as f64, vy as f64, vz as f64);
    vx + 1.0 > body.x - half && vx < body.x + half && vy + 1.0 > body.y && vy < body.y + body.height() && vz + 1.0 > body.z - half && vz < body.z + half
}

fn nearby_ramp_floor<W: BodyWorld + ?Sized>(world: &W, body: &Body) -> Option<f64> {
    let half = body.half();
    let mut highest = f64::NEG_INFINITY;
    for y in (body.y - 0.15).floor() as i32..=(body.y + 0.15).floor() as i32 {
        for x in (body.x - half).floor() as i32..=(body.x + half - EPS).floor() as i32 {
            for z in (body.z - half).floor() as i32..=(body.z + half - EPS).floor() as i32 {
                if !world.is_solid(x, y, z) {
                    continue;
                }
                let shape = world.get_shape(x, y, z);
                let (fx, fz) = (x as f64, z as f64);
                let x0 = 0f64.max(body.x - half - fx);
                let x1 = 1f64.min(body.x + half - fx);
                let z0 = 0f64.max(body.z - half - fz);
                let z1 = 1f64.min(body.z + half - fz);
                for cx in [x0, x1] {
                    for cz in [z0, z1] {
                        if let Some(h) = ramp_height(shape, cx, cz) {
                            highest = highest.max(y as f64 + h);
                        }
                    }
                }
            }
        }
    }
    highest.is_finite().then_some(highest)
}

fn step_up<W: BodyWorld + ?Sized>(world: &W, body: &mut Body) -> bool {
    let old_y = body.y;
    body.y = old_y + STEP_UP;
    if collides(world, body) {
        body.y = old_y;
        return false;
    }
    let (mut blocked, mut free) = (0.0, STEP_UP);
    for _ in 0..12 {
        let mid = (blocked + free) / 2.0;
        body.y = old_y + mid;
        if collides(world, body) {
            blocked = mid;
        } else {
            free = mid;
        }
    }
    body.y = old_y + free;
    true
}

fn sign(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        v
    }
}

fn move_axis<W: BodyWorld + ?Sized>(world: &W, body: &mut Body, axis: Axis, amount: f64, follow_ramp: bool) {
    // NaN never reaches 0: `while remaining != 0` would spin forever (the TypeScript too, but its
    // inputs are never NaN). A broken move is no move.
    if !amount.is_finite() {
        return;
    }
    let mut remaining = amount;
    let horizontal = !matches!(axis, Axis::Y);
    while remaining != 0.0 {
        let step = sign(remaining) * remaining.abs().min(MAX_STEP);
        remaining -= step;
        let prev = get(body, axis);
        put(body, axis, prev + step);
        if follow_ramp && horizontal {
            if let Some(top) = nearby_ramp_floor(world, body) {
                if (top - body.y).abs() <= step.abs() + 0.015 {
                    let old_y = body.y;
                    body.y = top + EPS;
                    if !collides(world, body) {
                        body.vy = 0.0;
                        body.grounded = true;
                        continue;
                    }
                    body.y = old_y;
                }
            }
        }
        if collides(world, body) && follow_ramp && horizontal && step_up(world, body) {
            body.vy = 0.0;
            body.grounded = true;
            continue;
        }
        if collides(world, body) {
            let (mut free, mut blocked) = (0.0, step);
            for _ in 0..10 {
                let mid = (free + blocked) / 2.0;
                put(body, axis, prev + mid);
                if collides(world, body) {
                    blocked = mid;
                } else {
                    free = mid;
                }
            }
            put(body, axis, prev + free);
            if !horizontal {
                if amount < 0.0 {
                    body.grounded = true;
                }
                body.vy = 0.0;
            }
            return;
        }
    }
}

/// `stepBody`: one fixed tick. `wish` is the normalised input direction, `push` a shove on top.
#[allow(clippy::too_many_arguments)]
pub fn step_body<W: BodyWorld + ?Sized>(world: &W, body: &mut Body, dt: f64, wish_x: f64, wish_z: f64, jump: bool, push_x: f64, push_z: f64) {
    // Hardening beyond the TypeScript (identical for every valid input, which parity covers):
    // a broken tick is skipped, broken input is no input, and a body whose own state broke is
    // left for the caller to respawn (`Body::is_sane`).
    if !(dt.is_finite() && dt > 0.0) || !body.is_sane() {
        return;
    }
    let finite = |v: f64| if v.is_finite() { v } else { 0.0 };
    let (wish_x, wish_z, push_x, push_z) = (finite(wish_x), finite(wish_z), finite(push_x), finite(push_z));
    let was_grounded = body.grounded;
    let wet = submersion(world, body);
    body.wet = wet;
    let swimming = wet >= SWIM_DEPTH;
    let drag = 1.0 - (1.0 - SWIM_SPEED) * (wet / 0.6).min(1.0);
    body.vx = wish_x * MOVE_SPEED * drag + push_x;
    body.vz = wish_z * MOVE_SPEED * drag + push_z;
    if swimming {
        body.vy += ((if jump { SWIM_ACCEL } else { 0.0 }) - WATER_GRAVITY) * dt;
        body.vy *= (-WATER_DRAG * dt).exp();
    } else {
        if jump && body.grounded {
            body.vy = body.jump_speed.unwrap_or(JUMP_SPEED);
            body.grounded = false;
        }
        body.vy -= GRAVITY * dt;
        if body.vy < -30.0 {
            body.vy = -30.0;
        }
    }
    if body.vy <= 0.0 {
        body.grounded = false;
    }
    let (start_x, start_z) = (body.x, body.z);
    let follow = was_grounded && !jump && !swimming;
    move_axis(world, body, Axis::X, body.vx * dt, follow);
    move_axis(world, body, Axis::Z, body.vz * dt, follow);
    if swimming && jump && wet < 0.9 {
        let wanted = js_hypot(body.vx, body.vz) * dt;
        let moved = js_hypot(body.x - start_x, body.z - start_z);
        if wanted > 1e-4 && moved < wanted * 0.5 {
            body.vy = body.vy.max(CLIMB_OUT);
        }
    }
    let was_falling = body.vy < 0.0;
    let before_y = body.y;
    move_axis(world, body, Axis::Y, body.vy * dt, false);
    if was_falling && body.y == before_y {
        body.grounded = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::id;

    fn flat() -> World {
        let mut w = World::default();
        for z in 0..20 {
            for x in 0..20 {
                w.set(x, 0, z, id("stone"));
            }
        }
        w
    }

    #[test]
    fn a_body_falls_and_lands_on_the_floor() {
        let w = flat();
        let mut b = Body::at(5.5, 4.0, 5.5);
        for _ in 0..120 {
            step_body(&w, &mut b, 1.0 / 60.0, 0.0, 0.0, false, 0.0, 0.0);
        }
        assert!(b.grounded);
        assert!((b.y - 1.0).abs() < 1e-3, "{}", b.y);
    }

    #[test]
    fn a_full_block_stops_a_walker_but_a_half_block_is_stepped_up() {
        let mut w = flat();
        w.set(8, 1, 5, id("stone"));
        let mut b = Body::at(5.5, 1.0, 5.5);
        b.grounded = true;
        for _ in 0..120 {
            step_body(&w, &mut b, 1.0 / 60.0, 1.0, 0.0, false, 0.0, 0.0);
        }
        assert!(b.x < 8.0 - 0.3 + 1e-3 && b.y < 1.01, "stopped by the wall: {} {}", b.x, b.y);
        let mut w = flat();
        w.set_shaped(8, 1, 5, id("stone"), crate::shapes::SLAB_BASE);
        let mut b = Body::at(5.5, 1.0, 5.5);
        b.grounded = true;
        let mut top = 0.0f64;
        for _ in 0..120 {
            step_body(&w, &mut b, 1.0 / 60.0, 1.0, 0.0, false, 0.0, 0.0);
            top = top.max(b.y);
        }
        assert!(b.x > 9.5, "walked over the half block: {}", b.x);
        assert!((top - 1.5).abs() < 0.01, "stood on it on the way: {top}");
    }

    #[test]
    fn broken_numbers_never_hang_or_spread() {
        let w = flat();
        let mut b = Body::at(5.5, 1.0, 5.5);
        b.grounded = true;
        for (dt, wx, wz, px) in [(f64::NAN, 1.0, 0.0, 0.0), (1.0 / 60.0, f64::NAN, f64::INFINITY, 0.0), (1.0 / 60.0, 0.0, 0.0, f64::NEG_INFINITY), (-1.0, 1.0, 0.0, 0.0), (f64::INFINITY, 1.0, 0.0, 0.0)] {
            step_body(&w, &mut b, dt, wx, wz, true, px, 0.0);
            assert!(b.is_sane(), "{dt} {wx} {wz} {px}: {b:?}");
        }
        // a body that is already broken is left alone (the caller respawns it), not spun on
        let mut broken = Body::at(f64::NAN, 1.0, 5.5);
        step_body(&w, &mut broken, 1.0 / 60.0, 1.0, 0.0, false, 0.0, 0.0);
        assert!(!broken.is_sane());
    }

    #[test]
    fn wish_matches_the_web_convention() {
        let (x, z) = wish_from_input(0.0, 1.0, 0.0);
        assert!(x.abs() < 1e-12 && (z - 1.0).abs() < 1e-12, "forward at yaw 0 is +z");
        let (x, z) = wish_from_input(0.0, 0.0, 1.0);
        assert!((x + 1.0).abs() < 1e-12 && z.abs() < 1e-12, "screen-right at yaw 0 is -x");
    }
}
