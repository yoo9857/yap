//! The voxel world and its generation: a line-for-line port of `apps/client/src/craft/voxelWorld.ts`
//! (`VoxelWorld` storage, `generateIsland`, `expandMainland`, `stampHogwartsCastle`, `surfaceY`).
//! The TypeScript stays the reference: `apps/client/test/rust-world.test.ts` requires the SAME
//! cells for several seeds. Numbers follow JavaScript exactly (`hash2` multiplies past 2^53 in f64
//! and truncates with ToInt32, `Math.round` rounds halves up, `Math.hypot` is V8's).

use crate::blocks_gen::{BLOCKS, SOLID};
use crate::earcut::to_int32;
use crate::kit::js_hypot;

pub const WORLD_X: i32 = 160;
pub const WORLD_Y: i32 = 56;
pub const WORLD_Z: i32 = 160;
pub const AIR: u8 = 0;

/// A catalog id by key (panics on a typo: generation only uses keys that exist, and the
/// generated catalog is checked against blocks.ts in CI).
pub fn id(key: &str) -> u8 {
    BLOCKS.iter().find(|b| b.key == key).unwrap_or_else(|| panic!("no block {key}")).id
}

pub struct World {
    pub cells: Vec<u8>,
    pub shapes: Vec<u8>,
    /// Block id per height for every column outside the grid (the endless field), or None (air).
    pub outside_column: Option<Vec<u8>>,
}

impl Default for World {
    fn default() -> Self {
        let n = (WORLD_X * WORLD_Y * WORLD_Z) as usize;
        Self { cells: vec![0; n], shapes: vec![0; n], outside_column: None }
    }
}

impl World {
    #[inline]
    pub fn in_bounds(x: i32, y: i32, z: i32) -> bool {
        (0..WORLD_X).contains(&x) && (0..WORLD_Y).contains(&y) && (0..WORLD_Z).contains(&z)
    }
    #[inline]
    pub fn index(x: i32, y: i32, z: i32) -> usize {
        ((y * WORLD_Z + z) * WORLD_X + x) as usize
    }
    pub fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        if Self::in_bounds(x, y, z) {
            return self.cells[Self::index(x, y, z)];
        }
        match &self.outside_column {
            Some(col) if (0..WORLD_Y).contains(&y) => col.get(y as usize).copied().unwrap_or(AIR),
            _ => AIR,
        }
    }
    /// A plain cube (or air): clears the cell's shape, like `VoxelWorld.set`.
    pub fn set(&mut self, x: i32, y: i32, z: i32, block: u8) {
        if Self::in_bounds(x, y, z) {
            let i = Self::index(x, y, z);
            self.cells[i] = block;
            self.shapes[i] = 0;
        }
    }
    pub fn get_shape(&self, x: i32, y: i32, z: i32) -> u8 {
        if Self::in_bounds(x, y, z) {
            self.shapes[Self::index(x, y, z)]
        } else {
            0
        }
    }
    pub fn is_solid(&self, x: i32, y: i32, z: i32) -> bool {
        SOLID[self.get(x, y, z) as usize]
    }
}

/// `surfaceY`: the highest solid cell at (x, z), or 0.
pub fn surface_y(world: &World, x: i32, z: i32) -> i32 {
    for y in (0..WORLD_Y).rev() {
        if world.is_solid(x, y, z) {
            return y;
        }
    }
    0
}

/// `hash2`: deterministic 2D hash → [0, 1).
fn hash2(x: f64, z: f64, seed: f64) -> f64 {
    let mut h = to_int32(x * 374761393.0 + z * 668265263.0 + seed * 2246822519.0);
    h = (h ^ ((h as u32) >> 13) as i32).wrapping_mul(1274126177);
    ((h ^ ((h as u32) >> 16) as i32) as u32) as f64 / 4294967296.0
}

fn smooth(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

/// `noise2`: value noise on a 6-cell lattice.
fn noise2(x: f64, z: f64, seed: f64) -> f64 {
    let gx = (x / 6.0).floor();
    let gz = (z / 6.0).floor();
    let fx = smooth((x - gx * 6.0) / 6.0);
    let fz = smooth((z - gz * 6.0) / 6.0);
    let a = hash2(gx, gz, seed);
    let b = hash2(gx + 1.0, gz, seed);
    let c = hash2(gx, gz + 1.0, seed);
    let d = hash2(gx + 1.0, gz + 1.0, seed);
    a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}

/// `Math.round`: the nearest integer, halves toward +∞.
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

#[allow(clippy::too_many_arguments)] // the TypeScript box(x0, x1, z0, z1, y0, y1, block), kept as is
fn boxed(world: &mut World, x0: i32, x1: i32, z0: i32, z1: i32, y0: i32, y1: i32, block: u8) {
    // the TypeScript nests x, z, y in the castle and y, z, x in the mainland; the result is the
    // same for a fill, so one order serves both
    for x in x0..=x1 {
        for z in z0..=z1 {
            for y in y0..=y1 {
                world.set(x, y, z, block);
            }
        }
    }
}

/// `generateIsland(seed)`: pure function of the seed.
pub fn generate_island(seed: f64) -> World {
    const W: i32 = 80; // the original district keeps its old coordinates (older saves edit it)
    let mut world = World::default();
    let (grass, dirt, stone, sand, bedrock) = (id("grass"), id("dirt"), id("stone"), id("sand"), id("bedrock"));
    let gold_ore = id("gold-ore");
    let ores = [(id("coal-ore"), 0.055), (id("iron-ore"), 0.03), (gold_ore, 0.014), (id("diamond-ore"), 0.007)];
    let cx = (W as f64 - 1.0) / 2.0;
    let cz = (W as f64 - 1.0) / 2.0;
    let ore_seed = (to_int32(seed) ^ to_int32(2654435769.0)) as f64; // seed ^ 0x9e3779b9
    for x in 0..W {
        for z in 0..W {
            let dist = js_hypot(x as f64 - cx, z as f64 - cz) / (W as f64 / 2.0);
            let falloff = f64::max(0.0, 1.0 - dist * dist * 1.15);
            let h = js_round((5.0 + noise2(x as f64, z as f64, seed) * 7.0) * falloff) as i32 + 3;
            for y in 0..h {
                let cell = if y == 0 {
                    bedrock
                } else if y == h - 1 {
                    if h <= 6 { sand } else { grass }
                } else if y >= h - 4 {
                    if h <= 6 { sand } else { dirt }
                } else {
                    let mut cell = stone;
                    let roll = hash2((x * 7 + y * 131) as f64, (z * 13 + y) as f64, ore_seed);
                    for &(ore, p) in &ores {
                        let deep_enough = ore < gold_ore || y <= 6;
                        if deep_enough && roll < p {
                            cell = ore;
                            break;
                        }
                    }
                    cell
                };
                world.set(x, y, z, cell);
            }
        }
    }

    // a few oak trees on high grass
    let (log, leaves) = (id("oak-log"), id("oak-leaves"));
    let mut planted = 0;
    let mut attempt = 0;
    while attempt < 220 && planted < 6 {
        let a = attempt as f64;
        let x = 6 + (hash2(a, 17.0, seed) * (W - 12) as f64).floor() as i32;
        let z = 6 + (hash2(a, 91.0, seed) * (W - 12) as f64).floor() as i32;
        attempt += 1;
        let mut top = -1;
        for y in (0..WORLD_Y).rev() {
            if world.is_solid(x, y, z) {
                top = y;
                break;
            }
        }
        if top < 6 || world.get(x, top, z) != grass {
            continue;
        }
        let height = 4 + (hash2(a, 3.0, seed) * 2.0).floor() as i32;
        for y in 1..=height {
            world.set(x, top + y, z, log);
        }
        for ly in height - 1..=height + 1 {
            let r: i32 = if ly == height + 1 { 1 } else { 2 };
            for ox in -r..=r {
                for oz in -r..=r {
                    if ox == 0 && oz == 0 && ly <= height {
                        continue;
                    }
                    if ox.abs() == r && oz.abs() == r && r == 2 {
                        continue;
                    }
                    if !world.is_solid(x + ox, top + ly, z + oz) {
                        world.set(x + ox, top + ly, z + oz, leaves);
                    }
                }
            }
        }
        planted += 1;
    }

    stamp_castle(&mut world);
    expand_mainland(&mut world, seed);
    world
}

/// `expandMainland`: meadows, wooded ridges and the industrial town around the old island.
fn expand_mainland(world: &mut World, seed: f64) {
    let (grass, stone, dirt) = (id("grass"), id("stone"), id("dirt"));
    let (brick, iron, glass, lamp, plank) = (id("stone-bricks"), id("iron-block"), id("glass"), id("glowstone"), id("oak-planks"));
    for z in 0..WORLD_Z {
        for x in 0..WORLD_X {
            if x < 80 && z < 80 {
                continue;
            }
            let (fx, fz) = (x as f64, z as f64);
            let distance = i32::max(x - 79, z - 79) as f64;
            let blend = smooth(f64::min(1.0, distance / 24.0));
            let ridge = f64::max(0.0, 1.0 - js_hypot(fx - 125.0, fz - 25.0) / 38.0);
            let rolling = 10.0 + noise2(fx / 3.0, fz / 3.0, seed) * 5.0 + ridge * 13.0;
            let edge = x.min(z).min(WORLD_X - 1 - x).min(WORLD_Z - 1 - z);
            let mut top = js_round((2.0 + (rolling - 2.0) * blend) * f64::min(1.0, (edge as f64 + 4.0) / 12.0)) as i32;
            let town_distance = (100 - x).max(x - 148).max(66 - z).max(z - 116).max(0) as f64;
            let town_blend = smooth(f64::max(0.0, 1.0 - town_distance / 14.0));
            top = js_round(top as f64 + (12.0 - top as f64) * town_blend) as i32;
            for y in 0..=top {
                let mut block = if y == 0 {
                    id("bedrock")
                } else if y == top {
                    if edge < 4 { id("sand") } else { grass }
                } else if y > top - 4 {
                    dirt
                } else {
                    stone
                };
                if block == stone {
                    let ore = hash2((x + y * 131) as f64, (z - y * 17) as f64, seed);
                    if ore < 0.008 && y < 5 {
                        block = id("diamond-ore");
                    } else if ore < 0.02 && y < 7 {
                        block = id("gold-ore");
                    } else if ore < 0.05 {
                        block = id("iron-ore");
                    } else if ore < 0.09 {
                        block = id("coal-ore");
                    }
                }
                world.set(x, y, z, block);
            }
            // trees cluster on the ridge and far south, leaving the central prairie open
            let wooded = z > 127 || (x > 92 && z < 48);
            if !wooded || edge < 7 || x % 6 != 0 || z % 6 != 0 || hash2(fx, fz, seed) < 0.3 {
                continue;
            }
            boxed(world, x, x, z, z, top + 1, top + 4, id("oak-log"));
            for dy in 3..=5 {
                let r = if dy == 5 { 1 } else { 2 };
                for dx in -r..=r {
                    for dz in -r..=r {
                        if dx == 0 && dz == 0 && dy < 5 {
                            continue;
                        }
                        world.set(x + dx, top + dy, z + dz, id("oak-leaves"));
                    }
                }
            }
        }
    }

    // a broad raised causeway: one-block steps can be jumped either way
    let road_column = |world: &mut World, x: i32, z: i32, y: i32| {
        boxed(world, x, x, z, z, 1, y - 1, stone);
        world.set(x, y, z, brick);
        boxed(world, x, x, z, z, y + 1, WORLD_Y - 1, AIR);
    };
    let bridge_height = surface_y(world, 40, 79) as f64;
    for z in 80..=94 {
        let y = js_round(bridge_height + (12.0 - bridge_height) * (z - 79) as f64 / 15.0) as i32;
        for x in 38..=42 {
            road_column(world, x, z, y);
        }
    }
    for x in 38..=148 {
        for z in 92..=96 {
            road_column(world, x, z, 12);
        }
    }
    for x in 121..=125 {
        for z in 64..=118 {
            road_column(world, x, z, 12);
        }
    }

    let workshop = |world: &mut World, x: i32, z: i32, width: i32, depth: i32, height: i32, wall: u8| {
        boxed(world, x, x + width, z, z + depth, 1, 11, stone);
        boxed(world, x, x + width, z, z + depth, 12, 12, brick);
        boxed(world, x, x + width, z, z + depth, 13, 12 + height, wall);
        boxed(world, x + 1, x + width - 1, z + 1, z + depth - 1, 13, 11 + height, AIR);
        let mut dx = 2;
        while dx < width - 1 {
            boxed(world, x + dx, x + dx + 1, z, z, 15, 17, glass);
            boxed(world, x + dx, x + dx + 1, z + depth, z + depth, 15, 17, glass);
            dx += 3;
        }
        boxed(world, x + 3, x + 5, z + depth, z + depth, 13, 16, AIR);
        boxed(world, x - 1, x + width + 1, z - 1, z + depth + 1, 13 + height, 13 + height, iron);
        world.set(x + 4, 17, z + depth, lamp);
        let mut dz = 3;
        while dz < depth - 1 {
            boxed(world, x + 2, x + 3, z + dz, z + dz + 1, 13, 14, iron);
            world.set(x + 2, 15, z + dz, lamp);
            dz += 4;
        }
    };
    workshop(world, 102, 72, 14, 15, 9, brick);
    workshop(world, 130, 73, 14, 14, 7, brick);
    workshop(world, 102, 101, 14, 12, 6, plank);
    workshop(world, 130, 101, 14, 12, 10, brick);
    for (x, z, height) in [(105, 75, 30), (113, 75, 26), (141, 104, 32)] {
        boxed(world, x, x + 2, z, z + 2, 13, height, brick);
        boxed(world, x, x + 2, z, z + 2, height - 3, height - 2, iron);
        world.set(x + 1, height, z + 1, AIR);
    }
    for x in [133, 140] {
        boxed(world, x, x + 3, 68, 71, 13, 22, iron);
        boxed(world, x + 1, x + 2, 69, 70, 23, 23, glass);
    }
    boxed(world, 108, 135, 78, 78, 25, 25, iron);
    boxed(world, 135, 135, 78, 78, 21, 25, iron);
    boxed(world, 147, 147, 103, 115, 24, 24, id("gold-block"));
    boxed(world, 147, 147, 115, 115, 13, 24, id("gold-block"));
    boxed(world, 147, 147, 103, 103, 19, 23, iron);
    boxed(world, 146, 148, 102, 104, 17, 18, plank);
    let mut x = 52;
    while x <= 148 {
        boxed(world, x, x, 98, 98, 1, 15, iron);
        world.set(x, 16, 98, lamp);
        x += 12;
    }
}

/// `stampHogwartsCastle`: the school castle on the old island.
fn stamp_castle(world: &mut World) {
    const W: i32 = 80;
    let (brick, stone, plank, glass, torch, gold) = (id("stone-bricks"), id("stone"), id("oak-planks"), id("glass"), id("glowstone"), id("gold-block"));
    let cx = W / 2;
    let cz = W / 2;
    let floor = surface_y(world, cx, cz);
    let outer = 26;
    let wall_h = 8;
    let tower_h = 20;
    let keep_h = 25;

    let battlements = |world: &mut World, x0: i32, x1: i32, z0: i32, z1: i32, y: i32| {
        let every = 2;
        for x in x0..=x1 {
            if (x - x0) % every == 0 {
                world.set(x, y, z0, brick);
                world.set(x, y, z1, brick);
            }
        }
        for z in z0..=z1 {
            if (z - z0) % every == 0 {
                world.set(x0, y, z, brick);
                world.set(x1, y, z, brick);
            }
        }
    };
    let tower = |world: &mut World, tx: i32, tz: i32, radius: i32, height: i32, roof: u8| {
        boxed(world, tx - radius, tx + radius, tz - radius, tz + radius, floor + 1, floor + height, brick);
        let mut y = floor + 4;
        while y < floor + height - 1 {
            world.set(tx - radius - 1, y, tz, glass);
            world.set(tx + radius + 1, y, tz, glass);
            world.set(tx, y, tz - radius - 1, glass);
            y += 5;
        }
        battlements(world, tx - radius - 1, tx + radius + 1, tz - radius - 1, tz + radius + 1, floor + height + 1);
        for layer in 0..4 {
            let r = radius + 1 - layer;
            boxed(world, tx - r, tx + r, tz - r, tz + r, floor + height + 2 + layer, floor + height + 2 + layer, roof);
        }
        world.set(tx, floor + height + 6, tz, torch);
        world.set(tx, floor + height + 7, tz, gold);
    };
    let wing = |world: &mut World, x0: i32, x1: i32, z0: i32, z1: i32, height: i32| {
        boxed(world, x0, x1, z0, z0 + 1, floor + 1, floor + height, brick);
        boxed(world, x0, x1, z1 - 1, z1, floor + 1, floor + height, brick);
        boxed(world, x0, x0 + 1, z0, z1, floor + 1, floor + height, brick);
        boxed(world, x1 - 1, x1, z0, z1, floor + 1, floor + height, brick);
        let mut y = floor + 4;
        while y < floor + height - 1 {
            let mut x = x0 + 3;
            while x < x1 - 1 {
                world.set(x, y, z0 - 1, glass);
                world.set(x, y, z1 + 1, glass);
                x += 5;
            }
            y += 4;
        }
        for layer in 0..5 {
            boxed(world, x0 + layer, x1 - layer, z0 + layer, z1 - layer, floor + height + 1 + layer, floor + height + 1 + layer, plank);
        }
    };

    // foundation and the paved courtyard
    boxed(world, cx - outer, cx + outer, cz - outer, cz + outer, 1, floor - 1, stone);
    boxed(world, cx - outer, cx + outer, cz - outer, cz + outer, floor, floor, brick);
    boxed(world, cx - outer + 2, cx + outer - 2, cz - outer + 2, cz + outer - 2, floor + 1, WORLD_Y - 1, AIR);

    // double curtain wall
    for d in -outer..=outer {
        for t in 0..2 {
            for y in floor + 1..=floor + wall_h {
                world.set(cx + d, y, cz - outer + t, brick);
                world.set(cx + d, y, cz + outer - t, brick);
                world.set(cx - outer + t, y, cz + d, brick);
                world.set(cx + outer - t, y, cz + d, brick);
            }
        }
    }
    // south gatehouse
    boxed(world, cx - 3, cx + 3, cz + outer - 2, cz + outer + 1, floor + 1, floor + 5, AIR);
    boxed(world, cx - 5, cx + 5, cz + outer - 3, cz + outer + 2, floor + 1, floor + wall_h + 3, brick);
    boxed(world, cx - 3, cx + 3, cz + outer - 4, cz + outer + 3, floor + 1, floor + 5, AIR);
    for x in cx - 2..=cx + 2 {
        world.set(x, floor + 3, cz + outer - 3, gold);
    }
    for x in [cx - 4, cx + 4] {
        for y in [floor + 6, floor + 8, floor + 10] {
            world.set(x, y, cz + outer - 3, glass);
        }
    }
    battlements(world, cx - 5, cx + 5, cz + outer - 4, cz + outer + 3, floor + wall_h + 4);
    boxed(world, cx - 6, cx + 6, cz + outer + 3, cz + outer + 7, floor, floor + 1, stone);
    battlements(world, cx - outer, cx + outer, cz - outer, cz + outer, floor + wall_h + 1);

    for (sx, sz) in [(-1, -1), (1, -1), (-1, 1), (1, 1)] {
        tower(world, cx + sx * outer, cz + sz * outer, 3, tower_h, plank);
    }
    tower(world, cx - outer, cz, 2, 15, plank);
    tower(world, cx + outer, cz, 2, 16, plank);
    tower(world, cx - 10, cz - outer, 2, 14, plank);
    tower(world, cx + 10, cz - outer, 2, 14, plank);

    // central keep
    let kh = 10;
    boxed(world, cx - kh, cx + kh, cz - kh, cz - kh + 1, floor + 1, floor + keep_h, brick);
    boxed(world, cx - kh, cx + kh, cz + kh - 1, cz + kh, floor + 1, floor + keep_h, brick);
    boxed(world, cx - kh, cx - kh + 1, cz - kh, cz + kh, floor + 1, floor + keep_h, brick);
    boxed(world, cx + kh - 1, cx + kh, cz - kh, cz + kh, floor + 1, floor + keep_h, brick);
    let mut y = floor + 5;
    while y < floor + keep_h - 2 {
        for side in [-1, 1] {
            world.set(cx + side * (kh + 1), y, cz - 4, glass);
            world.set(cx + side * (kh + 1), y, cz + 4, glass);
        }
        y += 5;
    }
    boxed(world, cx - 2, cx + 2, cz + kh - 2, cz + kh + 1, floor + 1, floor + 4, AIR);
    battlements(world, cx - kh - 1, cx + kh + 1, cz - kh - 1, cz + kh + 1, floor + keep_h + 1);
    for layer in 0..6 {
        let r = kh + 1 - layer;
        boxed(world, cx - r, cx + r, cz - r, cz + r, floor + keep_h + 2 + layer, floor + keep_h + 2 + layer, plank);
    }
    world.set(cx, floor + keep_h + 8, cz, gold);
    world.set(cx, floor + keep_h + 9, cz, torch);

    // wings and the north tower
    wing(world, cx - 25, cx - 12, cz - 15, cz + 15, 12);
    wing(world, cx + 12, cx + 25, cz - 15, cz + 15, 13);
    wing(world, cx - 12, cx + 12, cz - 25, cz - 13, 15);
    wing(world, cx - 11, cx + 11, cz + 13, cz + 25, 11);
    tower(world, cx, cz - 23, 4, 19, plank);

    // courtyard braziers and garden pools
    for (sx, sz) in [(-1, -1), (1, -1), (-1, 1), (1, 1)] {
        let (x, z) = (cx + sx * 17, cz + sz * 17);
        boxed(world, x - 2, x + 2, z - 2, z + 2, floor + 1, floor + 1, stone);
        world.set(x, floor + 2, z, torch);
        boxed(world, x - 1, x + 1, z - 1, z + 1, floor + 1, floor + 1, glass);
    }

    // moat, drawbridge and approach
    for d in -outer - 3..=outer + 3 {
        for t in 0..2 {
            world.set(cx + d, floor + 1, cz - outer - 3 + t, glass);
            world.set(cx + d, floor + 1, cz + outer + 3 - t, glass);
            world.set(cx - outer - 3 + t, floor + 1, cz + d, glass);
            world.set(cx + outer + 3 - t, floor + 1, cz + d, glass);
        }
    }
    boxed(world, cx - 4, cx + 4, cz + outer + 3, cz + outer + 12, floor + 1, floor + 2, plank);
    boxed(world, cx - 5, cx + 5, cz + outer + 12, cz + outer + 15, floor + 1, floor + 1, stone);
    let mut z = cz + outer + 9;
    while z <= cz + outer + 15 {
        world.set(cx - 5, floor + 2, z, torch);
        world.set(cx + 5, floor + 2, z, torch);
        z += 2;
    }

    // glasshouse
    boxed(world, cx + 4, cx + 10, cz + 5, cz + 12, floor + 1, floor + 4, glass);
    boxed(world, cx + 3, cx + 11, cz + 4, cz + 13, floor + 5, floor + 5, glass);
    boxed(world, cx + 6, cx + 8, cz + 7, cz + 10, floor + 1, floor + 1, gold);
    let mut z = cz + 6;
    while z <= cz + 11 {
        world.set(cx + 7, floor + 2, z, torch);
        z += 2;
    }

    // parterres and hedges
    let leaves = id("oak-leaves");
    for (sx, sz) in [(-1, -1), (1, -1), (-1, 1), (1, 1)] {
        let (gx, gz) = (cx + sx * 13, cz + sz * 13);
        boxed(world, gx - 4, gx + 4, gz - 1, gz + 1, floor + 1, floor + 1, leaves);
        boxed(world, gx - 1, gx + 1, gz - 4, gz + 4, floor + 1, floor + 1, leaves);
        boxed(world, gx - 2, gx + 2, gz - 2, gz + 2, floor + 1, floor + 1, glass);
        world.set(gx, floor + 2, gz, torch);
    }

    // the park around the school
    let log = id("oak-log");
    for i in 0..20 {
        let side = i % 4;
        let lane = 6 + (i * 7) % 25;
        let x = if side == 0 { cx - outer - 4 } else if side == 1 { cx + outer + 4 } else { cx - outer + lane };
        let z = if side == 2 { cz - outer - 4 } else if side == 3 { cz + outer + 4 } else { cz - outer + lane };
        let top = surface_y(world, x, z);
        if top > floor - 2 && top < WORLD_Y - 5 && !(side == 3 && (x - cx).abs() < 10) {
            for y in top + 1..=top + 3 {
                world.set(x, y, z, log);
            }
            for dx in -2..=2i32 {
                for dz in -2..=2i32 {
                    if dx.abs() + dz.abs() < 4 {
                        world.set(x + dx, top + 4, z + dz, leaves);
                    }
                }
            }
        }
    }

    // four lawn courts at the corners
    let grass = id("grass");
    for (sx, sz) in [(-1, -1), (1, -1), (-1, 1), (1, 1)] {
        let (gx, gz) = (cx + sx * (outer + 6), cz + sz * (outer + 6));
        boxed(world, gx - 4, gx + 4, gz - 4, gz + 4, floor + 1, floor + 1, grass);
        boxed(world, gx - 1, gx + 1, gz - 7, gz + 7, floor + 2, floor + 2, stone);
        boxed(world, gx - 7, gx + 7, gz - 1, gz + 1, floor + 2, floor + 2, stone);
        let (tx, tz) = (gx + 3, gz + 3);
        for y in floor + 2..=floor + 5 {
            world.set(tx, y, tz, log);
        }
        for dx in -2..=2i32 {
            for dz in -2..=2i32 {
                if dx.abs() + dz.abs() < 4 {
                    world.set(tx + dx, floor + 6, tz + dz, leaves);
                }
            }
        }
    }

    // a green rim around the school
    let dirt = id("dirt");
    for x in 0..W {
        for z in 0..W {
            if (x - cx).abs() <= outer + 1 && (z - cz).abs() <= outer + 1 {
                continue;
            }
            for y in (1..WORLD_Y).rev() {
                let cell = world.get(x, y, z);
                if cell != AIR {
                    if cell == stone || cell == dirt {
                        world.set(x, y, z, grass);
                    }
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_round_matches_math_round() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_round(-0.4), 0.0);
    }

    #[test]
    fn the_island_has_bedrock_a_castle_and_a_town() {
        let w = generate_island(12345.0);
        assert_eq!(w.get(10, 0, 10), id("bedrock"));
        assert_eq!(w.get(40, 12, 92), id("stone-bricks")); // the causeway
        assert!(w.cells.iter().filter(|c| **c == id("glowstone")).count() > 10);
    }
}
