//! The player: the core's voxel body (body.rs, = voxelBody.ts) stepped at a fixed 60 Hz and drawn
//! between ticks, steered like craftGame.ts steers it:
//! - camera-relative wish (`wish_from_input`), eased in ~0.1 s and out in ~0.08 s (not a switch);
//! - walk 2.7 m/s, run 5.2 m/s (Shift, or the stick pushed to its rim), eased between;
//! - the body turns toward the way it walks (`turnToward`), never glued to the camera.
//!
//! Spawn and respawn follow the web: the castle bridge, and back there after a fall into the void.

use crate::input::Intent;
use craftyap_core::body::{step_body, unstick, wish_from_input, Body, MOVE_SPEED, RUN_SPEED, WALK_SPEED};
use craftyap_core::world::World;

pub const TICK: f64 = 1.0 / 60.0;
/// craftGame.ts EYE_HEIGHT: the camera pivot above the feet.
pub const EYE_HEIGHT: f64 = 1.55;
/// Below this the player has fallen off the island: back to the spawn (craftGame.ts: -12).
const VOID_Y: f64 = -12.0;
/// At most this many ticks per frame (a long stall must not freeze the app catching up).
const MAX_TICKS: usize = 8;

/// Input as the physics may take it: finite, in range (a broken device report is no input).
fn sanitize(i: &Intent) -> Intent {
    let f = |v: f64, lo: f64, hi: f64| if v.is_finite() { v.clamp(lo, hi) } else { 0.0 };
    // one frame never turns the view more than half a turn
    Intent { forward: f(i.forward, -1.0, 1.0), strafe: f(i.strafe, -1.0, 1.0), amount: f(i.amount, 0.0, 1.0), run: i.run, jump: i.jump, look: (f(i.look.0, -3.0, 3.0), f(i.look.1, -3.0, 3.0)) }
}

/// smoothing.ts `approach`: the fraction to close in `dt` toward a target with time constant `tau`.
pub fn approach(dt: f64, tau: f64) -> f64 {
    1.0 - (-dt / tau).exp()
}

/// smoothing.ts `angleDelta`: the shortest signed turn from one heading to another.
pub fn angle_delta(from: f64, to: f64) -> f64 {
    let mut d = to - from;
    while d > std::f64::consts::PI {
        d -= std::f64::consts::TAU;
    }
    while d <= -std::f64::consts::PI {
        d += std::f64::consts::TAU;
    }
    d
}

/// smoothing.ts `easeAngle`: the drawn view eases toward the input view in ~25 ms (absorbs a
/// 125 Hz mouse against a 144 Hz screen, and a touch screen's uneven reports); a jump of more
/// than 1.2 rad (a respawn, a snap) is taken at once.
pub fn ease_angle(drawn: f64, target: f64, dt: f64) -> f64 {
    let d = angle_delta(drawn, target);
    if d.abs() > 1.2 {
        return target;
    }
    drawn + d * approach(dt, 0.025)
}

/// An angle wrapped into (-pi, pi]: a heading turned round and round for hours keeps its precision.
pub fn wrap_angle(a: f64) -> f64 {
    angle_delta(0.0, a)
}

/// smoothing.ts `turnToward`: an eased turn with a top rate (13 rad/s).
pub fn turn_toward(facing: f64, target: f64, dt: f64) -> f64 {
    let d = angle_delta(facing, target);
    let step = d * approach(dt, 0.08);
    let cap = 13.0 * dt;
    facing + step.clamp(-cap, cap)
}

pub struct Player {
    pub body: Body,
    /// The body before the last tick, for drawing between ticks.
    prev: [f64; 3],
    spawn: [f64; 3],
    /// View heading and pitch (radians): yaw 0 looks along +z.
    pub yaw: f64,
    pub pitch: f64,
    /// The view as drawn: eased toward yaw / pitch (aim and movement use the exact ones).
    pub view_yaw: f64,
    pub view_pitch: f64,
    /// The drawn body heading.
    pub facing: f64,
    /// craftGame.ts actionHold: seconds the body keeps facing the crosshair after digging or
    /// placing (it never digs with its back to the block).
    pub action_hold: f64,
    /// First person (the camera at the eyes): the body always faces the view (Minecraft).
    pub first_person: bool,
    wish: (f64, f64),
    move_ratio: f64,
    acc: f64,
    /// Whether the last tick moved the body on purpose (for the camera's fov and animation).
    pub moving: bool,
    pub running: bool,
}

impl Player {
    pub fn new(world: &World, spawn: [f64; 3], yaw: f64) -> Self {
        let mut body = Body::at(spawn[0], spawn[1], spawn[2]);
        unstick(world, &mut body);
        Self { prev: [body.x, body.y, body.z], body, spawn, yaw, pitch: -0.18, view_yaw: yaw, view_pitch: -0.18, facing: yaw, action_hold: 0.0, first_person: false, wish: (0.0, 0.0), move_ratio: WALK_SPEED / MOVE_SPEED, acc: 0.0, moving: false, running: false }
    }

    /// The world moved under the player by (dx, dz) cells (a field window scroll): move with it,
    /// drawn position and respawn point included, so nothing visibly jumps.
    pub fn shift(&mut self, dx: f64, dz: f64) {
        self.body.x -= dx;
        self.body.z -= dz;
        self.prev[0] -= dx;
        self.prev[2] -= dz;
        self.spawn[0] -= dx;
        self.spawn[2] -= dz;
    }

    /// Put the body somewhere (a teacher's gather), standing still.
    pub fn teleport(&mut self, world: &World, at: [f64; 3]) {
        self.body = Body::at(at[0], at[1], at[2]);
        unstick(world, &mut self.body);
        self.prev = [self.body.x, self.body.y, self.body.z];
    }

    /// Digging or placing: face the crosshair for the next 0.6 s (craftGame.ts ACTION_FACE_TIME).
    pub fn act(&mut self) {
        self.action_hold = 0.6;
    }

    /// Advance by a frame: look, then as many fixed ticks as the time allows.
    /// `props`: the solid furniture cells (grid coordinates) the body collides with.
    pub fn update(&mut self, world: &World, props: &std::collections::HashSet<(i32, i32, i32)>, intent: &Intent, dt: f64) {
        let dt = if dt.is_finite() { dt.max(0.0) } else { 0.0 };
        let intent = &sanitize(intent);
        self.yaw = wrap_angle(self.yaw - intent.look.0);
        self.pitch = (self.pitch - intent.look.1).clamp(-1.25, 1.35);
        self.view_yaw = wrap_angle(ease_angle(self.view_yaw, self.yaw, dt));
        self.view_pitch = ease_angle(self.view_pitch, self.pitch, dt);
        self.acc = (self.acc + dt).min(TICK * MAX_TICKS as f64);
        while self.acc >= TICK {
            self.acc -= TICK;
            self.tick(world, props, intent);
        }
        // the body turns toward the way it walks, or to the crosshair while acting (updateFacing)
        self.action_hold = (self.action_hold - dt).max(0.0);
        let (wx, wz) = wish_from_input(self.yaw, intent.forward, intent.strafe);
        if self.first_person {
            self.facing = self.yaw;
        } else if self.action_hold > 0.0 {
            self.facing = wrap_angle(turn_toward(self.facing, self.yaw, dt));
        } else if intent.forward != 0.0 || intent.strafe != 0.0 {
            self.facing = wrap_angle(turn_toward(self.facing, wx.atan2(wz), dt));
        }
    }

    fn tick(&mut self, world: &World, props: &std::collections::HashSet<(i32, i32, i32)>, intent: &Intent) {
        self.prev = [self.body.x, self.body.y, self.body.z];
        let pushing = intent.forward != 0.0 || intent.strafe != 0.0;
        let (rx, rz) = if pushing { wish_from_input(self.yaw, intent.forward, intent.strafe) } else { (0.0, 0.0) };
        // an analogue stick walks slower when barely pushed (keys are always full)
        let (rx, rz) = (rx * intent.amount, rz * intent.amount);
        let k = approach(TICK, if pushing { 0.045 } else { 0.035 });
        self.wish.0 += (rx - self.wish.0) * k;
        self.wish.1 += (rz - self.wish.1) * k;
        if self.wish.0.abs() < 1e-3 && self.wish.1.abs() < 1e-3 {
            self.wish = (0.0, 0.0);
        }
        let swimming = self.body.wet >= craftyap_core::body::SWIM_DEPTH;
        let target = if swimming { 1.0 } else if intent.run { RUN_SPEED / MOVE_SPEED } else { WALK_SPEED / MOVE_SPEED };
        if swimming {
            self.move_ratio = target;
        } else {
            self.move_ratio += (target - self.move_ratio) * approach(TICK, if intent.run { 0.06 } else { 0.09 });
        }
        let view = crate::building::WithProps { world, props };
        step_body(&view, &mut self.body, TICK, self.wish.0 * self.move_ratio, self.wish.1 * self.move_ratio, intent.jump, 0.0, 0.0);
        self.moving = pushing;
        self.running = pushing && intent.run;
        // fell off the island, or (never expected) the body's numbers broke: back to the spawn
        if self.body.y < VOID_Y || !self.body.is_sane() {
            if !self.body.is_sane() {
                log::error!("player body went non-finite ({:?}); respawning", self.body);
            }
            self.respawn(world);
        }
    }

    /// Back to the spawn column, on its ground, lifted clear of any block (craftGame.ts).
    pub fn respawn(&mut self, world: &World) {
        let y = craftyap_core::world::surface_y(world, self.spawn[0].floor() as i32, self.spawn[2].floor() as i32) as f64 + 1.0;
        self.body = Body::at(self.spawn[0], y, self.spawn[2]);
        unstick(world, &mut self.body);
        self.prev = [self.body.x, self.body.y, self.body.z];
    }

    /// The feet, drawn between the last two ticks.
    pub fn drawn(&self) -> [f64; 3] {
        let a = self.acc / TICK;
        [0, 1, 2].map(|i| self.prev[i] + ([self.body.x, self.body.y, self.body.z][i] - self.prev[i]) * a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use craftyap_core::world::id;

    fn flat() -> World {
        let mut w = World::default();
        for z in 0..40 {
            for x in 0..40 {
                w.set(x, 0, z, id("stone"));
            }
        }
        w
    }

    #[test]
    fn holding_forward_walks_at_walking_speed_and_shift_runs() {
        let w = flat();
        for (run, speed) in [(false, WALK_SPEED), (true, RUN_SPEED)] {
            let mut p = Player::new(&w, [5.5, 1.0, 5.5], 0.0);
            let intent = Intent { forward: 1.0, amount: 1.0, run, ..Default::default() };
            for _ in 0..60 {
                p.update(&w, &Default::default(), &intent, TICK);
            }
            let z0 = p.body.z;
            for _ in 0..60 {
                p.update(&w, &Default::default(), &intent, TICK);
            }
            assert!(((p.body.z - z0) - speed).abs() < 0.05, "run={run}: {} m/s", p.body.z - z0);
        }
    }

    #[test]
    fn the_body_turns_toward_where_it_walks() {
        let w = flat();
        let mut p = Player::new(&w, [5.5, 1.0, 5.5], 0.0);
        // strafe right at yaw 0: screen-right is -x, heading atan2(-1, 0) = -pi/2
        let intent = Intent { strafe: 1.0, amount: 1.0, ..Default::default() };
        for _ in 0..60 {
            p.update(&w, &Default::default(), &intent, TICK);
        }
        assert!((angle_delta(p.facing, -std::f64::consts::FRAC_PI_2)).abs() < 0.01, "{}", p.facing);
    }

    #[test]
    fn a_fall_into_the_void_respawns() {
        let w = World::default(); // nothing to stand on
        let mut p = Player::new(&w, [5.5, 10.0, 5.5], 0.0);
        let mut respawned = false;
        for _ in 0..600 {
            let before = p.body.y;
            p.update(&w, &Default::default(), &Intent::default(), TICK);
            respawned |= before < VOID_Y + 2.0 && p.body.y > 0.0;
        }
        assert!(respawned, "came back up to the spawn column");
    }

    #[test]
    fn broken_input_is_no_input() {
        let w = flat();
        let mut p = Player::new(&w, [5.5, 1.0, 5.5], 0.0);
        let bad = Intent { forward: f64::NAN, strafe: f64::INFINITY, amount: f64::NAN, run: true, jump: true, look: (f64::NAN, f64::NEG_INFINITY) };
        for dt in [TICK, f64::NAN, -1.0, f64::INFINITY] {
            p.update(&w, &Default::default(), &bad, dt);
            assert!(p.body.is_sane() && p.yaw.is_finite() && p.pitch.is_finite() && p.view_yaw.is_finite() && p.facing.is_finite());
        }
    }

    #[test]
    fn angles_stay_wrapped_and_the_view_eases() {
        let w = flat();
        let mut p = Player::new(&w, [5.5, 1.0, 5.5], 0.0);
        let spin = Intent { look: (0.5, 0.0), ..Default::default() };
        for _ in 0..10_000 {
            p.update(&w, &Default::default(), &spin, TICK);
        }
        assert!(p.yaw.abs() <= std::f64::consts::PI && p.view_yaw.abs() <= std::f64::consts::PI);
        // a small turn is eased, not snapped
        let mut q = Player::new(&w, [5.5, 1.0, 5.5], 0.0);
        q.update(&w, &Default::default(), &Intent { look: (0.3, 0.0), ..Default::default() }, 1.0 / 144.0);
        assert!(q.view_yaw > -0.3 && q.view_yaw < 0.0, "{}", q.view_yaw);
    }

    #[test]
    fn a_long_stall_does_not_run_away() {
        let w = flat();
        let mut p = Player::new(&w, [5.5, 1.0, 5.5], 0.0);
        let intent = Intent { forward: 1.0, amount: 1.0, ..Default::default() };
        p.update(&w, &Default::default(), &intent, 5.0); // a 5 s hitch: at most MAX_TICKS ticks
        assert!(p.body.z - 5.5 < 0.5);
    }

    /// A long session on the real island with a restless player: random steering, jumps, looks
    /// and frame times (including hitches and broken ones). Nothing may hang, break, end up inside
    /// a block, or put the camera inside one.
    #[test]
    fn soak_on_the_island() {
        use crate::follow::FollowCamera;
        use craftyap_core::body::{can_occupy, BODY_HEIGHT};
        use glam::DVec3;
        let w = craftyap_core::world::generate_island(crate::scene::ISLAND_SEED);
        let ground = craftyap_core::world::surface_y(&w, 40, 72) as f64 + 1.0;
        let mut p = Player::new(&w, [40.5, ground, 72.5], std::f64::consts::PI);
        let mut cam = FollowCamera::default();
        let mut seed = 0x9e3779b97f4a7c15u64;
        let mut r = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut intent = Intent::default();
        let started = std::time::Instant::now();
        let (mut travel, mut last, mut respawns, mut lowest) = (0.0f64, [p.body.x, p.body.z], 0usize, f64::MAX);
        for frame in 0..20_000 {
            if frame % 40 == 0 {
                let a = r() * std::f64::consts::TAU;
                intent = Intent { forward: a.cos(), strafe: a.sin(), amount: r(), run: r() < 0.4, jump: false, look: (0.0, 0.0) };
            }
            intent.jump = r() < 0.03;
            intent.look = ((r() - 0.5) * 0.2, (r() - 0.5) * 0.05);
            let dt = match frame % 997 {
                0 => 2.5,          // a hitch (window dragged, app paused)
                1 => f64::NAN,     // a broken clock
                _ => 1.0 / (30.0 + r() * 114.0),
            };
            p.update(&w, &Default::default(), &intent, dt);
            let feet = p.drawn();
            let eye = DVec3::new(feet[0], feet[1] + EYE_HEIGHT, feet[2]);
            cam.update(&w, eye, p.body.y + EYE_HEIGHT, p.view_yaw, p.view_pitch, p.running, if dt.is_finite() { dt } else { 0.0 });
            assert!(p.body.is_sane() && feet.iter().all(|v| v.is_finite()), "frame {frame}: {:?}", p.body);
            let step = (p.body.x - last[0]).hypot(p.body.z - last[1]);
            if step > 5.0 { respawns += 1 } else { travel += step }
            last = [p.body.x, p.body.z];
            lowest = lowest.min(p.body.y);
            assert!(can_occupy(&w, &p.body, BODY_HEIGHT), "frame {frame}: inside a block at {:?}", p.body);
            assert!(cam.eye.is_finite() && cam.target.is_finite(), "frame {frame}");
            let c = cam.eye;
            assert!(!w.is_solid(c.x.floor() as i32, c.y.floor() as i32, c.z.floor() as i32), "frame {frame}: camera inside a block at {c}");
        }
        eprintln!("soak: {:.0} m walked, {respawns} respawns, lowest y {lowest:.1}, {:?}", travel, started.elapsed());
        assert!(travel > 200.0, "the soak must actually roam: {travel} m");
        // 20k frames of physics + camera must stay far from a frame budget
        assert!(started.elapsed().as_secs_f64() < 20.0, "{:?}", started.elapsed());
    }
}
