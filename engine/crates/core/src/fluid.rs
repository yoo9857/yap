//! Minecraft-style water as a pure cellular automaton — a line-for-line port of
//! `packages/shared/src/fluid.ts`. The TypeScript version stays the reference until this one is
//! switched in; `engine/tools/parity-fluid` checks the two give the SAME changes in the SAME order,
//! step by step, on randomized worlds. Change both together, never one.
//!
//! Persisted ids (never renumber): 19 source, 20..26 flowing level 1..7, 27 falling, 28 settled.

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use std::collections::VecDeque;

pub const WATER: u8 = 19;
pub const WATER_FLOW_BASE: u8 = 19;
pub const WATER_FALLING: u8 = 27;
pub const WATER_SETTLED: u8 = 28;
pub const WATER_MAX_LEVEL: u8 = 7;

pub const FACE_PX: u8 = 1;
pub const FACE_NX: u8 = 2;
pub const FACE_PY: u8 = 4;
pub const FACE_NY: u8 = 8;
pub const FACE_PZ: u8 = 16;
pub const FACE_NZ: u8 = 32;

#[inline]
pub fn is_water(id: u8) -> bool {
    (WATER..=WATER_SETTLED).contains(&id)
}
#[inline]
fn reservoir(id: u8) -> bool {
    id == WATER || id == WATER_SETTLED
}
#[inline]
pub fn flowing_water(level: u8) -> u8 {
    WATER_FLOW_BASE + level
}
/// 0 for a source / falling / settled water, else the flowing level 1..7. Not water: 8.
#[inline]
pub fn water_level(id: u8) -> u8 {
    if reservoir(id) || id == WATER_FALLING {
        0
    } else if id > WATER && id < WATER_FALLING {
        id - WATER_FLOW_BASE
    } else {
        8
    }
}

/// The face bit toward a unit direction (exactly one of dx/dy/dz is ±1).
#[inline]
pub fn face_bit(dx: i32, dy: i32, dz: i32) -> u8 {
    if dx > 0 {
        FACE_PX
    } else if dx < 0 {
        FACE_NX
    } else if dy > 0 {
        FACE_PY
    } else if dy < 0 {
        FACE_NY
    } else if dz > 0 {
        FACE_PZ
    } else {
        FACE_NZ
    }
}

/// What the simulation reads and writes. Shaped blocks report the water they hold through
/// `get`/`set` and their walls through `seal` (see waterlog.ts).
pub trait FluidWorld {
    fn get(&self, x: i32, y: i32, z: i32) -> u8;
    fn open(&self, x: i32, y: i32, z: i32) -> bool;
    /// false: the write was refused (e.g. a full store) and is not a change.
    fn set(&mut self, x: i32, y: i32, z: i32, id: u8) -> bool;
    fn seal(&self, _x: i32, _y: i32, _z: i32) -> u8 {
        0
    }
}

pub type Cell = (i32, i32, i32);
pub type FluidChange = (i32, i32, i32, u8);

const N4: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];
const N6: [(i32, i32, i32); 7] = [(0, 0, 0), (1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)];

/// Pending cells in insertion order (the JS `Set` semantics the reference relies on: re-adding a
/// present cell keeps its place, a removed one goes to the back).
pub struct FluidSim {
    queue: VecDeque<Cell>,
    pending: HashSet<Cell>,
    budget: usize,
}

impl Default for FluidSim {
    fn default() -> Self {
        Self::new(4096)
    }
}

impl FluidSim {
    pub fn new(budget: usize) -> Self {
        Self { queue: VecDeque::new(), pending: HashSet::default(), budget }
    }
    pub fn busy(&self) -> bool {
        !self.pending.is_empty()
    }
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
    pub fn touch(&mut self, x: i32, y: i32, z: i32) {
        for (dx, dy, dz) in N6 {
            let c = (x + dx, y + dy, z + dz);
            if self.pending.insert(c) {
                self.queue.push_back(c);
            }
        }
    }
    pub fn clear(&mut self) {
        self.queue.clear();
        self.pending.clear();
    }

    /// One synchronous step: read everything, then write. Returns the committed changes.
    pub fn step<W: FluidWorld>(&mut self, world: &mut W) -> Vec<FluidChange> {
        self.step_timed(world, f64::INFINITY, || 0.0)
    }

    /// `step` with the reference's soft time budget: like fluid.ts `step(world, maxMs)`, it checks
    /// the clock every 8 evaluated cells and stops reading once `max_ms` has passed (the rest wait
    /// for the next step). The clock is passed in, so the core stays free of any platform.
    pub fn step_timed<W: FluidWorld>(&mut self, world: &mut W, max_ms: f64, clock: impl Fn() -> f64) -> Vec<FluidChange> {
        let timed = max_ms.is_finite();
        let start = if timed { clock() } else { 0.0 };
        let mut changes = Vec::new();
        let mut basins: HashMap<Cell, bool> = HashMap::default();
        let mut evaluated = 0;
        while let Some(c) = self.queue.pop_front() {
            self.pending.remove(&c);
            let (x, y, z) = c;
            let now = world.get(x, y, z);
            let next = next_state(world, x, y, z, now, &mut basins);
            if next != now {
                changes.push((x, y, z, next));
            }
            evaluated += 1;
            if evaluated >= self.budget || (timed && evaluated % 8 == 0 && clock() - start >= max_ms) {
                break;
            }
        }
        let mut committed = Vec::with_capacity(changes.len());
        for ch in changes {
            let (x, y, z, id) = ch;
            if !world.set(x, y, z, id) {
                continue;
            }
            committed.push(ch);
            self.touch(x, y, z);
        }
        committed
    }
}

#[inline]
fn passes<W: FluidWorld>(w: &W, x: i32, y: i32, z: i32, dx: i32, dy: i32, dz: i32) -> bool {
    (w.seal(x, y, z) & face_bit(dx, dy, dz)) == 0 && (w.seal(x + dx, y + dy, z + dz) & face_bit(-dx, -dy, -dz)) == 0
}
#[inline]
fn holds<W: FluidWorld>(w: &W, x: i32, y: i32, z: i32) -> bool {
    let id = w.get(x, y, z);
    (id == 0 || is_water(id)) && w.open(x, y, z)
}
#[inline]
fn falls<W: FluidWorld>(w: &W, x: i32, y: i32, z: i32) -> bool {
    holds(w, x, y - 1, z) && passes(w, x, y, z, 0, -1, 0)
}
#[inline]
fn on_reservoir<W: FluidWorld>(w: &W, x: i32, y: i32, z: i32) -> bool {
    reservoir(w.get(x, y - 1, z)) && passes(w, x, y, z, 0, -1, 0)
}
fn spreads_sideways<W: FluidWorld>(w: &W, x: i32, y: i32, z: i32) -> bool {
    let pool = on_reservoir(w, x, y, z);
    if pool && w.get(x, y, z) == WATER_FALLING {
        return false;
    }
    pool || !falls(w, x, y, z)
}

fn settled_basin<W: FluidWorld>(w: &W, x: i32, y: i32, z: i32, memo: &mut HashMap<Cell, bool>) -> bool {
    if let Some(&cached) = memo.get(&(x, y, z)) {
        return cached;
    }
    let mut cells: Vec<(i32, i32)> = vec![(x, z)];
    let mut seen: HashSet<(i32, i32)> = HashSet::default();
    seen.insert((x, z));
    let (mut contained, mut fed) = (true, false);
    let mut i = 0;
    while i < cells.len() {
        let (cx, cz) = cells[i];
        if !on_reservoir(w, cx, y, cz) && falls(w, cx, y, cz) {
            contained = false;
        }
        fed = fed || reservoir(w.get(cx, y, cz)) || (is_water(w.get(cx, y + 1, cz)) && passes(w, cx, y, cz, 0, 1, 0));
        for (dx, dz) in N4 {
            let (nx, nz) = (cx + dx, cz + dz);
            if seen.contains(&(nx, nz)) || !holds(w, nx, y, nz) || !passes(w, cx, y, cz, dx, 0, dz) {
                continue;
            }
            seen.insert((nx, nz));
            cells.push((nx, nz));
        }
        if cells.len() > 256 {
            contained = false;
            break;
        }
        i += 1;
    }
    let result = contained && fed;
    for (cx, cz) in cells {
        memo.insert((cx, y, cz), result);
    }
    result
}

/// What this cell should hold next step.
pub fn next_state<W: FluidWorld>(w: &W, x: i32, y: i32, z: i32, now: u8, basins: &mut HashMap<Cell, bool>) -> u8 {
    if !(now == 0 || is_water(now)) {
        return now;
    }
    if !w.open(x, y, z) {
        return 0;
    }
    if now == WATER {
        return WATER;
    }
    let mut sources = 0;
    let mut best = 8u8;
    for (dx, dz) in N4 {
        let id = w.get(x + dx, y, z + dz);
        if !is_water(id) || !passes(w, x, y, z, dx, 0, dz) {
            continue;
        }
        if id == WATER {
            sources += 1;
        }
        if !spreads_sideways(w, x + dx, y, z + dz) {
            continue;
        }
        best = best.min(water_level(id));
    }
    let fall = falls(w, x, y, z);
    let pool = on_reservoir(w, x, y, z);
    if sources >= 2 && ((pool && w.get(x, y - 1, z) == WATER) || !fall) {
        return WATER;
    }
    if (is_water(now) || pool || best <= WATER_MAX_LEVEL) && (pool || !fall) && settled_basin(w, x, y, z, basins) {
        return WATER_SETTLED;
    }
    if is_water(w.get(x, y + 1, z)) && passes(w, x, y, z, 0, 1, 0) {
        return WATER_FALLING;
    }
    if best < WATER_MAX_LEVEL {
        flowing_water(best + 1)
    } else {
        0
    }
}

/// A sparse test/benchmark world: a solid floor at y <= floor_y, open air above up to max_y within
/// ±half_size, and cells that may be shaped (holding water in a side layer behind `seal` walls).
pub struct SparseWorld {
    pub floor_y: i32,
    pub max_y: i32,
    pub half_size: i32,
    pub floor_block: u8,
    cells: HashMap<Cell, SparseCell>,
}

#[derive(Clone, Copy, Default)]
struct SparseCell {
    block: u8,
    /// Non-zero: a shaped block, with these sealed faces; its water lives in `wet`.
    seal: u8,
    shaped: bool,
    wet: u8,
}

impl SparseWorld {
    pub fn new(floor_y: i32, max_y: i32, half_size: i32, floor_block: u8) -> Self {
        Self { floor_y, max_y, half_size, floor_block, cells: HashMap::default() }
    }
    /// Place a block (0 = air). `shaped` + `seal`: a shaped block holding water behind those walls.
    pub fn put(&mut self, x: i32, y: i32, z: i32, block: u8, shaped: bool, seal: u8) {
        if block == 0 {
            self.cells.remove(&(x, y, z));
        } else {
            self.cells.insert((x, y, z), SparseCell { block, seal, shaped, wet: 0 });
        }
    }
    /// The water in a cell, whichever layer holds it.
    pub fn water(&self, x: i32, y: i32, z: i32) -> u8 {
        match self.cells.get(&(x, y, z)) {
            Some(c) if c.shaped => c.wet,
            Some(c) if is_water(c.block) => c.block,
            _ => 0,
        }
    }
    pub fn len(&self) -> usize {
        self.cells.len()
    }
    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }
}

impl FluidWorld for SparseWorld {
    fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        if y <= self.floor_y {
            return self.floor_block;
        }
        match self.cells.get(&(x, y, z)) {
            Some(c) if c.shaped => c.wet,
            Some(c) => c.block,
            None => 0,
        }
    }
    fn open(&self, x: i32, y: i32, z: i32) -> bool {
        y > self.floor_y && y < self.max_y && x.abs() <= self.half_size && z.abs() <= self.half_size
    }
    fn set(&mut self, x: i32, y: i32, z: i32, id: u8) -> bool {
        match self.cells.get_mut(&(x, y, z)) {
            Some(c) if c.shaped => {
                c.wet = id;
            }
            _ if id == 0 => {
                self.cells.remove(&(x, y, z));
            }
            _ => {
                self.cells.insert((x, y, z), SparseCell { block: id, ..Default::default() });
            }
        }
        true
    }
    fn seal(&self, x: i32, y: i32, z: i32) -> u8 {
        match self.cells.get(&(x, y, z)) {
            Some(c) if c.shaped => c.seal,
            _ => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settle(w: &mut SparseWorld, sim: &mut FluidSim) -> usize {
        let mut steps = 0;
        while sim.busy() && steps < 400 {
            sim.step(w);
            steps += 1;
        }
        steps
    }

    #[test]
    fn a_source_spreads_seven_cells_one_level_weaker_each() {
        let mut w = SparseWorld::new(0, 20, 32, 1);
        let mut sim = FluidSim::default();
        w.set(0, 1, 0, WATER);
        sim.touch(0, 1, 0);
        assert!(settle(&mut w, &mut sim) < 400);
        for d in 1..=7 {
            assert_eq!(w.get(d, 1, 0), flowing_water(d as u8), "x={d}");
        }
        assert_eq!(w.get(8, 1, 0), 0);
        // a centred diamond of radius 7
        assert_eq!(w.len(), 1 + 2 * 7 * 8);
    }

    #[test]
    fn cutting_the_source_drains_the_stream() {
        let mut w = SparseWorld::new(0, 20, 32, 1);
        let mut sim = FluidSim::default();
        w.set(0, 1, 0, WATER);
        sim.touch(0, 1, 0);
        settle(&mut w, &mut sim);
        w.set(0, 1, 0, 0);
        sim.touch(0, 1, 0);
        settle(&mut w, &mut sim);
        assert!(w.is_empty());
    }

    #[test]
    fn a_ramp_back_stops_water_and_its_open_side_lets_it_in() {
        // the ramp's back faces the source (−z): sealed
        let mut w = SparseWorld::new(0, 12, 24, 1);
        for x in [-1, 1] {
            for z in [1, 2] {
                w.put(x, 1, z, 1, false, 0);
            }
        }
        w.put(0, 1, 1, 1, true, FACE_NY | FACE_NZ);
        let mut sim = FluidSim::default();
        w.set(0, 1, 0, WATER);
        sim.touch(0, 1, 0);
        settle(&mut w, &mut sim);
        assert_eq!(w.water(0, 1, 1), 0);
        // turned round (back = +z): water enters, and the back keeps it from passing on
        let mut v = SparseWorld::new(0, 12, 24, 1);
        for x in [-1, 1] {
            for z in [1, 2] {
                v.put(x, 1, z, 1, false, 0);
            }
        }
        v.put(0, 1, 1, 1, true, FACE_NY | FACE_PZ);
        let mut sim = FluidSim::default();
        v.set(0, 1, 0, WATER);
        sim.touch(0, 1, 0);
        settle(&mut v, &mut sim);
        assert_eq!(v.water(0, 1, 1), flowing_water(1));
        assert_eq!(v.water(0, 1, 2), 0);
    }
}
