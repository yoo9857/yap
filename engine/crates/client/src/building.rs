//! Digging and placing, the web's rules (craftGame.ts) reduced to the native app's first cut:
//!
//! - Aim: a ray from the body's eye along the exact view (not the eased one), REACH 6 m, stopping
//!   at water only while the bucket is held (craftGame's `fluids`).
//! - Hand digging: the target's progress grows by real seconds and the block breaks at its
//!   `hardness` (blocks.ts); a new target, or a block that changed, starts over; bedrock never breaks.
//! - Placing: the hotbar's block as the 네모형 piece (KIT_CUBE), into air or water only, never into
//!   furniture, never into the player's own body or a classmate's (blockPlacement.ts +
//!   ClassSync.bodyInGridCell).
//! - The hotbar: the web's bars (inventory.ts HOTBAR for the island, FIELD_HOTBAR for the field,
//!   slot 0 the endless water bucket). The island counts blocks (mined ones go in, placed ones come
//!   out); the field has 999 of everything (it never runs out).
//!
//! Not yet: the pickaxe and its swing, the other five shapes (F), furniture placement, the bag.

use craftyap_core::blocks_gen::{BLOCKS, KIT_CUBE};
use craftyap_core::body::{BodyWorld, Body};
use craftyap_core::fluid::is_water;
use craftyap_core::shapes::{shape_intersects_box, ShapeBox};
use craftyap_core::world::{RayHit, World, AIR};
use std::collections::{HashMap, HashSet};

/// craftGame.ts REACH (m).
pub const REACH: f64 = 6.0;
pub const WATER_KEY: &str = "water";

/// inventory.ts HOTBAR (island) and FIELD_HOTBAR (education field); the last slot is the bucket.
pub const ISLAND_BAR: [&str; 10] = ["dirt", "stone", "sand", "oak-log", "oak-planks", "stone-bricks", "glass", "glowstone", "gold-block", WATER_KEY];
pub const FIELD_BAR: [&str; 10] = ["white-wool", "red-bricks", "oak-planks", "glass", "glowstone", "flower-grass", "question-block", "red-mushroom", "ice", WATER_KEY];

#[allow(dead_code)] // PICKAXE_NAME: for the held pickaxe (next)
mod groups {
    include!("groups_gen.rs");
}
pub use groups::*;

/// The construction shapes (pieces.ts PIECES, the owner's palette 2026-11-04): one cell each.
/// (key, Korean name, turns with R / tips with T).
pub const PIECES: [(&str, &str, bool); 6] = [("1x1", "네모형", false), ("slope", "삼각형", true), ("corner-slope", "모서리형", true), ("round", "원형", false), ("slab", "반블록형", true), ("stairs", "계단형", true)];

/// pieces.ts pieceShape: the shape code a piece is placed with, turned `yaw` and tipped `tilt`
/// (quarter turns): blockShapes.ts kitSlopeShape / cornerShape / slabShape / stairsShape.
pub fn piece_shape(piece: usize, yaw: u8, tilt: u8) -> u8 {
    use craftyap_core::shapes::{CORNER_BASE, KIT_CUBE, KIT_SLOPE_BASE, ROUND, SLAB_BASE, STAIRS_BASE};
    let o = (yaw % 4) + 4 * (tilt % 4);
    match PIECES.get(piece).map(|p| p.0) {
        Some("slope") => KIT_SLOPE_BASE + o,
        Some("corner-slope") => CORNER_BASE + o,
        Some("round") => ROUND,
        Some("slab") => SLAB_BASE + o,
        Some("stairs") => STAIRS_BASE + o,
        _ => KIT_CUBE,
    }
}

/// The last slot: the endless bucket, never reassigned (inventory.ts WATER_SLOT).
pub const WATER_SLOT: usize = 9;

/// inventory.ts isPlaceableItem: a block you can hold and place (not a fluid, breakable).
fn placeable(d: &craftyap_core::blocks_gen::BlockDef) -> bool {
    !d.fluid && d.hardness > 0.0
}

/// An item key the bar can hold, as a 'static str (the catalog's own, or the pickaxe's); "" for none.
fn holdable(key: &str) -> Option<&'static str> {
    if key == PICKAXE_KEY {
        return Some(PICKAXE_KEY);
    }
    def(key).filter(|d| placeable(d)).map(|d| d.key)
}

/// The item's bag tab (groups_gen.rs, from inventory.ts blockGroup).
pub fn item_group(key: &str) -> Option<&'static str> {
    ITEM_GROUP.iter().find(|g| g.0 == key).map(|g| g.1)
}

/// The block catalog entry for a key.
pub fn def(key: &str) -> Option<&'static craftyap_core::blocks_gen::BlockDef> {
    BLOCKS.iter().find(|b| b.key == key)
}

pub fn def_by_id(block: u8) -> Option<&'static craftyap_core::blocks_gen::BlockDef> {
    BLOCKS.iter().find(|b| b.id == block)
}

pub struct Hotbar {
    pub slots: [&'static str; 10],
    pub selected: usize,
    /// None: unlimited (the field). Some: the island's bag.
    pub counts: Option<HashMap<String, u32>>,
}

impl Hotbar {
    pub fn island() -> Self {
        Hotbar { slots: ISLAND_BAR, selected: 0, counts: Some(HashMap::new()) }
    }
    pub fn field() -> Self {
        Hotbar { slots: FIELD_BAR, selected: 0, counts: None }
    }
    pub fn key(&self) -> &'static str {
        self.slots[self.selected.min(9)]
    }
    pub fn holding_water(&self) -> bool {
        self.key() == WATER_KEY
    }
    /// The island's bar (it spends from a bag); the field's is endless.
    pub fn is_island(&self) -> bool {
        self.counts.is_some()
    }
    #[allow(dead_code)] // the held pickaxe (next)
    pub fn holding_pickaxe(&self) -> bool {
        self.key() == PICKAXE_KEY
    }

    /// inventory.ts assignHotbar: put `key` in `slot` (never the bucket's); a key already on the bar
    /// trades places with what was there. False: not a slot, or nothing the bar can hold.
    pub fn assign(&mut self, slot: usize, key: &str) -> bool {
        let Some(key) = holdable(key) else { return false };
        if slot >= WATER_SLOT {
            return false;
        }
        if let Some(existing) = self.slots[..WATER_SLOT].iter().position(|k| *k == key) {
            if existing != slot {
                self.slots[existing] = self.slots[slot];
            }
        }
        self.slots[slot] = key;
        self.slots[WATER_SLOT] = WATER_KEY;
        true
    }

    /// Restore a saved bar: each known key in its place, the rest empty, the bucket last.
    pub fn load_slots(&mut self, saved: &[String]) {
        let mut slots = [""; 10];
        for (i, k) in saved.iter().take(WATER_SLOT).enumerate() {
            if let Some(k) = holdable(k) {
                if !slots.contains(&k) {
                    slots[i] = k;
                }
            }
        }
        slots[WATER_SLOT] = WATER_KEY;
        self.slots = slots;
    }

    /// What the bag shows: (item key, how many — None: endless), the pickaxe first. The island's bag
    /// holds what was mined (and the starter pickaxe, which is never used up); the field has every
    /// placeable block.
    pub fn items(&self) -> Vec<(&'static str, Option<u32>)> {
        // the tool is never used up: no count on it (as the web's bag)
        let mut out = vec![(PICKAXE_KEY, None)];
        for d in BLOCKS.iter().filter(|d| placeable(d)) {
            match &self.counts {
                Some(c) => {
                    if let Some(&n) = c.get(d.key).filter(|n| **n > 0) {
                        out.push((d.key, Some(n)));
                    }
                }
                None => out.push((d.key, None)),
            }
        }
        out
    }
    /// How many of a slot's block are left (None: endless).
    pub fn count(&self, slot: usize) -> Option<u32> {
        let key = self.slots.get(slot)?;
        if *key == WATER_KEY || *key == PICKAXE_KEY || key.is_empty() {
            return None;
        }
        self.counts.as_ref().map(|c| c.get(*key).copied().unwrap_or(0))
    }
    pub fn select(&mut self, slot: usize) {
        if slot < 10 {
            self.selected = slot;
        }
    }
    /// One slot up or down, wrapping (the wheel zooms the camera now; kept for a gamepad).
    #[allow(dead_code)]
    pub fn scroll(&mut self, steps: i32) {
        self.selected = (self.selected as i32 + steps).rem_euclid(10) as usize;
    }
    /// A mined block's drop goes in the bag (blocks.ts `drops`, else the block itself).
    pub fn collect(&mut self, block: u8) {
        let Some(d) = def_by_id(block) else { return };
        let key = d.drops.unwrap_or(d.key);
        if let Some(c) = &mut self.counts {
            let n = c.entry(key.to_owned()).or_insert(0);
            *n = (*n + 1).min(9999);
        }
    }
    /// Take one of the held block to place it. None: nothing to place.
    pub fn take(&mut self) -> Option<u8> {
        let key = self.key();
        if key == WATER_KEY {
            return Some(craftyap_core::fluid::WATER);
        }
        let block = def(key)?.id;
        if let Some(c) = &mut self.counts {
            let n = c.get_mut(key)?;
            if *n == 0 {
                return None;
            }
            *n -= 1;
        }
        Some(block)
    }
}

/// A world plus furniture for the body and the rays: solid furniture cells block like blocks do
/// (VoxelWorld.propSolid) — but `is_solid` stays the blocks' own, as the web keeps it.
pub struct WithProps<'a> {
    pub world: &'a World,
    pub props: &'a HashSet<(i32, i32, i32)>,
}

impl BodyWorld for WithProps<'_> {
    fn is_solid(&self, x: i32, y: i32, z: i32) -> bool {
        self.world.is_solid(x, y, z)
    }
    fn get_shape(&self, x: i32, y: i32, z: i32) -> u8 {
        self.world.get_shape(x, y, z)
    }
    fn water_at(&self, x: i32, y: i32, z: i32) -> u8 {
        self.world.water_at(x, y, z)
    }
    fn prop_solid(&self, x: i32, y: i32, z: i32) -> bool {
        self.props.contains(&(x, y, z))
    }
}

/// What the crosshair is on (craftGame's aim): from the eye along the exact view.
pub fn aim(world: &World, eye: [f64; 3], yaw: f64, pitch: f64, fluids: bool) -> Option<RayHit> {
    let (sp, cp) = pitch.sin_cos();
    let (dx, dy, dz) = (yaw.sin() * cp, sp, yaw.cos() * cp);
    world.raycast(eye[0], eye[1], eye[2], dx, dy, dz, REACH, fluids)
}

/// Hand digging: progress on one target.
#[derive(Default, Debug, Clone, PartialEq)]
pub struct Dig {
    target: Option<([i32; 3], u8, u8)>,
    progress: f64,
}

impl Dig {
    /// 0..1 for the crack overlay, None when not digging.
    pub fn fraction(&self, world: &World) -> Option<f32> {
        let (cell, _, _) = self.target?;
        let d = def_by_id(world.get(cell[0], cell[1], cell[2]))?;
        (d.hardness > 0.0).then(|| (self.progress / d.hardness as f64).clamp(0.0, 1.0) as f32)
    }
    pub fn stop(&mut self) {
        *self = Dig::default();
    }
    /// One frame of holding dig on `cell`. Returns the block id when it breaks.
    pub fn step(&mut self, world: &World, cell: [i32; 3], dt: f64) -> Option<u8> {
        let block = world.get(cell[0], cell[1], cell[2]);
        let shape = world.get_shape(cell[0], cell[1], cell[2]);
        let Some(d) = def_by_id(block) else {
            self.stop();
            return None;
        };
        if d.hardness <= 0.0 || block == AIR || is_water(block) {
            self.stop(); // bedrock, or nothing to dig
            return None;
        }
        if self.target != Some((cell, block, shape)) {
            self.target = Some((cell, block, shape));
            self.progress = 0.0;
        }
        self.progress += if dt.is_finite() { dt.clamp(0.0, 0.25) } else { 0.0 };
        if self.progress >= d.hardness as f64 {
            self.stop();
            return Some(block);
        }
        None
    }
}

/// May a block go in `cell`? Air or water only, no furniture there, and not inside a body.
pub fn can_place(world: &World, props: &HashSet<(i32, i32, i32)>, cell: [i32; 3], bodies: &[Body]) -> bool {
    let [x, y, z] = cell;
    if !World::in_bounds(x, y, z) || props.contains(&(x, y, z)) {
        return false;
    }
    let here = world.get(x, y, z);
    if here != AIR && !is_water(here) {
        return false;
    }
    !bodies.iter().any(|b| {
        let half = b.w.unwrap_or(0.6) / 2.0;
        let h = b.h.unwrap_or(1.8);
        shape_intersects_box(KIT_CUBE, &ShapeBox { min: [b.x - half - x as f64, b.y - y as f64, b.z - half - z as f64], max: [b.x + half - x as f64, b.y + h - y as f64, b.z + half - z as f64] })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use craftyap_core::world::{generate_field, id};

    #[test]
    fn digging_takes_the_blocks_hardness_and_a_new_target_starts_over() {
        let mut w = generate_field();
        let stone = id("stone");
        w.set(10, 4, 10, stone);
        w.set(11, 4, 10, stone);
        let hard = def("stone").unwrap().hardness as f64;
        let mut d = Dig::default();
        let mut t = 0.0;
        let mut broke = None;
        while broke.is_none() && t < 10.0 {
            broke = d.step(&w, [10, 4, 10], 1.0 / 60.0);
            t += 1.0 / 60.0;
        }
        assert_eq!(broke, Some(stone));
        assert!((t - hard).abs() < 0.05, "{t} vs hardness {hard}");
        d.step(&w, [10, 4, 10], 0.1);
        d.step(&w, [11, 4, 10], 0.01);
        assert!(d.fraction(&w).unwrap() < 0.1, "switching blocks restarts");
        // bedrock never breaks
        let mut d = Dig::default();
        for _ in 0..2000 {
            assert!(d.step(&w, [10, 0, 10], 0.05).is_none());
        }
    }

    #[test]
    fn placement_refuses_solids_furniture_and_bodies() {
        let w = generate_field();
        let props: HashSet<_> = [(5, 4, 5)].into_iter().collect();
        assert!(can_place(&w, &props, [3, 4, 3], &[]));
        assert!(!can_place(&w, &props, [3, 3, 3], &[]), "grass is there");
        assert!(!can_place(&w, &props, [5, 4, 5], &[]), "furniture is there");
        let me = Body::at(7.5, 4.0, 7.5);
        assert!(!can_place(&w, &props, [7, 4, 7], &[me]), "inside my body");
        assert!(!can_place(&w, &props, [7, 5, 7], &[me]), "my head");
        assert!(can_place(&w, &props, [7, 6, 7], &[me]), "above my head is fine");
    }

    #[test]
    fn the_island_bag_counts_and_the_field_never_runs_out() {
        let mut bar = Hotbar::island();
        bar.select(1); // stone
        assert_eq!(bar.take(), None, "the island starts with an empty bag");
        bar.collect(id("stone"));
        assert_eq!(bar.count(1), Some(1));
        assert_eq!(bar.take(), Some(id("stone")));
        assert_eq!(bar.count(1), Some(0));
        bar.collect(id("grass"));
        assert_eq!(bar.count(0), Some(1), "grass drops dirt");
        bar.select(9);
        assert!(bar.holding_water() && bar.take() == Some(19) && bar.count(9).is_none());
        let mut field = Hotbar::field();
        for _ in 0..2000 {
            assert!(field.take().is_some());
        }
        field.scroll(-1);
        assert_eq!(field.selected, 9);
        field.scroll(3);
        assert_eq!(field.selected, 2);
        assert!(FIELD_BAR.iter().chain(&ISLAND_BAR).all(|k| def(k).is_some()), "every bar key is a block");
    }

    #[test]
    fn loading_a_slot_swaps_like_assign_hotbar_and_the_bucket_stays_last() {
        let mut bar = Hotbar::island();
        assert!(bar.assign(0, "stone"), "stone was in slot 1: it moves to 0");
        assert_eq!((bar.slots[0], bar.slots[1]), ("stone", "dirt"), "and dirt takes its old place");
        assert!(bar.assign(2, PICKAXE_KEY));
        bar.select(2);
        assert!(bar.holding_pickaxe() && bar.take().is_none(), "a tool is never placed");
        assert_eq!(bar.count(2), None, "and has no pile count");
        assert!(!bar.assign(WATER_SLOT, "glass"), "the bucket's slot is fixed");
        assert!(!bar.assign(3, "water") && !bar.assign(3, "bedrock") && !bar.assign(3, "nope"), "fluids, unbreakables and unknowns are not held");
        assert_eq!(bar.slots[WATER_SLOT], WATER_KEY);
        // a saved bar: unknown keys and duplicates drop out, the bucket is put back
        bar.load_slots(&["glass".into(), "glass".into(), "nope".into(), PICKAXE_KEY.into(), "water".into()]);
        assert_eq!(&bar.slots[..5], &["glass", "", "", PICKAXE_KEY, ""]);
        assert_eq!(bar.slots[WATER_SLOT], WATER_KEY);
    }

    #[test]
    fn the_bag_lists_what_is_owned_on_the_island_and_everything_in_the_field() {
        let mut bar = Hotbar::island();
        assert_eq!(bar.items(), vec![(PICKAXE_KEY, None)], "a new island: just the starter pickaxe");
        bar.collect(id("stone"));
        bar.collect(id("stone"));
        assert!(bar.items().contains(&("stone", Some(2))));
        let field = Hotbar::field().items();
        assert!(field.len() > 40 && field.iter().all(|(k, n)| n.is_none() && (*k == PICKAXE_KEY || def(k).is_some_and(|d| !d.fluid && d.hardness > 0.0))));
        assert!(field.iter().all(|(k, _)| item_group(k).is_some()), "every item has a bag tab");
    }

    #[test]
    fn pieces_encode_like_block_shapes_ts() {
        use craftyap_core::shapes::*;
        assert_eq!(piece_shape(0, 3, 2), KIT_CUBE, "the square never turns");
        assert_eq!(piece_shape(3, 1, 1), ROUND);
        assert_eq!(piece_shape(1, 0, 0), KIT_SLOPE_BASE);
        assert_eq!(piece_shape(1, 3, 1), KIT_SLOPE_BASE + 3 + 4);
        assert_eq!(piece_shape(2, 2, 0), CORNER_BASE + 2);
        assert_eq!(piece_shape(4, 1, 3), SLAB_BASE + 1 + 12);
        assert_eq!(piece_shape(5, 3, 3), STAIRS_BASE + 15);
        assert_eq!(piece_shape(5, 3, 3), MAX_BLOCK_SHAPE, "the last code is the last stairs");
        assert_eq!(piece_shape(9, 0, 0), KIT_CUBE, "an unknown piece is a cube");
    }

    #[test]
    fn the_aim_finds_the_block_in_front() {
        let mut w = generate_field();
        w.set(10, 5, 14, id("stone"));
        let hit = aim(&w, [10.5, 5.5, 10.5], 0.0, 0.0, false).unwrap();
        assert_eq!(hit.voxel, [10, 5, 14]);
        assert_eq!(hit.before, [10, 5, 13]);
        assert!(aim(&w, [10.5, 5.5, 10.5], std::f64::consts::PI, 0.0, false).is_none(), "nothing behind within reach");
        let down = aim(&w, [10.5, 5.5, 10.5], 0.0, -1.5, false).unwrap();
        assert_eq!(down.voxel[1], 3, "the grass below");
    }

    #[test]
    fn furniture_blocks_the_body_but_not_the_blocks_own_faces() {
        let w = generate_field();
        let props: HashSet<_> = [(4, 4, 4)].into_iter().collect();
        let v = WithProps { world: &w, props: &props };
        assert!(v.is_blocked(4, 4, 4) && !v.is_solid(4, 4, 4));
    }
}
