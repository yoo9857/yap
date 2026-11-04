//! The game's voxel window, mirrored in Rust so the water simulation runs on the real world.
//! A port of what `apps/client/src/craft/waterSim.ts` reads through `VoxelWorld` + `FieldWindow`
//! (the TS side stays the reference; `apps/client/test/rust-water.test.ts` checks the two agree).
//!
//! - The window is `sx × sy × sz` cells at absolute origin (origin_x, 0, origin_z); index
//!   `(y * sz + z) * sx + x`, like `VoxelWorld.index`.
//! - A shaped block holds its water in `wet` (waterlog.ts). Which shapes hold water, and the faces
//!   they seal, come from TypeScript's `shapeSeal` as a table, so both sides use the same geometry.
//! - Outside the window: the field's banked cells in the ring right outside it (`edge`, the only
//!   cells the simulation reads there), else the field column; an island has open air outside.

use crate::fluid::{is_water, FluidWorld};
use rustc_hash::{FxHashMap, FxHashSet};

/// `seal_table[shape]`: sealed faces of a shape that holds water, or NOT_WATERLOGGED.
pub const NOT_WATERLOGGED: u8 = 255;

pub struct Grid {
    pub sx: i32,
    pub sy: i32,
    pub sz: i32,
    pub cells: Vec<u8>,
    pub shapes: Vec<u8>,
    pub wet: Vec<u8>,
    /// The field's column (block per height) outside the window; empty for an island.
    outside: Vec<u8>,
    pub origin_x: i32,
    pub origin_z: i32,
    /// Banked (block, shape, wet) of field cells in the ring outside the window, absolute coords.
    edge: FxHashMap<(i32, i32, i32), (u8, u8, u8)>,
    /// Absolute cells filled by solid furniture (water cannot be there).
    props: FxHashSet<(i32, i32, i32)>,
    seal_table: [u8; 256],
}

impl Grid {
    pub fn new(sx: i32, sy: i32, sz: i32, seal_table: &[u8]) -> Self {
        let n = (sx * sy * sz) as usize;
        let mut table = [NOT_WATERLOGGED; 256];
        for (i, s) in seal_table.iter().take(256).enumerate() {
            table[i] = *s;
        }
        Self {
            sx,
            sy,
            sz,
            cells: vec![0; n],
            shapes: vec![0; n],
            wet: vec![0; n],
            outside: Vec::new(),
            origin_x: 0,
            origin_z: 0,
            edge: FxHashMap::default(),
            props: FxHashSet::default(),
            seal_table: table,
        }
    }

    /// Replace the whole window (start, a field scroll, a loaded save).
    pub fn load(&mut self, cells: &[u8], shapes: &[u8], wet: &[u8], outside: &[u8], origin_x: i32, origin_z: i32) {
        self.cells.copy_from_slice(cells);
        self.shapes.copy_from_slice(shapes);
        self.wet.copy_from_slice(wet);
        self.outside = outside.to_vec();
        self.origin_x = origin_x;
        self.origin_z = origin_z;
        self.edge.clear();
    }

    /// One cell of the window changed in TypeScript (an edit, a classmate, sand).
    pub fn write(&mut self, i: usize, block: u8, shape: u8, wet: u8) {
        if i < self.cells.len() {
            self.cells[i] = block;
            self.shapes[i] = shape;
            self.wet[i] = wet;
        }
    }

    pub fn set_edge(&mut self, ax: i32, y: i32, az: i32, block: u8, shape: u8, wet: u8) {
        self.edge.insert((ax, y, az), (block, shape, wet));
    }

    pub fn set_props(&mut self, cells: impl IntoIterator<Item = (i32, i32, i32)>) {
        self.props.clear();
        self.props.extend(cells);
    }

    #[inline]
    fn in_bounds(&self, x: i32, y: i32, z: i32) -> bool {
        x >= 0 && x < self.sx && y >= 0 && y < self.sy && z >= 0 && z < self.sz
    }
    #[inline]
    pub fn index(&self, x: i32, y: i32, z: i32) -> usize {
        ((y * self.sz + z) * self.sx + x) as usize
    }
    #[inline]
    fn holds_waterlog(&self, block: u8, shape: u8) -> bool {
        block != 0 && !is_water(block) && self.seal_table[shape as usize] != NOT_WATERLOGGED
    }

    /// (block, shape, wet) of an absolute cell: the window, the banked ring, else the column.
    #[inline]
    fn cell(&self, ax: i32, y: i32, az: i32) -> (u8, u8, u8) {
        let (x, z) = (ax - self.origin_x, az - self.origin_z);
        if self.in_bounds(x, y, z) {
            let i = self.index(x, y, z);
            return (self.cells[i], self.shapes[i], self.wet[i]);
        }
        if self.outside.is_empty() || y < 0 || y >= self.sy {
            return (0, 0, 0);
        }
        self.edge.get(&(ax, y, az)).copied().unwrap_or((self.outside[y as usize], 0, 0))
    }
}

impl FluidWorld for Grid {
    fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        let (block, shape, wet) = self.cell(x, y, z);
        if self.holds_waterlog(block, shape) {
            wet
        } else {
            block
        }
    }
    fn open(&self, x: i32, y: i32, z: i32) -> bool {
        self.in_bounds(x - self.origin_x, y, z - self.origin_z) && !self.props.contains(&(x, y, z))
    }
    fn set(&mut self, x: i32, y: i32, z: i32, id: u8) -> bool {
        let (gx, gz) = (x - self.origin_x, z - self.origin_z);
        if !self.in_bounds(gx, y, gz) {
            return false;
        }
        let i = self.index(gx, y, gz);
        if self.holds_waterlog(self.cells[i], self.shapes[i]) {
            self.wet[i] = id;
        } else {
            self.cells[i] = id;
            self.shapes[i] = 0;
            self.wet[i] = 0;
        }
        true
    }
    fn seal(&self, x: i32, y: i32, z: i32) -> u8 {
        let (block, shape, _) = self.cell(x, y, z);
        if self.holds_waterlog(block, shape) {
            self.seal_table[shape as usize]
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fluid::{flowing_water, FluidSim, WATER};

    fn island(n: i32) -> Grid {
        let mut table = [NOT_WATERLOGGED; 256];
        table[51] = crate::fluid::FACE_NY; // a half block
        let mut g = Grid::new(n, 8, n, &table);
        for x in 0..n {
            for z in 0..n {
                let i = g.index(x, 0, z);
                g.cells[i] = 1;
            }
        }
        g
    }

    #[test]
    fn water_spreads_on_the_grid_and_stops_at_its_edge() {
        // 24×24 > 256 cells: open ground, not a basin (a smaller window is walled by its edge)
        let mut g = island(24);
        let mut sim = FluidSim::default();
        g.set(1, 1, 5, WATER);
        sim.touch(1, 1, 5);
        while sim.busy() {
            sim.step(&mut g);
        }
        assert_eq!(g.get(4, 1, 5), flowing_water(3));
        assert_eq!(g.get(8, 1, 5), flowing_water(7));
        assert_eq!(g.get(9, 1, 5), 0);
        assert_eq!(g.get(-1, 1, 5), 0); // outside the island: air, never written
        assert!(!g.set(-1, 1, 5, WATER)); // and refused
    }

    #[test]
    fn a_half_block_takes_water_in_its_side_layer_and_keeps_its_block() {
        let mut g = island(24);
        let i = g.index(2, 1, 5);
        g.cells[i] = 3;
        g.shapes[i] = 51;
        let mut sim = FluidSim::default();
        g.set(1, 1, 5, WATER);
        sim.touch(1, 1, 5);
        while sim.busy() {
            sim.step(&mut g);
        }
        assert_eq!((g.cells[i], g.shapes[i], g.wet[i]), (3, 51, flowing_water(1)));
        assert_eq!(g.get(3, 1, 5), flowing_water(2)); // and on through it
    }

    #[test]
    fn furniture_cells_hold_no_water() {
        let mut g = island(24);
        g.set_props([(2, 1, 5)]);
        let mut sim = FluidSim::default();
        g.set(1, 1, 5, WATER);
        sim.touch(1, 1, 5);
        while sim.busy() {
            sim.step(&mut g);
        }
        assert_eq!(g.get(2, 1, 5), 0);
    }
}
