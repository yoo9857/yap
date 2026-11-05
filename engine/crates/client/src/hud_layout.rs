//! Where everything on the play screen goes — ONE function, used to draw and to hit-test, so a
//! button is exactly where a thumb finds it. The grid is a mobile action game's (Wild Rift's):
//!
//! ```text
//!  ┌─────────────────────────────────────────────────────────────────┐
//!  │ [plate: me · where]                       [pet][bag][chat][≡]   │  info left · system right
//!  │ chat log                                         (pet row ↓)    │
//!  │                                                                 │
//!  │                              +                                  │
//!  │                                                       (jump)    │  the skills in an arc
//!  │   ( stick )      [1][2][3][4][5][6][7][8][9][0]   (place) (DIG)  │  round the main action
//!  └─────────────────────────────────────────────────────────────────┘
//! ```
//!
//! Every edge keeps the same safe margin; the left thumb owns the bottom-left, the right thumb the
//! bottom-right, and the hotbar sits between them where neither has to stretch. A desktop (no
//! touch) has no stick or action buttons and a centred hotbar.

use crate::ui::Rect;

/// The safe margin on every edge (dp).
pub const MARGIN: f32 = 14.0;
/// The top bar's height: the plate and the system buttons (dp).
pub const TOP: f32 = 48.0;
const SYS_GAP: f32 = 10.0;

/// The bottom-right action cluster: the main action (dig / use) in the corner, the skills in an
/// arc above and to its left. Angles are screen angles from +x (y down), so 180° is left and 270°
/// up; radii and distances in dp.
pub const PRIMARY_RADIUS: f32 = 44.0;
pub const SKILL_RADIUS: f32 = 30.0;
const ARC_DISTANCE: f32 = 118.0;
/// Three skills round the corner, 45° apart (wide clear gaps, nothing touches): place on the
/// left, the shape (F) between, jump on top. Turn (R) is a small badge on the shape skill, like a
/// skill's level-up button: it belongs to that skill, not the ring.
const PLACE_ANGLE: f32 = 180.0;
const SHAPE_ANGLE: f32 = 225.0;
const JUMP_ANGLE: f32 = 270.0;
pub const BADGE_RADIUS: f32 = 17.0;

/// The stick's well (its travel and rim) and where it rests (dp).
pub const STICK_WELL: f32 = 74.0;

/// The system buttons, left to right in the top-right strip.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sys {
    Pet,
    /// C: gestures, postures and the character (emoteMenu.ts).
    Emote,
    Bag,
    Chat,
    Menu,
}

#[derive(Clone, Debug)]
pub struct HudLayout {
    pub plate: Rect,
    pub system: Vec<(Sys, Rect)>,
    /// The pet row when open: five animals then sit/follow, right-aligned under the strip.
    pub pet_row: Vec<Rect>,
    /// Touch only: the stick's resting centre, and the action buttons' (centre, radius). The
    /// tests read them; input.rs reaches the same centres through `actions` / `stick_rest`.
    #[allow(dead_code)]
    pub stick: Option<(f32, f32)>,
    #[allow(dead_code)]
    pub dig: Option<(f32, f32, f32)>,
    #[allow(dead_code)]
    pub jump: Option<(f32, f32, f32)>,
    #[allow(dead_code)]
    pub place: Option<(f32, f32, f32)>,
    #[allow(dead_code)]
    pub shape: Option<(f32, f32, f32)>,
    #[allow(dead_code)]
    pub turn: Option<(f32, f32, f32)>,
    pub hotbar: Vec<Rect>,
}

fn at(cx: f32, cy: f32, angle_deg: f32, d: f32) -> (f32, f32) {
    let a = angle_deg.to_radians();
    (cx + a.cos() * d, cy + a.sin() * d)
}

/// Slots smaller than this between the thumbs, and the hotbar takes the whole bottom edge with the
/// thumb controls lifted above it (a narrow phone).
const MIN_SLOT: f32 = 40.0;

/// How far the thumb controls are lifted (0, or the bottom-edge hotbar's height and a gap).
fn lift(w: f32) -> f32 {
    let (d, s) = (corner(w, 0.0), MARGIN + STICK_WELL);
    let place_x = at(d.0, d.1, PLACE_ANGLE, ARC_DISTANCE).0;
    let room = (place_x - SKILL_RADIUS - 14.0) - (s + STICK_WELL + 12.0);
    if room / 10.0 - 4.0 >= MIN_SLOT {
        0.0
    } else {
        bar_size(MARGIN, w - MARGIN) + 12.0
    }
}

fn corner(w: f32, h: f32) -> (f32, f32) {
    (w - MARGIN - PRIMARY_RADIUS - 8.0, h - MARGIN - PRIMARY_RADIUS - 12.0)
}

/// The action cluster's centres (touch): the main button, jump and place (dp).
pub fn actions(w: f32, h: f32) -> ((f32, f32), (f32, f32), (f32, f32)) {
    let (cx, cy) = corner(w, h - lift(w));
    ((cx, cy), at(cx, cy, JUMP_ANGLE, ARC_DISTANCE), at(cx, cy, PLACE_ANGLE, ARC_DISTANCE))
}

/// The building skills' centres (touch): shape (F) and turn (R).
pub fn build_skills(w: f32, h: f32) -> ((f32, f32), (f32, f32)) {
    let (cx, cy) = corner(w, h - lift(w));
    let shape = at(cx, cy, SHAPE_ANGLE, ARC_DISTANCE);
    // the badge on the shape skill's outer edge, half on it
    (shape, at(shape.0, shape.1, SHAPE_ANGLE, SKILL_RADIUS + BADGE_RADIUS * 0.35))
}

/// The stick's resting centre (touch).
pub fn stick_rest(w: f32, h: f32) -> (f32, f32) {
    (MARGIN + STICK_WELL, h - lift(w) - MARGIN - STICK_WELL)
}

/// The play screen's layout on a `w` × `h` dp screen. `touch`: a phone's controls; `class`: the
/// chat button is there (a shared field).
pub fn layout(w: f32, h: f32, touch: bool, class: bool) -> HudLayout {
    let plate = Rect::new(MARGIN, MARGIN, (w * 0.3).clamp(200.0, 300.0), TOP);
    let order: Vec<Sys> = if class { vec![Sys::Pet, Sys::Emote, Sys::Bag, Sys::Chat, Sys::Menu] } else { vec![Sys::Pet, Sys::Emote, Sys::Bag, Sys::Menu] };
    let n = order.len() as f32;
    let x0 = w - MARGIN - n * TOP - (n - 1.0) * SYS_GAP;
    let system: Vec<(Sys, Rect)> = order.iter().enumerate().map(|(i, s)| (*s, Rect::new(x0 + i as f32 * (TOP + SYS_GAP), MARGIN, TOP, TOP))).collect();
    let row_y = MARGIN + TOP + 12.0;
    let pick = 44.0;
    // six picks right-aligned under the strip (the sit/follow button is the right-most, widest)
    let mut pet_row = Vec::new();
    let mut x = w - MARGIN - 96.0;
    pet_row.push(Rect::new(x, row_y, 96.0, pick));
    for _ in 0..5 {
        x -= pick + 8.0;
        pet_row.insert(0, Rect::new(x, row_y, pick, pick));
    }
    let (sh, tu) = build_skills(w, h);
    let (shape, turn) = if touch { (Some((sh.0, sh.1, SKILL_RADIUS)), Some((tu.0, tu.1, BADGE_RADIUS))) } else { (None, None) };
    let (stick, dig, jump, place, hotbar) = if touch {
        let (d, j, p) = actions(w, h);
        let s = stick_rest(w, h);
        // the hotbar between the thumbs (right of the stick's well, left of the cluster), or on a
        // narrow phone along the whole bottom edge under them
        let hotbar = if lift(w) > 0.0 { bar(MARGIN, w - MARGIN, h) } else { bar(s.0 + STICK_WELL + 12.0, p.0 - SKILL_RADIUS - 14.0, h) };
        (Some(s), Some((d.0, d.1, PRIMARY_RADIUS)), Some((j.0, j.1, SKILL_RADIUS)), Some((p.0, p.1, SKILL_RADIUS)), hotbar)
    } else {
        (None, None, None, None, bar(MARGIN, w - MARGIN, h))
    };
    HudLayout { plate, system, pet_row, stick, dig, jump, place, shape, turn, hotbar }
}

/// Ten slots centred between `left` and `right`, on the bottom margin.
fn bar_size(left: f32, right: f32) -> f32 {
    ((right - left) / 10.0 - 4.0).clamp(30.0, 54.0)
}

fn bar(left: f32, right: f32, h: f32) -> Vec<Rect> {
    let gap = 4.0;
    let size = bar_size(left, right);
    let total = size * 10.0 + gap * 9.0;
    let x0 = left + ((right - left) - total) / 2.0;
    (0..10).map(|i| Rect::new(x0 + i as f32 * (size + gap), h - MARGIN - size, size, size)).collect()
}

/// The emote panel's choices (emoteMenu.ts, the ones the app has): gestures, postures, the character.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmoteItem {
    Wave,
    Cheer,
    Smile,
    Laugh,
    Wink,
    Sit,
    Lie,
    Stand,
    Home,
    Tt,
}

/// The panel, its items, and each row's label (its y and text).
pub type EmotePanel = (Rect, Vec<(EmoteItem, Rect)>, [(f32, &'static str); 4]);

/// The emote panel (right-aligned under the strip) and its items: three rows — 동작, 자세, 캐릭터
/// — each a label then its pills (dp).
pub fn emote_panel(w: f32) -> EmotePanel {
    let (pw, row, pill) = (330.0, 46.0, 72.0);
    let panel = Rect::new(w - MARGIN - pw, MARGIN + TOP + 12.0, pw, 4.0 * row + 20.0);
    let rows: [(&str, &[EmoteItem]); 4] = [
        ("표정", &[EmoteItem::Smile, EmoteItem::Laugh, EmoteItem::Wink]),
        ("동작", &[EmoteItem::Wave, EmoteItem::Cheer]),
        ("자세", &[EmoteItem::Sit, EmoteItem::Lie, EmoteItem::Stand]),
        ("캐릭터", &[EmoteItem::Home, EmoteItem::Tt]),
    ];
    let mut items = Vec::new();
    let mut labels = [(0.0, ""); 4];
    for (r, (label, its)) in rows.iter().enumerate() {
        let y = panel.y + 10.0 + r as f32 * row;
        labels[r] = (y + (row - 20.0) / 2.0, label);
        for (i, it) in its.iter().enumerate() {
            items.push((*it, Rect::new(panel.x + 92.0 + i as f32 * (pill + 8.0), y + 4.0, pill, row - 8.0)));
        }
    }
    (panel, items, labels)
}

impl HudLayout {
    pub fn sys(&self, s: Sys) -> Option<Rect> {
        self.system.iter().find(|x| x.0 == s).map(|x| x.1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rects(l: &HudLayout) -> Vec<(String, Rect)> {
        let disc = |c: (f32, f32, f32)| Rect::new(c.0 - c.2, c.1 - c.2, 2.0 * c.2, 2.0 * c.2);
        let mut v = vec![("plate".to_owned(), l.plate)];
        v.extend(l.system.iter().map(|(s, r)| (format!("{s:?}"), *r)));
        v.extend(l.hotbar.iter().enumerate().map(|(i, r)| (format!("slot{i}"), *r)));
        if let Some(s) = l.stick {
            v.push(("stick".into(), Rect::new(s.0 - STICK_WELL, s.1 - STICK_WELL, 2.0 * STICK_WELL, 2.0 * STICK_WELL)));
        }
        for (n, c) in [("dig", l.dig), ("jump", l.jump), ("place", l.place), ("shape", l.shape), ("turn", l.turn)] {
            if let Some(c) = c {
                v.push((n.into(), disc(c)));
            }
        }
        v
    }

    fn overlap(a: Rect, b: Rect) -> bool {
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    }

    #[test]
    fn nothing_overlaps_and_everything_keeps_the_margin_on_phones_and_desktops() {
        // a small phone, a big phone, a tablet, a desktop window
        for (w, h, touch) in [(740.0, 360.0, true), (915.0, 412.0, true), (1180.0, 820.0, true), (1280.0, 720.0, false)] {
            for class in [false, true] {
                let l = layout(w, h, touch, class);
                let all = rects(&l);
                for (name, r) in &all {
                    assert!(r.x >= MARGIN - 0.5 && r.y >= MARGIN - 0.5 && r.x + r.w <= w - MARGIN + 0.5 && r.y + r.h <= h - MARGIN + 0.5, "{name} off the safe area on {w}x{h}: {r:?}");
                }
                let discs = ["dig", "jump", "place", "shape", "turn"];
                for (i, (a, ra)) in all.iter().enumerate() {
                    for (b, rb) in &all[i + 1..] {
                        // two round buttons: their circles, not their boxes
                        // the turn badge sits on its shape skill by design
                        let badge = (a == "shape" && b == "turn") || (a == "turn" && b == "shape");
                        let clash = if badge {
                            false
                        } else if discs.contains(&a.as_str()) && discs.contains(&b.as_str()) {
                            let (ca, cb) = ((ra.x + ra.w / 2.0, ra.y + ra.h / 2.0), (rb.x + rb.w / 2.0, rb.y + rb.h / 2.0));
                            // round buttons keep a clear 10 dp gap (they read as separate, never touch)
                            (ca.0 - cb.0).hypot(ca.1 - cb.1) < (ra.w + rb.w) / 2.0 + 10.0
                        } else {
                            overlap(*ra, *rb)
                        };
                        assert!(!clash, "{a} overlaps {b} on {w}x{h}");
                    }
                }
                assert!(l.hotbar[0].w >= 36.0, "slots stay thumb-sized on {w}x{h}: {}", l.hotbar[0].w);
            }
        }
    }

    #[test]
    fn the_thumbs_own_their_corners() {
        let l = layout(915.0, 412.0, true, true);
        let (dig, jump, place, stick) = (l.dig.unwrap(), l.jump.unwrap(), l.place.unwrap(), l.stick.unwrap());
        assert!(dig.0 >= jump.0 - 0.01 && dig.0 > place.0 && dig.1 > jump.1, "the main action is the corner, the skills arc above and left");
        assert!(dig.2 > jump.2, "and it is the biggest");
        assert!(stick.0 < 915.0 * 0.2 && stick.1 > 412.0 * 0.6, "the stick is bottom-left");
        assert_eq!(l.system.last().unwrap().0, Sys::Menu, "the menu is the far corner");
        assert!(l.system.iter().all(|(_, r)| r.y == MARGIN) && l.plate.y == MARGIN, "the top bar is one line");
        // the pet row opens under the strip without leaving the screen
        assert!(l.pet_row.iter().all(|r| r.x >= MARGIN && r.x + r.w <= 915.0 - MARGIN && r.y > l.system[0].1.y + TOP));
    }
}
