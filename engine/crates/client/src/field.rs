//! The education field on the native client: the web's `FieldWindow` (fieldWorld.ts). The voxel
//! grid stays the fixed 160 × 160 window; the field scrolls it under the player in whole chunks
//! (16 cells) once the player drifts more than 8 cells from its centre, and the ground outside it
//! is the field column (`World::outside_column`), so it never ends.
//!
//! Every edit is kept by ABSOLUTE coordinate (`edits`) — the classroom speaks absolute coordinates
//! and each machine scrolls its own window — and a scroll refills the window from them. The world
//! is an `Arc`: a change goes through `Arc::make_mut`, which copies only while a mesher job still
//! holds the previous snapshot.

use craftyap_core::world::{field_column, World, WORLD_X, WORLD_Y, WORLD_Z};
use std::collections::HashMap;
use std::sync::Arc;

const STEP: i32 = 16;
const RECENTER: f64 = 8.0;
const CENTER_X: i32 = WORLD_X / 2;
const CENTER_Z: i32 = WORLD_Z / 2;

pub struct FieldWindow {
    pub world: Arc<World>,
    column: Vec<u8>,
    /// Absolute (x, y, z) → (block, shape) of every cell that differs from the flat field.
    edits: HashMap<(i32, i32, i32), (u8, u8)>,
    /// Absolute (x, y, z) → water held inside a shaped block (flow state, the server's).
    wet: HashMap<(i32, i32, i32), u8>,
    /// Absolute coordinate of grid cell (0, 0).
    pub origin_x: i32,
    pub origin_z: i32,
}

impl Default for FieldWindow {
    fn default() -> Self {
        Self::new()
    }
}

impl FieldWindow {
    pub fn new() -> Self {
        let mut f = FieldWindow { world: Arc::new(craftyap_core::world::generate_field()), column: field_column(), edits: HashMap::new(), wet: HashMap::new(), origin_x: -CENTER_X, origin_z: -CENTER_Z };
        f.fill();
        f
    }

    /// Where a player appears: the window's centre on the grass (grid coordinates).
    pub fn spawn(&self) -> [f64; 3] {
        [CENTER_X as f64 + 0.5, craftyap_core::world::FIELD_TOP as f64 + 1.0, CENTER_Z as f64 + 0.5]
    }

    pub fn to_abs(&self, x: f64, z: f64) -> (f64, f64) {
        (x + self.origin_x as f64, z + self.origin_z as f64)
    }

    pub fn to_grid(&self, x: f64, z: f64) -> (f64, f64) {
        (x - self.origin_x as f64, z - self.origin_z as f64)
    }

    #[cfg(test)]
    pub fn edit_count(&self) -> usize {
        self.edits.len()
    }

    /// One cell's new value in absolute coordinates (the flat field's own value removes the edit).
    /// Returns the grid cell when it lies in the window (its chunk needs meshing again).
    pub fn apply(&mut self, x: i32, y: i32, z: i32, block: u8, shape: u8) -> Option<(i32, i32, i32)> {
        if !(0..WORLD_Y).contains(&y) {
            return None;
        }
        let flat = self.column[y as usize];
        if block == flat && shape == 0 {
            self.edits.remove(&(x, y, z));
        } else {
            self.edits.insert((x, y, z), (block, shape));
        }
        // writing a cell clears the water it held (as on the web and the server), in or out of view
        self.wet.remove(&(x, y, z));
        let (gx, gz) = (x - self.origin_x, z - self.origin_z);
        if !World::in_bounds(gx, y, gz) {
            return None;
        }
        let w = Arc::make_mut(&mut self.world);
        if shape == 0 { w.set(gx, y, gz, block) } else { w.set_shaped(gx, y, gz, block, shape) }
        Some((gx, y, gz))
    }

    /// Water inside a shaped block at an absolute cell (0 = dry). Returns the grid cell when in the window.
    pub fn apply_wet(&mut self, x: i32, y: i32, z: i32, water: u8) -> Option<(i32, i32, i32)> {
        if water == 0 {
            self.wet.remove(&(x, y, z));
        } else {
            self.wet.insert((x, y, z), water);
        }
        let (gx, gz) = (x - self.origin_x, z - self.origin_z);
        if !World::in_bounds(gx, y, gz) {
            return None;
        }
        let w = Arc::make_mut(&mut self.world);
        w.wet[World::index(gx, y, gz)] = water;
        Some((gx, y, gz))
    }

    /// The teacher wiped the field.
    pub fn reset(&mut self) {
        self.edits.clear();
        self.wet.clear();
        self.fill();
    }

    /// Remove only water, including banked regions and water held inside shaped blocks.
    pub fn drain_water(&mut self) {
        self.edits.retain(|&(_, y, _), value| {
            if !(19..=28).contains(&value.0) { return true; }
            *value = (0, 0);
            self.column[y as usize] != 0
        });
        self.wet.clear();
        self.fill();
    }

    /// Scroll the window if the player (grid coordinates) drifted from its centre. Returns the
    /// grid shift applied — subtract it from every grid position held — or None.
    pub fn recenter(&mut self, x: f64, z: f64) -> Option<(i32, i32)> {
        let snap = |d: f64| (d / STEP as f64).round() as i32 * STEP;
        let dx = if (x - CENTER_X as f64).abs() > RECENTER { snap(x - CENTER_X as f64) } else { 0 };
        let dz = if (z - CENTER_Z as f64).abs() > RECENTER { snap(z - CENTER_Z as f64) } else { 0 };
        if dx == 0 && dz == 0 {
            return None;
        }
        self.origin_x += dx;
        self.origin_z += dz;
        self.fill();
        Some((dx, dz))
    }

    /// The window from scratch: the flat field plus every edit inside it.
    fn fill(&mut self) {
        let mut w = craftyap_core::world::generate_field();
        for (&(x, y, z), &(block, shape)) in &self.edits {
            let (gx, gz) = (x - self.origin_x, z - self.origin_z);
            if World::in_bounds(gx, y, gz) {
                if shape == 0 { w.set(gx, y, gz, block) } else { w.set_shaped(gx, y, gz, block, shape) }
            }
        }
        for (&(x, y, z), &water) in &self.wet {
            let (gx, gz) = (x - self.origin_x, z - self.origin_z);
            if World::in_bounds(gx, y, gz) {
                w.wet[World::index(gx, y, gz)] = water;
            }
        }
        self.world = Arc::new(w);
    }

    #[cfg(test)]
    pub fn is_air(&self, x: i32, y: i32, z: i32) -> bool {
        self.world.get(x - self.origin_x, y, z - self.origin_z) == craftyap_core::world::AIR
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn draining_keeps_builds_and_holes_and_clears_banked_water() {
        let mut f = FieldWindow::new();
        f.apply(0, 4, 0, 19, 0); f.apply(0, 2, 0, 19, 0);
        f.apply(1, 4, 0, 3, 1); f.apply_wet(1, 4, 0, 19);
        f.apply(500, 4, 500, 19, 0); f.apply(500, 2, 500, 19, 0);
        f.drain_water();
        assert_eq!(f.world.get(80, 4, 80), 0);
        assert_eq!(f.world.get(80, 2, 80), 0);
        assert_eq!(f.world.get(81, 4, 80), 3);
        assert!(f.wet.is_empty());
        assert_eq!(f.edits.get(&(500, 2, 500)), Some(&(0, 0)));
        assert!(!f.edits.contains_key(&(500, 4, 500)));
    }
    use craftyap_core::world::{id, AIR, FIELD_TOP};

    #[test]
    fn flat_and_endless() {
        let f = FieldWindow::new();
        assert_eq!(f.world.get(0, FIELD_TOP, 0), id("grass"));
        assert_eq!(f.world.get(5, 1, 5), id("dirt"));
        assert_eq!(f.world.get(5, FIELD_TOP + 1, 5), AIR);
        // outside the grid the ground goes on
        assert_eq!(f.world.get(-500, FIELD_TOP, 900), id("grass"));
        let s = f.spawn();
        let (ax, az) = f.to_abs(s[0], s[2]);
        assert_eq!((ax, az), (0.5, 0.5), "spawn is the field's absolute centre, like the web");
    }

    #[test]
    fn edits_survive_scrolling_both_ways() {
        let mut f = FieldWindow::new();
        let stone = id("stone");
        assert!(f.apply(3, 4, -2, stone, 0).is_some());
        assert!(f.apply(500, 4, 500, stone, 0).is_none(), "outside the window: kept for later");
        assert!(!f.is_air(3, 4, -2));
        // walk far east: the window follows in 16-cell steps
        let mut px = 80.5;
        let mut shifts = 0;
        while f.origin_x + 80 < 500 {
            px += 6.0;
            if let Some((dx, _)) = f.recenter(px, 80.5) {
                px -= dx as f64;
                shifts += 1;
            }
        }
        assert!(shifts > 0 && f.origin_x % 16 == 0);
        assert!((px - 80.5).abs() <= 8.0 + 6.0);
        let mut pz = 80.5;
        while f.origin_z + 80 < 500 {
            pz += 6.0;
            if let Some((_, dz)) = f.recenter(px, pz) {
                pz -= dz as f64;
            }
        }
        assert!(!f.is_air(500, 4, 500), "the far edit appeared when the window reached it");
        // and back: the first edit is still there
        while f.origin_x > -80 || f.origin_z > -80 {
            px -= 6.0;
            pz -= 6.0;
            if let Some((dx, dz)) = f.recenter(px, pz) {
                px -= dx as f64;
                pz -= dz as f64;
            }
        }
        assert!(!f.is_air(3, 4, -2));
    }

    #[test]
    fn writing_the_flat_value_removes_the_edit() {
        let mut f = FieldWindow::new();
        f.apply(1, FIELD_TOP, 1, AIR, 0); // dug a hole
        assert_eq!(f.edit_count(), 1);
        f.apply(1, FIELD_TOP, 1, id("grass"), 0); // filled it
        assert_eq!(f.edit_count(), 0);
        f.apply(2, 9, 2, id("glass"), 0);
        f.reset();
        assert!(f.is_air(2, 9, 2) && f.edit_count() == 0);
        assert!(f.apply(0, 99, 0, 1, 0).is_none() && f.apply(0, -1, 0, 1, 0).is_none(), "bad heights are ignored");
    }

    #[test]
    fn held_water_scrolls_with_the_window_and_a_write_clears_it() {
        let mut f = FieldWindow::new();
        let stone = id("stone");
        f.apply(2, 4, 2, stone, 51);
        f.apply_wet(2, 4, 2, 19);
        f.apply_wet(900, 4, 900, 19); // out of view: kept
        let at = |f: &FieldWindow| f.world.wet[World::index(2 - f.origin_x, 4, 2 - f.origin_z)];
        assert_eq!(at(&f), 19);
        f.recenter(80.5 + 40.0, 80.5);
        f.recenter(80.5 - 40.0, 80.5);
        assert_eq!(at(&f), 19, "a scroll away and back keeps it");
        f.apply(900, 4, 900, stone, 0);
        assert!(!f.wet.contains_key(&(900, 4, 900)), "an out-of-view write clears its water too");
        f.apply(2, 4, 2, stone, 51);
        assert_eq!(at(&f), 0);
    }

    #[test]
    fn a_mesher_snapshot_is_never_changed_under_it() {
        let mut f = FieldWindow::new();
        let snapshot = f.world.clone(); // what a mesher job holds
        f.apply(0, 5, 0, id("stone"), 0);
        let (gx, gz) = (-f.origin_x, -f.origin_z);
        assert_eq!(snapshot.get(gx, 5, gz), AIR);
        assert_eq!(f.world.get(gx, 5, gz), id("stone"));
    }
}
