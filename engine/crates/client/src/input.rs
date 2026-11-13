//! Input → one `Intent` per frame, the same for every device:
//! - desktop: WASD / arrows, Space jump, Shift run; the mouse looks once captured (click into
//!   the window; Esc or losing focus lets it go), like the web's pointer lock;
//! - touch (phones): a floating stick where the left thumb lands (pushed to its rim = run),
//!   dragging anywhere else turns the view, and a jump button bottom-right. Every finger is
//!   tracked by id, so steering, looking and jumping work at the same time.
//!
//! Layout is in density-independent pixels (`dp` = physical / scale factor), so the controls are
//! the same size on a 5" phone and a 12" tablet. `TouchUi` is what `ui.rs` draws.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use winit::keyboard::KeyCode;

/// What the player wants this frame.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Intent {
    /// -1..1 each (camera-relative), and how far the stick is pushed (keys: 1).
    pub forward: f64,
    pub strafe: f64,
    pub amount: f64,
    pub run: bool,
    pub jump: bool,
    /// View turn this frame (radians): yaw left-positive, pitch down-positive.
    pub look: (f64, f64),
}

/// The web's mouse look (craftGame.ts: 0.0026 rad per pixel at sensitivity 1).
const MOUSE_LOOK: f64 = 0.0026;
/// Touch look, per dp dragged: a thumb's sweep across half a phone turns ~140°.
const TOUCH_LOOK: f64 = 0.0065;
/// The stick: its travel (dp) and the push that counts as running.
pub const STICK_RADIUS: f64 = 56.0;
const RUN_PUSH: f64 = 0.92;
/// mouseLook.ts: movement in the first moments after a capture is the cursor's jump, not the
/// hand's; and no real hand moves this far between two reports. Both are DROPPED, not clamped
/// (a clamped spike still turned the view ~27 degrees at once and slammed the pitch to its limit).
const LOCK_SETTLE: Duration = Duration::from_millis(150);
const SPIKE_PX: f64 = 200.0;
/// A touch that jumps this far (dp) between two reports is a reused pointer id or a dropped
/// frame of events, not a drag: it moves the finger without turning the view.
const TOUCH_SPIKE_DP: f64 = 160.0;
/// Below this push the stick is ignored (a resting thumb is not a step).
const DEAD_ZONE: f64 = 0.12;
/// The action buttons' radii (dp): hud_layout.rs places them (the main action — dig — in the
/// corner, jump and place in an arc round it).
pub const JUMP_RADIUS: f64 = crate::hud_layout::SKILL_RADIUS as f64;
pub const DIG_RADIUS: f64 = crate::hud_layout::PRIMARY_RADIUS as f64;
pub const PLACE_RADIUS: f64 = crate::hud_layout::SKILL_RADIUS as f64;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Finger {
    /// Steering: where the thumb landed, and where it is now (dp).
    Stick { origin: (f64, f64), at: (f64, f64) },
    /// Turning the view: the last position (dp).
    Look { last: (f64, f64) },
    Jump,
    /// Holding the dig button (mining the aimed block).
    Dig,
    /// The place button (one block per press).
    Place,
    /// The shape (F) and turn (R) buttons (one step per press).
    Shape,
    Turn,
}

/// What the touch overlay shows (dp).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TouchUi {
    pub visible: bool,
    /// The stick's base (where the thumb landed, or its resting place) and the knob.
    pub stick_base: (f64, f64),
    pub stick_knob: (f64, f64),
    pub stick_active: bool,
    pub jump_centre: (f64, f64),
    pub jump_pressed: bool,
    /// The building buttons (shown in a world you can build in).
    pub build: bool,
    pub dig_centre: (f64, f64),
    pub dig_pressed: bool,
    pub place_centre: (f64, f64),
    pub place_pressed: bool,
    pub shape_centre: (f64, f64),
    pub shape_pressed: bool,
    pub turn_centre: (f64, f64),
    pub turn_pressed: bool,
}

#[derive(Default)]
pub struct Input {
    pub fire_training:bool,
    /// Pinch zoom gathered since last asked (dp) and the two look fingers' last span.
    pinch: f64,
    pinch_span: Option<f64>,
    keys: HashSet<KeyCode>,
    mouse: (f64, f64),
    captured: Option<Instant>,
    fingers: HashMap<u64, Finger>,
    touch_look: (f64, f64),
    /// Seen a touch: show the touch controls (a phone, or a touchscreen laptop being touched).
    pub touch_mode: bool,
    /// The screen in dp.
    size: (f64, f64),
    /// Show and answer the dig / place buttons (a world you can build in).
    pub build_buttons: bool,
    place_taps: u32,
    shape_taps: u32,
    turn_taps: u32,
}

impl Input {
    pub fn set_screen(&mut self, width_dp: f64, height_dp: f64) {
        self.size = (width_dp, height_dp);
    }

    pub fn key(&mut self, code: KeyCode, pressed: bool) {
        if pressed {
            self.keys.insert(code);
        } else {
            self.keys.remove(&code);
        }
    }

    /// The mouse was captured (look) or let go.
    pub fn set_captured(&mut self, on: bool, now: Instant) {
        self.captured = on.then_some(now);
    }

    pub fn captured(&self) -> bool {
        self.captured.is_some()
    }

    /// Raw mouse motion: counts only while captured, and drops the capture's own jump and spikes
    /// (mouseLook.ts lookDelta).
    pub fn mouse_motion(&mut self, dx: f64, dy: f64, now: Instant) {
        let Some(at) = self.captured else { return };
        if now.saturating_duration_since(at) < LOCK_SETTLE || !dx.is_finite() || !dy.is_finite() || dx.abs() > SPIKE_PX || dy.abs() > SPIKE_PX {
            return;
        }
        self.mouse.0 += dx;
        self.mouse.1 += dy;
    }

    /// Focus lost / suspended: every held key and finger lets go.
    pub fn release_all(&mut self) {
        self.keys.clear();
        self.fingers.clear();
        self.captured = None;
        self.mouse = (0.0, 0.0);
        self.touch_look = (0.0, 0.0);
    }

    fn centres(&self) -> ((f64, f64), (f64, f64), (f64, f64)) {
        let (d, j, p) = crate::hud_layout::actions(self.size.0 as f32, self.size.1 as f32);
        ((d.0 as f64, d.1 as f64), (j.0 as f64, j.1 as f64), (p.0 as f64, p.1 as f64))
    }

    fn jump_centre(&self) -> (f64, f64) {
        self.centres().1
    }

    fn dig_centre(&self) -> (f64, f64) {
        self.centres().0
    }

    fn place_centre(&self) -> (f64, f64) {
        self.centres().2
    }

    /// The dig button is held (touch).
    pub fn dig_held(&self) -> bool {
        self.fingers.values().any(|f| matches!(f, Finger::Dig))
    }

    /// Place-button presses since the last call (touch).
    pub fn take_place_taps(&mut self) -> u32 {
        std::mem::take(&mut self.place_taps)
    }

    /// A Shift key is down (Shift+R resets the piece).
    pub fn shift_held(&self) -> bool {
        self.keys.contains(&KeyCode::ShiftLeft) || self.keys.contains(&KeyCode::ShiftRight)
    }

    /// Shape (F) and turn (R) presses since last asked.
    pub fn take_shape_taps(&mut self) -> u32 {
        std::mem::take(&mut self.shape_taps)
    }
    pub fn take_turn_taps(&mut self) -> u32 {
        std::mem::take(&mut self.turn_taps)
    }

    fn build_skills(&self) -> ((f64, f64), (f64, f64)) {
        let (s, t) = crate::hud_layout::build_skills(self.size.0 as f32, self.size.1 as f32);
        ((s.0 as f64, s.1 as f64), (t.0 as f64, t.1 as f64))
    }

    fn stick_rest(&self) -> (f64, f64) {
        let (x, y) = crate::hud_layout::stick_rest(self.size.0 as f32, self.size.1 as f32);
        (x as f64, y as f64)
    }

    /// A finger down (dp).
    pub fn touch_start(&mut self, id: u64, x: f64, y: f64) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        self.touch_mode = true;
        let (jx, jy) = self.jump_centre();
        let (dx, dy) = self.dig_centre();
        let (px, py) = self.place_centre();
        let finger = if (x - jx).hypot(y - jy) <= JUMP_RADIUS * 1.3 {
            Finger::Jump
        } else if self.build_buttons && (x - dx).hypot(y - dy) <= DIG_RADIUS * 1.15 {
            Finger::Dig
        } else if self.build_buttons && !self.fire_training && (x - px).hypot(y - py) <= PLACE_RADIUS * 1.3 {
            self.place_taps += 1;
            Finger::Place
        } else if self.build_buttons && !self.fire_training && (x - self.build_skills().1 .0).hypot(y - self.build_skills().1 .1) <= crate::hud_layout::BADGE_RADIUS as f64 * 1.5 {
            self.turn_taps += 1;
            Finger::Turn        } else if self.build_buttons && !self.fire_training && (x - self.build_skills().0 .0).hypot(y - self.build_skills().0 .1) <= PLACE_RADIUS * 1.3 {
            self.shape_taps += 1;
            Finger::Shape
        } else if x < self.size.0 * 0.45 && !self.fingers.values().any(|f| matches!(f, Finger::Stick { .. })) {
            Finger::Stick { origin: (x, y), at: (x, y) }
        } else {
            Finger::Look { last: (x, y) }
        };
        self.fingers.insert(id, finger);
    }

    pub fn touch_move(&mut self, id: u64, x: f64, y: f64) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        let mut look = (0.0, 0.0);
        match self.fingers.get_mut(&id) {
            Some(Finger::Stick { origin, at }) => {
                *at = (x, y);
                // a thumb that runs past the rim drags the base along (the stick never "sticks")
                let (dx, dy) = (x - origin.0, y - origin.1);
                let d = dx.hypot(dy);
                if d > STICK_RADIUS * 1.6 {
                    let k = (d - STICK_RADIUS * 1.6) / d;
                    origin.0 += dx * k;
                    origin.1 += dy * k;
                }
            }
            Some(Finger::Look { last }) => {
                let d = (x - last.0, y - last.1);
                if d.0.hypot(d.1) <= TOUCH_SPIKE_DP {
                    look = d;
                }
                *last = (x, y);
            }
            _ => {}
        }
        // two look fingers: a pinch zooms and does not also turn the view
        if let Some(span) = self.look_span() {
            if let Some(before) = self.pinch_span {
                self.pinch += span - before;
            }
            self.pinch_span = Some(span);
            return;
        }
        self.pinch_span = None;
        self.touch_look.0 += look.0;
        self.touch_look.1 += look.1;
    }

    pub fn touch_end(&mut self, id: u64) {
        self.fingers.remove(&id);
        self.pinch_span = None;
    }

    /// Two fingers on the look side spreading or closing (dp since last asked: + = spread = zoom
    /// in), Roblox's mobile zoom; taken once.
    pub fn take_pinch(&mut self) -> f64 {
        std::mem::take(&mut self.pinch)
    }

    /// The span between the two look fingers, when exactly two are down.
    fn look_span(&self) -> Option<f64> {
        let looks: Vec<(f64, f64)> = self.fingers.values().filter_map(|f| if let Finger::Look { last } = f { Some(*last) } else { None }).collect();
        (looks.len() == 2).then(|| (looks[0].0 - looks[1].0).hypot(looks[0].1 - looks[1].1))
    }

    fn stick(&self) -> Option<(f64, f64, f64)> {
        self.fingers.values().find_map(|f| match f {
            Finger::Stick { origin, at } => {
                let (dx, dy) = (at.0 - origin.0, at.1 - origin.1);
                let push = (dx.hypot(dy) / STICK_RADIUS).min(1.0);
                let d = dx.hypot(dy).max(1e-9);
                Some((dx / d, dy / d, push))
            }
            _ => None,
        })
    }

    /// This frame's intent; consumes the look deltas gathered since the last call.
    pub fn intent(&mut self, sensitivity: f64, invert_y: bool) -> Intent {
        let held = |k: &[KeyCode]| k.iter().any(|c| self.keys.contains(c));
        let mut i = Intent::default();
        if held(&[KeyCode::KeyW, KeyCode::ArrowUp]) {
            i.forward += 1.0;
        }
        if held(&[KeyCode::KeyS, KeyCode::ArrowDown]) {
            i.forward -= 1.0;
        }
        if held(&[KeyCode::KeyA, KeyCode::ArrowLeft]) {
            i.strafe -= 1.0;
        }
        if held(&[KeyCode::KeyD, KeyCode::ArrowRight]) {
            i.strafe += 1.0;
        }
        i.amount = if i.forward != 0.0 || i.strafe != 0.0 { 1.0 } else { 0.0 };
        i.run = held(&[KeyCode::ShiftLeft, KeyCode::ShiftRight]);
        i.jump = held(&[KeyCode::Space]) || self.fingers.values().any(|f| matches!(f, Finger::Jump));
        if let Some((dx, dy, push)) = self.stick() {
            if push > DEAD_ZONE {
                // screen up is forward; the push sets the pace (rim = run)
                i.forward = -dy;
                i.strafe = dx;
                i.amount = ((push - DEAD_ZONE) / (RUN_PUSH - DEAD_ZONE)).min(1.0);
                i.run = push >= RUN_PUSH;
            }
        }
        i.look = (self.mouse.0 * MOUSE_LOOK * sensitivity + self.touch_look.0 * TOUCH_LOOK * sensitivity, self.mouse.1 * MOUSE_LOOK * sensitivity + self.touch_look.1 * TOUCH_LOOK * sensitivity);
        if invert_y {
            i.look.1 = -i.look.1;
        }
        self.mouse = (0.0, 0.0);
        self.touch_look = (0.0, 0.0);
        i
    }

    /// What the touch overlay draws.
    pub fn touch_ui(&self) -> TouchUi {
        let stick = self.fingers.values().find_map(|f| match f {
            Finger::Stick { origin, at } => Some((*origin, *at)),
            _ => None,
        });
        let (base, knob) = match stick {
            Some((o, a)) => {
                let (dx, dy) = (a.0 - o.0, a.1 - o.1);
                let d = dx.hypot(dy);
                let k = if d > STICK_RADIUS { STICK_RADIUS / d } else { 1.0 };
                (o, (o.0 + dx * k, o.1 + dy * k))
            }
            None => (self.stick_rest(), self.stick_rest()),
        };
        TouchUi {
            visible: self.touch_mode,
            stick_base: base,
            stick_knob: knob,
            stick_active: stick.is_some(),
            jump_centre: self.jump_centre(),
            jump_pressed: self.fingers.values().any(|f| matches!(f, Finger::Jump)),
            build: self.build_buttons,
            dig_centre: self.dig_centre(),
            dig_pressed: self.dig_held(),
            place_centre: self.place_centre(),
            place_pressed: self.fingers.values().any(|f| matches!(f, Finger::Place)),
            shape_centre: self.build_skills().0,
            shape_pressed: self.fingers.values().any(|f| matches!(f, Finger::Shape)),
            turn_centre: self.build_skills().1,
            turn_pressed: self.fingers.values().any(|f| matches!(f, Finger::Turn)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phone() -> Input {
        let mut i = Input::default();
        i.set_screen(800.0, 400.0);
        i
    }

    #[test]
    fn two_fingers_on_the_look_side_pinch_to_zoom_and_do_not_turn() {
        let mut i = phone();
        i.touch_start(1, 500.0, 200.0);
        i.touch_start(2, 600.0, 200.0);
        i.touch_move(1, 480.0, 200.0);
        i.touch_move(2, 620.0, 200.0);
        assert!((i.take_pinch() - 20.0).abs() < 1e-9, "spread by 20 dp (the first move only measures the span)");
        assert_eq!(i.intent(1.0, false).look, (0.0, 0.0), "a pinch does not also turn the view");
        i.touch_move(1, 520.0, 200.0);
        assert!(i.take_pinch() < 0.0, "closing zooms out");
        // one finger left: it turns the view again, no pinch
        i.touch_end(2);
        i.touch_move(1, 540.0, 200.0);
        assert_eq!(i.take_pinch(), 0.0);
        assert!(i.intent(1.0, false).look.0 != 0.0);
    }

    #[test]
    fn keys_walk_and_shift_runs() {
        let mut i = phone();
        i.key(KeyCode::KeyW, true);
        i.key(KeyCode::ShiftLeft, true);
        let it = i.intent(1.0, false);
        assert_eq!((it.forward, it.strafe, it.amount, it.run), (1.0, 0.0, 1.0, true));
        i.key(KeyCode::KeyW, false);
        assert_eq!(i.intent(1.0, false).amount, 0.0);
    }

    #[test]
    fn the_left_thumb_steers_and_its_rim_runs() {
        let mut i = phone();
        i.touch_start(1, 120.0, 300.0);
        i.touch_move(1, 120.0, 300.0 - STICK_RADIUS * 0.5); // half up: walk forward, slowly
        let it = i.intent(1.0, false);
        assert!(it.forward > 0.99 && it.strafe.abs() < 1e-9 && !it.run && it.amount > 0.3 && it.amount < 0.6);
        i.touch_move(1, 120.0 + STICK_RADIUS, 300.0); // full right: run, strafing right
        let it = i.intent(1.0, false);
        assert!(it.strafe > 0.99 && it.run && it.amount == 1.0);
        i.touch_end(1);
        assert_eq!(i.intent(1.0, false).amount, 0.0);
    }

    #[test]
    fn a_resting_thumb_is_not_a_step() {
        let mut i = phone();
        i.touch_start(1, 120.0, 300.0);
        i.touch_move(1, 123.0, 302.0);
        assert_eq!(i.intent(1.0, false).amount, 0.0);
    }

    #[test]
    fn steering_looking_and_jumping_together() {
        let mut i = phone();
        i.touch_start(1, 120.0, 300.0); // stick
        i.touch_start(2, 500.0, 200.0); // look
        let (jx, jy) = i.jump_centre();
        i.touch_start(3, jx, jy); // jump
        i.touch_move(1, 120.0, 300.0 - STICK_RADIUS);
        i.touch_move(2, 540.0, 200.0);
        let it = i.intent(1.0, false);
        assert!(it.forward > 0.99 && it.jump && it.look.0 > 0.0);
        // the look delta is consumed
        assert_eq!(i.intent(1.0, false).look, (0.0, 0.0));
        assert!(i.touch_ui().jump_pressed && i.touch_ui().stick_active);
    }

    #[test]
    fn a_second_thumb_on_the_left_looks_instead_of_stealing_the_stick() {
        let mut i = phone();
        i.touch_start(1, 120.0, 300.0);
        i.touch_start(2, 200.0, 250.0);
        i.touch_move(2, 230.0, 250.0);
        assert!(i.intent(1.0, false).look.0 > 0.0);
    }

    #[test]
    fn the_mouse_only_looks_while_captured() {
        let mut i = phone();
        let t0 = Instant::now();
        i.mouse_motion(100.0, 0.0, t0);
        assert_eq!(i.intent(1.0, false).look, (0.0, 0.0));
        i.set_captured(true, t0);
        let later = t0 + Duration::from_millis(200);
        i.mouse_motion(100.0, 0.0, later);
        assert!((i.intent(1.0, false).look.0 - 0.26).abs() < 1e-9);
    }

    #[test]
    fn the_capture_jump_and_spikes_are_dropped_not_clamped() {
        let mut i = phone();
        let t0 = Instant::now();
        i.set_captured(true, t0);
        i.mouse_motion(80.0, 0.0, t0 + Duration::from_millis(20)); // the cursor's jump
        i.mouse_motion(900.0, 0.0, t0 + Duration::from_millis(400)); // an OS spike
        i.mouse_motion(f64::NAN, 0.0, t0 + Duration::from_millis(400));
        assert_eq!(i.intent(1.0, false).look, (0.0, 0.0));
    }

    #[test]
    fn a_touch_that_teleports_does_not_whip_the_view() {
        let mut i = phone();
        i.touch_start(2, 500.0, 200.0);
        i.touch_move(2, 780.0, 30.0); // a reused id / lost events
        assert_eq!(i.intent(1.0, false).look, (0.0, 0.0));
        i.touch_move(2, 790.0, 30.0); // and it keeps tracking from there
        assert!(i.intent(1.0, false).look.0 > 0.0);
        i.touch_move(2, f64::NAN, 1.0);
        assert_eq!(i.intent(1.0, false).look, (0.0, 0.0));
    }

    #[test]
    fn letting_go_forgets_everything_held() {
        let mut i = phone();
        i.key(KeyCode::KeyW, true);
        i.touch_start(1, 120.0, 300.0);
        i.touch_move(1, 120.0, 250.0);
        i.release_all();
        let it = i.intent(1.0, false);
        assert_eq!((it.amount, it.jump, it.look), (0.0, false, (0.0, 0.0)));
        assert!(!i.touch_ui().stick_active);
    }
}
