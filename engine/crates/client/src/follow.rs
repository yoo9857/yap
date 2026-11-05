//! The follow camera: craftCamera.ts on the core's raycast, zoomed like Roblox. Over the shoulder
//! behind the player at a distance the player picks (wheel / pinch, from the eyes out to
//! MAX_ZOOM); zoomed all the way in it is first person, Minecraft's (at the eyes, no shoulder,
//! the body hidden and facing the view). Five probe rays (centre + four corners) keep it out of
//! walls; it closes in fast but smoothly and eases back out; a small box around it must stay
//! clear of blocks (the near plane never cuts a brick open); a touch wider fov on the run.
//! Frame-rate independent (exponential easing).

use craftyap_core::world::World;
use glam::DVec3;

const BASE_FOV: f64 = 70.0;
const MOVE_FOV: f64 = 75.5;
/// The default distance (craftCamera.ts MAX_DIST) and how far out a player may zoom.
const MAX_DIST: f64 = 8.0;
pub const MAX_ZOOM: f64 = 14.0;
/// Zoomed in closer than this, the camera snaps to the eyes (first person).
pub const FIRST_PERSON_BELOW: f64 = 1.2;
/// The nearest third-person distance (zooming out of first person lands here).
const NEAR_ZOOM: f64 = 2.0;
const MIN_DIST: f64 = 0.55;
const SHOULDER: f64 = 0.28;
const WALL_MARGIN: f64 = 0.32;
const HARD_MARGIN: f64 = 0.14;
const NEAR_CLEAR: f64 = 0.22;
const PROBE: f64 = 0.28;
const PROBES: [(f64, f64); 5] = [(0.0, 0.0), (1.0, 1.0), (1.0, -1.0), (-1.0, 1.0), (-1.0, -1.0)];

pub struct FollowCamera {
    dist: f64,
    /// The distance the player asked for (0: first person); `dist` follows it, walls permitting.
    zoom: f64,
    /// The third-person distance to go back to from first person (V).
    last_zoom: f64,
    shoulder: f64,
    pub fov: f64,
    pub eye: DVec3,
    pub target: DVec3,
}

impl Default for FollowCamera {
    fn default() -> Self {
        Self { dist: MAX_DIST, zoom: MAX_DIST, last_zoom: MAX_DIST, shoulder: 0.0, fov: BASE_FOV, eye: DVec3::ZERO, target: DVec3::Z }
    }
}

fn blocked(world: &World, p: DVec3) -> bool {
    world.is_solid(p.x.floor() as i32, p.y.floor() as i32, p.z.floor() as i32)
}

fn box_blocked(world: &World, p: DVec3) -> bool {
    for dx in [-NEAR_CLEAR, NEAR_CLEAR] {
        for dy in [-NEAR_CLEAR, NEAR_CLEAR] {
            for dz in [-NEAR_CLEAR, NEAR_CLEAR] {
                if blocked(world, p + DVec3::new(dx, dy, dz)) {
                    return true;
                }
            }
        }
    }
    false
}

impl FollowCamera {
    /// First person: the camera at the eyes (zoomed all the way in, or V).
    pub fn first_person(&self) -> bool {
        self.zoom <= 0.0
    }

    /// Zoom by `metres` (+ out, − in), Roblox's wheel / pinch: closer than FIRST_PERSON_BELOW
    /// snaps to the eyes, and zooming out of first person starts at NEAR_ZOOM.
    pub fn zoom_by(&mut self, metres: f64) {
        if !metres.is_finite() || metres == 0.0 {
            return;
        }
        let next = if self.first_person() {
            if metres > 0.0 { NEAR_ZOOM } else { 0.0 }
        } else {
            self.zoom + metres
        };
        self.zoom = if next < FIRST_PERSON_BELOW { 0.0 } else { next.min(MAX_ZOOM) };
        if self.zoom > 0.0 {
            self.last_zoom = self.zoom;
        }
    }

    /// V (Minecraft's F5): first person ↔ the last third-person distance.
    pub fn toggle_view(&mut self) {
        self.zoom = if self.first_person() { self.last_zoom.max(NEAR_ZOOM) } else { 0.0 };
    }

    /// The world moved by (dx, dz) cells under the camera (a field scroll): move with it.
    pub fn shift(&mut self, dx: f64, dz: f64) {
        let d = DVec3::new(dx, 0.0, dz);
        self.eye -= d;
        self.target -= d;
    }

    /// Place the camera for this frame around the player's eye. Returns how visible the player
    /// should be (0 when the camera is in its head, 1 from 1.8 m out): the robot fades, not pops.
    #[allow(clippy::too_many_arguments)]
    pub fn update(&mut self, world: &World, eye: DVec3, body_eye_y: f64, yaw: f64, pitch: f64, running: bool, dt: f64) -> f64 {
        // a broken frame keeps the last good camera rather than drawing from NaN
        if !(eye.is_finite() && yaw.is_finite() && pitch.is_finite()) {
            return 1.0;
        }
        let dt = if dt.is_finite() { dt.clamp(0.0, 0.5) } else { 0.0 };
        let ease = |rate: f64| 1.0 - rate.powf(dt);
        let dir = DVec3::new(yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos());
        let right = DVec3::new(-yaw.cos(), 0.0, yaw.sin());
        let up = right.cross(dir).normalize();
        let first = self.first_person();
        let want_shoulder = if first { 0.0 } else { SHOULDER * (self.dist / MAX_DIST * 1.4).min(1.0) };
        self.shoulder += (want_shoulder - self.shoulder) * ease(0.005);
        let mut pivot = eye;
        // the eye inside a block (a squeeze, a block over the head): look from the nearest free
        // height straight above or below, never sideways (aim stays on the same column)
        if blocked(world, eye) {
            let free = |y: f64| !blocked(world, DVec3::new(eye.x, y, eye.z));
            if body_eye_y.is_finite() && free(body_eye_y) {
                pivot.y = body_eye_y;
            } else {
                'search: for k in 1..=6 {
                    for dy in [k as f64 * 0.25, -(k as f64) * 0.25] {
                        if free(eye.y + dy) {
                            pivot.y = eye.y + dy;
                            break 'search;
                        }
                    }
                }
            }
        }
        if self.shoulder > 1e-3 {
            let side = world.raycast(eye.x, eye.y, eye.z, right.x, right.y, right.z, self.shoulder + 0.2, false);
            let allowed = side.map_or(self.shoulder, |h| (h.dist - 0.2).max(0.0));
            pivot += right * self.shoulder.min(allowed);
        }
        // probe past the zoom by the wall margin: open ground must not cost the margin
        let reach = self.zoom.max(MIN_DIST) + WALL_MARGIN;
        let mut clear = reach;
        for (sx, sy) in PROBES {
            let p = (-dir + right * (sx * PROBE / MAX_DIST) + up * (sy * PROBE / MAX_DIST)).normalize();
            if let Some(hit) = world.raycast(pivot.x, pivot.y, pivot.z, p.x, p.y, p.z, reach, false) {
                clear = clear.min(hit.dist);
            }
        }
        let hard_limit = (clear - HARD_MARGIN).max(0.0);
        if first {
            // first person: at the eyes at once (Minecraft; easing out of the head would show it)
            self.dist = 0.0;
        } else {
            let want = (clear - WALL_MARGIN).max(MIN_DIST).min(hard_limit).min(self.zoom);
            // walls pull in fast; the player's own zoom and the way back out ease
            self.dist += (want - self.dist) * if want < self.dist - 0.5 && clear < self.zoom { ease(1e-7) } else { ease(0.004) };
            self.dist = self.dist.min(hard_limit);
        }
        let want_fov = if running { MOVE_FOV } else { BASE_FOV };
        self.fov += (want_fov - self.fov) * ease(0.02);
        let mut cam = pivot - dir * self.dist;
        if !first {
            cam.y = cam.y.max(0.35);
        }
        // the near plane is wider than a ray: a small box around the camera must be clear
        if !first && box_blocked(world, cam) {
            let mut d = self.dist;
            while d > 0.0 {
                d = (d - 0.04).max(0.0);
                cam = pivot - dir * d;
                if !box_blocked(world, cam) {
                    break;
                }
            }
            if box_blocked(world, cam) {
                cam = pivot;
            }
            self.dist = d;
        }
        self.eye = cam;
        self.target = pivot + dir * 3.0;
        if first {
            return 0.0;
        }
        ((self.dist - 0.9) / 0.9).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use craftyap_core::world::id;

    #[test]
    fn open_ground_puts_the_camera_eight_metres_behind() {
        let mut w = World::default();
        for z in 0..60 {
            for x in 0..60 {
                w.set(x, 0, z, id("stone"));
            }
        }
        let mut c = FollowCamera::default();
        let eye = DVec3::new(30.5, 2.55, 30.5);
        for _ in 0..200 {
            c.update(&w, eye, eye.y, 0.0, -0.2, false, 1.0 / 60.0);
        }
        let back = (c.eye - eye).length();
        assert!((back - MAX_DIST).abs() < 0.5, "{back}");
        assert!(c.eye.z < eye.z, "behind (yaw 0 looks along +z)");
    }

    #[test]
    fn zoom_goes_out_to_its_cap_and_in_to_first_person_like_roblox() {
        let mut w = World::default();
        for z in 0..80 {
            for x in 0..80 {
                w.set(x, 0, z, id("stone"));
            }
        }
        let eye = DVec3::new(40.5, 2.55, 40.5);
        let settle = |c: &mut FollowCamera| {
            let mut v = 1.0;
            for _ in 0..600 {
                v = c.update(&w, eye, eye.y, 0.0, -0.2, false, 1.0 / 60.0);
            }
            v
        };
        let mut c = FollowCamera::default();
        c.zoom_by(100.0);
        settle(&mut c);
        assert!(((c.eye - eye).length() - MAX_ZOOM).abs() < 0.6, "out to the cap");
        // in, step by step: it passes through every distance, then snaps to the eyes
        for _ in 0..20 {
            c.zoom_by(-1.0);
        }
        assert!(c.first_person());
        let visible = settle(&mut c);
        assert!((c.eye - eye).length() < 1e-6 && visible == 0.0, "at the eyes, the body hidden");
        // out of first person: the near distance first, not a jump to where it was
        c.zoom_by(1.0);
        assert!(!c.first_person());
        settle(&mut c);
        assert!(((c.eye - eye).length() - NEAR_ZOOM).abs() < 0.3);
        // V: to first person and back to the last third-person distance
        c.zoom_by(4.0);
        c.toggle_view();
        assert!(c.first_person());
        c.toggle_view();
        settle(&mut c);
        assert!(((c.eye - eye).length() - (NEAR_ZOOM + 4.0)).abs() < 0.3);
    }

    #[test]
    fn a_wall_behind_pulls_the_camera_in_front_of_it() {
        let mut w = World::default();
        for z in 0..60 {
            for x in 0..60 {
                w.set(x, 0, z, id("stone"));
            }
        }
        for x in 20..40 {
            for y in 1..8 {
                w.set(x, y, 27, id("stone"));
            }
        }
        let mut c = FollowCamera::default();
        let eye = DVec3::new(30.5, 2.55, 30.5);
        for _ in 0..200 {
            c.update(&w, eye, eye.y, 0.0, -0.2, false, 1.0 / 60.0);
        }
        assert!(c.eye.z > 28.0 + NEAR_CLEAR - 1e-6, "kept out of the wall: {}", c.eye.z);
        assert!(!box_blocked(&w, c.eye));
    }
}
