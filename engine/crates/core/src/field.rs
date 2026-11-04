//! A classroom's shared field, mirrored in Rust so the server's water runs on the Rust core.
//! A port of `ClassRoom.fluidWorld` (apps/server/src/classroom/classRoom.ts — the reference until
//! it is switched; `apps/server/test/rust-class-water.test.ts` runs both and compares every message).
//!
//! The field is the flat column (`column[y]`, air above) plus a sparse edit diff, bounded to
//! |x|, |z| <= max_coord and 1 <= y <= max_y. A full store (`max_edits`) takes no NEW cells, water
//! included; the first refusal raises `at_capacity` so the server rescans once space frees up.

use crate::fluid::{is_water, FluidWorld};
use crate::grid::NOT_WATERLOGGED;
use rustc_hash::{FxHashMap, FxHashSet};
use std::cell::Cell as Flag;

type Key = (i32, i32, i32);

pub struct FieldWorld {
    column: Vec<u8>,
    max_coord: i32,
    max_y: i32,
    max_edits: usize,
    /// (block, shape) of every cell that differs from the column.
    edits: FxHashMap<Key, (u8, u8)>,
    /// Water held inside shaped blocks (flow state, never saved).
    wet: FxHashMap<Key, u8>,
    props: FxHashSet<Key>,
    seal_table: [u8; 256],
    at_capacity: Flag<bool>,
}

impl FieldWorld {
    pub fn new(column: &[u8], max_coord: i32, max_y: i32, max_edits: usize, seal_table: &[u8]) -> Self {
        let mut table = [NOT_WATERLOGGED; 256];
        for (i, s) in seal_table.iter().take(256).enumerate() {
            table[i] = *s;
        }
        Self {
            column: column.to_vec(),
            max_coord,
            max_y,
            max_edits,
            edits: FxHashMap::default(),
            wet: FxHashMap::default(),
            props: FxHashSet::default(),
            seal_table: table,
            at_capacity: Flag::new(false),
        }
    }

    #[inline]
    fn pristine(&self, y: i32) -> u8 {
        if y >= 0 && (y as usize) < self.column.len() {
            self.column[y as usize]
        } else {
            0
        }
    }
    #[inline]
    fn holds_waterlog(&self, block: u8, shape: u8) -> bool {
        block != 0 && !is_water(block) && self.seal_table[shape as usize] != NOT_WATERLOGGED
    }
    fn has_capacity(&self) -> bool {
        if self.edits.len() < self.max_edits {
            return true;
        }
        self.at_capacity.set(true);
        false
    }

    /// The server wrote a cell (`ClassRoom.writeEdit`): `None` = back to the plain field. A written
    /// cell holds no water until the flow fills it again.
    pub fn write(&mut self, key: Key, value: Option<(u8, u8)>) {
        self.wet.remove(&key);
        match value {
            Some(v) => {
                self.edits.insert(key, v);
            }
            None => {
                self.edits.remove(&key);
            }
        }
    }
    /// Room for `n` more edits up front (a restored class), so the bulk load does not rehash.
    pub fn reserve(&mut self, n: usize) {
        self.edits.reserve(n);
    }
    pub fn reset(&mut self) {
        self.edits.clear();
        self.wet.clear();
    }
    pub fn set_props(&mut self, cells: impl IntoIterator<Item = Key>) {
        self.props.clear();
        self.props.extend(cells);
    }
    /// Did a step meet a full store? (cleared by reading)
    pub fn take_at_capacity(&self) -> bool {
        self.at_capacity.replace(false)
    }
    pub fn edit_count(&self) -> usize {
        self.edits.len()
    }
    pub fn wet_at(&self, key: Key) -> u8 {
        self.wet.get(&key).copied().unwrap_or(0)
    }
}

impl FluidWorld for FieldWorld {
    fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        match self.edits.get(&(x, y, z)) {
            None => self.pristine(y),
            Some(&(block, shape)) if self.holds_waterlog(block, shape) => self.wet_at((x, y, z)),
            Some(&(block, _)) => block,
        }
    }
    fn open(&self, x: i32, y: i32, z: i32) -> bool {
        x.abs() <= self.max_coord
            && z.abs() <= self.max_coord
            && y >= 1
            && y <= self.max_y
            && !self.props.contains(&(x, y, z))
            && (self.edits.contains_key(&(x, y, z)) || self.has_capacity())
    }
    fn set(&mut self, x: i32, y: i32, z: i32, id: u8) -> bool {
        let key = (x, y, z);
        if let Some(&(block, shape)) = self.edits.get(&key) {
            if self.holds_waterlog(block, shape) {
                if id != 0 {
                    self.wet.insert(key, id);
                } else {
                    self.wet.remove(&key);
                }
                return true;
            }
        }
        let pristine = self.pristine(y);
        if id != pristine && !self.edits.contains_key(&key) && !self.has_capacity() {
            return false;
        }
        self.write(key, if id == pristine { None } else { Some((id, 0)) });
        true
    }
    fn seal(&self, x: i32, y: i32, z: i32) -> u8 {
        match self.edits.get(&(x, y, z)) {
            Some(&(block, shape)) if self.holds_waterlog(block, shape) => self.seal_table[shape as usize],
            _ => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fluid::{flowing_water, FluidSim, FACE_NY, WATER};

    fn field(max_edits: usize) -> FieldWorld {
        let mut table = [NOT_WATERLOGGED; 256];
        table[51] = FACE_NY;
        FieldWorld::new(&[11, 2, 2, 1], 1_000_000, 55, max_edits, &table)
    }
    fn settle(w: &mut FieldWorld, sim: &mut FluidSim) {
        for _ in 0..200 {
            if !sim.busy() {
                break;
            }
            sim.step(w);
        }
    }

    #[test]
    fn a_source_on_the_grass_spreads_seven_cells() {
        let mut w = field(300_000);
        let mut sim = FluidSim::default();
        w.write((0, 4, 0), Some((WATER, 0)));
        sim.touch(0, 4, 0);
        settle(&mut w, &mut sim);
        assert_eq!(w.get(3, 4, 0), flowing_water(3));
        assert_eq!(w.get(8, 4, 0), 0);
        assert_eq!(w.edit_count(), 1 + 2 * 7 * 8);
    }

    #[test]
    fn a_full_store_takes_no_new_water_and_says_so() {
        let mut w = field(3);
        w.write((100, 4, 100), Some((3, 0)));
        w.write((101, 4, 100), Some((3, 0)));
        w.write((0, 4, 0), Some((WATER, 0)));
        let mut sim = FluidSim::default();
        sim.touch(0, 4, 0);
        settle(&mut w, &mut sim);
        assert_eq!(w.edit_count(), 3);
        assert_eq!(w.get(1, 4, 0), 0);
        assert!(w.take_at_capacity());
        assert!(!w.take_at_capacity());
    }

    #[test]
    fn a_half_block_holds_water_beside_its_block() {
        let mut w = field(300_000);
        w.write((1, 4, 0), Some((3, 51)));
        w.write((0, 4, 0), Some((WATER, 0)));
        let mut sim = FluidSim::default();
        sim.touch(0, 4, 0);
        settle(&mut w, &mut sim);
        assert_eq!(w.wet_at((1, 4, 0)), flowing_water(1));
        assert_eq!(w.get(2, 4, 0), flowing_water(2));
        w.write((1, 4, 0), Some((3, 51))); // written again: dry until the flow fills it
        assert_eq!(w.wet_at((1, 4, 0)), 0);
    }
}
