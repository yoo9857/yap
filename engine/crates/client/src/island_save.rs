//! The solo island's save, like the web's (craftSave: the island regenerates from its seed, the save
//! holds only what the player changed): every cell that differs from the freshly generated island,
//! the bag, and where the player stood. A JSON file beside the profile, written atomically.
//!
//! Read like a hostile file (the web's zod-validated save): a cell out of bounds, an unknown block,
//! a bad shape or a bag entry for an unknown block is dropped on its own, an unreadable file or a
//! save of another island is a fresh island — never a crash, and never a half-applied world.

use crate::building::{def, def_by_id};
use craftyap_core::world::World;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

pub const VERSION: u32 = 1;
/// The web's cap on a save's edit list (a runaway save never becomes a runaway load).
pub const MAX_EDITS: usize = 300_000;
const MAX_COUNT: u32 = 9999;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IslandSave {
    pub v: u32,
    /// The island's seed: a save of another island is not applied to this one.
    pub seed: f64,
    /// (x, y, z, block, shape) per changed cell.
    pub edits: Vec<(i32, i32, i32, u8, u8)>,
    /// Block key → how many (the island's bag).
    pub bag: HashMap<String, u32>,
    /// Feet position and view yaw.
    pub player: Option<[f64; 4]>,
    /// The hotbar as loaded from the bag (absent in older saves: the default bar).
    #[serde(default)]
    pub hotbar: Option<Vec<String>>,
}

fn path() -> Option<PathBuf> {
    crate::profile::data_dir().map(|d| d.join("island.json"))
}

fn valid_block(id: u8) -> bool {
    id == 0 || craftyap_core::fluid::is_water(id) || def_by_id(id).is_some()
}

impl IslandSave {
    /// The save for `world` against its pristine island: every cell that differs.
    pub fn diff(seed: f64, pristine: &World, edits: &HashMap<(i32, i32, i32), (u8, u8)>, bag: &HashMap<String, u32>, player: [f64; 4]) -> IslandSave {
        let mut list: Vec<(i32, i32, i32, u8, u8)> = edits
            .iter()
            .filter(|(&(x, y, z), &(b, s))| (pristine.get(x, y, z), pristine.get_shape(x, y, z)) != (b, s))
            .map(|(&(x, y, z), &(b, s))| (x, y, z, b, s))
            .collect();
        list.sort_unstable();
        list.truncate(MAX_EDITS);
        let bag = bag.iter().filter(|(_, &n)| n > 0).map(|(k, &n)| (k.clone(), n)).collect();
        IslandSave { v: VERSION, seed, edits: list, bag, player: Some(player), hotbar: None }
    }

    /// Parse and check a saved file for the island `seed`. None: nothing usable (a fresh island).
    pub fn parse(text: &str, seed: f64) -> Option<IslandSave> {
        let mut s: IslandSave = serde_json::from_str(text).ok()?;
        if s.v != VERSION || s.seed != seed {
            return None;
        }
        s.edits.truncate(MAX_EDITS);
        s.edits.retain(|&(x, y, z, b, sh)| World::in_bounds(x, y, z) && valid_block(b) && sh <= craftyap_core::shapes::MAX_BLOCK_SHAPE);
        s.bag.retain(|k, n| def(k).is_some() && *n > 0);
        for n in s.bag.values_mut() {
            *n = (*n).min(MAX_COUNT);
        }
        if s.player.is_some_and(|p| p.iter().any(|v| !v.is_finite())) {
            s.player = None;
        }
        Some(s)
    }

    /// Write the edits into a freshly generated island; returns the edit map the app keeps.
    pub fn apply(&self, world: &mut World) -> HashMap<(i32, i32, i32), (u8, u8)> {
        let mut map = HashMap::with_capacity(self.edits.len());
        for &(x, y, z, b, sh) in &self.edits {
            if sh == 0 { world.set(x, y, z, b) } else { world.set_shaped(x, y, z, b, sh) }
            map.insert((x, y, z), (b, sh));
        }
        map
    }

    pub fn load(seed: f64) -> Option<IslandSave> {
        let text = std::fs::read_to_string(path()?).ok()?;
        let s = Self::parse(&text, seed);
        if s.is_none() {
            log::warn!("island: the save is unreadable or for another island; starting fresh");
        }
        s
    }

    /// Write it atomically (a crash mid-write keeps the old file). Failure is logged, not fatal.
    pub fn save(&self) {
        let Some(path) = path() else { return };
        let write = || -> std::io::Result<()> {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_string(self).unwrap_or_default())?;
            std::fs::rename(&tmp, &path)
        };
        match write() {
            Ok(()) => log::info!("island: saved ({} cells, {} in the bag)", self.edits.len(), self.bag.values().sum::<u32>()),
            Err(e) => log::warn!("island not saved: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use craftyap_core::world::generate_island;

    const SEED: f64 = 12345.0;

    #[test]
    fn a_save_round_trips_into_the_same_world() {
        let pristine = generate_island(SEED);
        let mut world = pristine.clone();
        let mut edits = HashMap::new();
        // a surface block mined, and air high above the ground built into (each surely a change)
        let top = craftyap_core::world::surface_y(&pristine, 40, 72);
        assert_ne!(pristine.get(40, top, 72), 0);
        for (x, y, z, b, s) in [(40, top, 72, 0u8, 0u8), (41, top + 6, 72, 1, craftyap_core::blocks_gen::KIT_CUBE), (39, top + 7, 72, craftyap_core::fluid::WATER, 0)] {
            if s == 0 { world.set(x, y, z, b) } else { world.set_shaped(x, y, z, b, s) }
            edits.insert((x, y, z), (b, s));
        }
        // a cell put back as it was is not an edit any more
        let (px, py, pz) = (5, 5, 5);
        edits.insert((px, py, pz), (pristine.get(px, py, pz), pristine.get_shape(px, py, pz)));
        let bag = HashMap::from([("stone".to_owned(), 3u32), ("dirt".to_owned(), 0)]);
        let save = IslandSave::diff(SEED, &pristine, &edits, &bag, [40.5, top as f64 + 1.0, 72.5, 3.1]);
        assert_eq!(save.edits.len(), 3, "the unchanged cell is left out");
        assert_eq!(save.bag, HashMap::from([("stone".to_owned(), 3)]), "empty piles are left out");
        let back = IslandSave::parse(&serde_json::to_string(&save).unwrap(), SEED).unwrap();
        assert_eq!(back, save);
        let mut fresh = generate_island(SEED);
        back.apply(&mut fresh);
        for &(x, y, z, b, s) in &save.edits {
            assert_eq!((fresh.get(x, y, z), fresh.get_shape(x, y, z)), (b, s));
            assert_eq!((world.get(x, y, z), world.get_shape(x, y, z)), (b, s));
        }
    }

    #[test]
    fn a_hostile_save_is_cleaned_cell_by_cell_never_trusted() {
        let text = r#"{"v":1,"seed":12345,"edits":[[40,20,40,1,0],[-1,0,0,1,0],[0,9999,0,1,0],[1,1,1,250,0],[2,2,2,1,255]],
            "bag":{"stone":99999,"no-such-block":5,"dirt":0},"player":[1,2,3,0.5]}"#;
        let s = IslandSave::parse(text, SEED).expect("the good parts survive");
        assert_eq!(s.edits, vec![(40, 20, 40, 1, 0)]);
        assert_eq!(s.bag, HashMap::from([("stone".to_owned(), MAX_COUNT)]));
        assert_eq!(s.player, Some([1.0, 2.0, 3.0, 0.5]));
        for bad in ["", "{", "null", "[1]", r#"{"v":2,"seed":12345,"edits":[],"bag":{},"player":null}"#, r#"{"v":1,"seed":7,"edits":[],"bag":{},"player":null}"#] {
            assert!(IslandSave::parse(bad, SEED).is_none(), "{bad}");
        }
    }
}
