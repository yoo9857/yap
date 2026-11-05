//! Block surface textures: a line-for-line port of `apps/client/src/craft/blockMaterials.ts`
//! (`surfaceStyle`, `createMaterialMaps`). Each surface FAMILY (stone, wood, wool, …) is one
//! greyscale-ish tile that the block's colour tints; grass, dirt, snow and diamond carry their own
//! colour ("featured", tinted white). `apps/client/test/rust-surface.test.ts` requires the same
//! bytes as the TypeScript for every family.


#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Family {
    Coat,
    Snow,
    Grass,
    Dirt,
    Gem,
    Ore,
    Wood,
    Wool,
    Sand,
    Metal,
    Glass,
    Stone,
    /// Not a block family: the side of a grass block (earth with a grass fringe).
    GrassSide,
}

impl Family {
    pub const ALL: [Family; 13] = [Family::Coat, Family::Snow, Family::Grass, Family::Dirt, Family::Gem, Family::Ore, Family::Wood, Family::Wool, Family::Sand, Family::Metal, Family::Glass, Family::Stone, Family::GrassSide];

    pub fn name(self) -> &'static str {
        match self {
            Family::Coat => "coat",
            Family::Snow => "snow",
            Family::Grass => "grass",
            Family::Dirt => "dirt",
            Family::Gem => "gem",
            Family::Ore => "ore",
            Family::Wood => "wood",
            Family::Wool => "wool",
            Family::Sand => "sand",
            Family::Metal => "metal",
            Family::Glass => "glass",
            Family::Stone => "stone",
            Family::GrassSide => "grass-side",
        }
    }

    pub fn index(self) -> usize {
        Family::ALL.iter().position(|f| *f == self).unwrap_or(0)
    }
}

/// `surfaceStyle(key).family`.
pub fn family_of(key: &str) -> Family {
    let has = |s: &str| key.contains(s);
    if key == "snow" {
        Family::Snow
    } else if key == "grass" || key == "flower-grass" {
        Family::Grass
    } else if key == "dirt" {
        Family::Dirt
    } else if key == "diamond-block" || key == "obsidian" {
        Family::Gem
    } else if key.ends_with("-ore") {
        Family::Ore
    } else if has("planks") || has("log") || has("bookshelf") || has("hay") {
        Family::Wood
    } else if has("wool") {
        Family::Wool
    } else if has("sand") || has("gravel") || has("clay") || has("terracotta") {
        Family::Sand
    } else if key == "iron-block" || key == "gold-block" {
        Family::Metal
    } else if key == "glass" || key == "ice" {
        Family::Glass
    } else if key == "coat" {
        Family::Coat
    } else {
        Family::Stone
    }
}

/// Blocks whose map carries the colour (the material is tinted white): `featured` in blockMaterials.
pub fn featured(key: &str) -> bool {
    matches!(key, "snow" | "grass" | "dirt" | "diamond-block")
}

/// The families a block's faces use: grass is top / side / bottom, everything else one family.
pub fn families_of(key: &str) -> [Family; 3] {
    match family_of(key) {
        Family::Grass => [Family::Grass, Family::GrassSide, Family::Dirt],
        f => [f, f, f],
    }
}

fn hash(x: i32, y: i32) -> f64 {
    let mut h = (x.wrapping_add(29)).wrapping_mul(374761393) ^ (y.wrapping_add(71)).wrapping_mul(668265263);
    h = (h ^ ((h as u32) >> 13) as i32).wrapping_mul(1274126177);
    ((h ^ ((h as u32) >> 16) as i32) as u32) as f64 / 4294967295.0
}

/// `Math.round` (halves toward +∞), then clamped to a byte.
fn clamp(n: f64) -> u8 {
    let f = n.floor();
    let r = if n - f >= 0.5 { f + 1.0 } else { f };
    r.clamp(0.0, 255.0) as u8
}

/// V8's `Math.hypot` for three arguments.
fn hypot3(a: f64, b: f64, c: f64) -> f64 {
    let v = [a.abs(), b.abs(), c.abs()];
    let max = v.iter().copied().fold(0.0, f64::max);
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut compensation) = (0.0f64, 0.0f64);
    for x in v {
        let n = x / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// The three maps of one family, RGBA8 `size`×`size`: colour (sRGB), normal, roughness/metalness.
pub struct MaterialMaps {
    pub size: usize,
    pub colour: Vec<u8>,
    pub normals: Vec<u8>,
    pub rough: Vec<u8>,
}

/// `createMaterialMaps(family, size)`. The defaults before the family branches are kept from the
/// TypeScript even though every branch overwrites them (line-for-line port).
#[allow(unused_assignments)]
pub fn create_material_maps(family: Family, size: usize) -> MaterialMaps {
    let n_px = size * size;
    let (mut colour, mut normals, mut rough) = (vec![0u8; n_px * 4], vec![0u8; n_px * 4], vec![0u8; n_px * 4]);
    let mut height = vec![0f32; n_px];
    let s = size as f64;
    let noise = |x: usize, y: usize, scale: i32| -> f64 {
        let sc = scale as f64;
        let px = x as f64 / s * sc;
        let py = y as f64 / s * sc;
        let (ix, iy) = (px.floor(), py.floor());
        let (fx, fy) = (px - ix, py - iy);
        let sx = fx * fx * (3.0 - 2.0 * fx);
        let sy = fy * fy * (3.0 - 2.0 * fy);
        let (ix, iy) = (ix as i32, iy as i32);
        let h = |a: i32, b: i32| hash((a + scale) % scale, (b + scale) % scale);
        (h(ix, iy) * (1.0 - sx) + h(ix + 1, iy) * sx) * (1.0 - sy) + (h(ix, iy + 1) * (1.0 - sx) + h(ix + 1, iy + 1) * sx) * sy
    };
    let pi = std::f64::consts::PI;
    for y in 0..size {
        for x in 0..size {
            let i = y * size + x;
            let h = hash(x as i32, y as i32);
            let n = noise(x, y, 8);
            let (u, v) = (x as f64 / s, y as f64 / s);
            let mut base = [240.0, 240.0, 240.0];
            let mut bump = (h - 0.5) * 0.08;
            let mut r = 0.77;
            let ground = family == Family::Dirt || (family == Family::GrassSide && v < 0.93 + 0.018 * (u * pi * 6.0).sin());
            if ground {
                let fine = noise(x, y, 32);
                let mottle = noise(x, y, 4);
                let tone = (n - 0.5) * 15.0 + (fine - 0.5) * 8.0 + (mottle - 0.5) * 8.0 + (h - 0.5) * 3.0;
                base = [145.0 + tone, 109.0 + tone * 0.82, 76.0 + tone * 0.65];
                bump = n * 0.045 + fine * 0.018 + (h - 0.5) * 0.006;
                r = 0.96;
            } else if family == Family::Grass || family == Family::GrassSide {
                let blade = ((u * 26.0 + noise(x, y, 16) * 0.85) * pi).sin().abs() < 0.22;
                let tone = (n - 0.5) * 32.0 + if blade { 16.0 } else { 0.0 } + (h - 0.5) * 8.0;
                base = [65.0 + tone * 0.8, 136.0 + tone, 42.0 + tone * 0.5];
                bump = n * 0.18 + if blade { 0.11 } else { 0.0 };
                r = 0.91;
            } else if family == Family::Snow {
                let t = (n - 0.5) * 16.0 + (h - 0.5) * 5.0;
                base = [240.0 + t * 0.7, 247.0 + t * 0.45, 253.0 + t * 0.15];
                bump = n * 0.23 + (h - 0.5) * 0.045;
                r = 0.94;
            } else if family == Family::Gem {
                let (gx, gy) = (u * 6.0, v * 6.0);
                let (cx, cy) = (gx % 1.0, gy % 1.0);
                let facet = cx + cy > 1.0;
                let band = hash(gx.floor() as i32, gy.floor() as i32);
                let t = 0.65 + band * 0.23 + if facet { 0.1 } else { 0.0 };
                base = [69.0 * t, 220.0 * t, 226.0 * t];
                let seam = cx.min(cy).min(1.0 - cx).min(1.0 - cy) < 0.027;
                bump = if seam { -0.08 } else if facet { 0.008 } else { 0.014 };
                r = 0.22 + band * 0.13;
                if seam {
                    base = base.map(|c| c * 0.8);
                }
            } else if family == Family::Sand {
                let fine = noise(x, y, 32);
                let drift = noise(x, y, 4);
                let tone = (n - 0.5) * 5.0 + (fine - 0.5) * 5.0 + (drift - 0.5) * 3.0 + (h - 0.5) * 2.0;
                base = [243.0 + tone, 241.0 + tone, 235.0 + tone];
                bump = n * 0.012 + fine * 0.008 + (h - 0.5) * 0.003;
                r = 0.99;
            } else if family == Family::Wood {
                let grain = ((u * 13.0 + (v * pi * 4.0).sin() * 0.22 + n * 0.25) * pi * 2.0).sin();
                let seam = (v * 4.0) % 1.0 < 0.022;
                base = [240.0 + grain * 9.0, 235.0 + grain * 10.0, 225.0 + grain * 12.0];
                bump = grain * 0.08 + if seam { -0.2 } else { 0.0 };
                r = 0.76;
            } else if family == Family::Wool {
                let weave = (u * pi * 48.0).sin() * (v * pi * 48.0).sin();
                base = [240.0 + weave * 11.0, 240.0 + weave * 11.0, 240.0 + weave * 11.0];
                bump = weave * 0.15 + (h - 0.5) * 0.07;
                r = 0.98;
            } else if family == Family::Metal {
                let brush = (v * pi * 96.0).sin() * 0.5 + (h - 0.5) * 0.5;
                base = [239.0 + brush * 8.0, 239.0 + brush * 8.0, 239.0 + brush * 8.0];
                bump = brush * 0.025;
                r = 0.4 + brush * 0.08;
            } else if family == Family::Glass {
                let vein = ((u - v) * pi * 5.0 + n * 0.12).sin().abs() < 0.04;
                base = [248.0, 251.0, 255.0];
                bump = if vein { 0.035 } else { 0.0 };
                r = 0.18;
            } else {
                let grit = if family == Family::Ore { 0.24 } else { 0.2 };
                let g = 235.0 + (n - 0.5) * 26.0;
                base = [g, g, g];
                bump = n * grit + (h - 0.5) * 0.08;
                r = if family == Family::Coat { 0.73 } else { 0.88 };
            }
            height[i] = bump as f32;
            colour[i * 4..i * 4 + 4].copy_from_slice(&[clamp(base[0]), clamp(base[1]), clamp(base[2]), 255]);
            rough[i * 4..i * 4 + 4].copy_from_slice(&[255, clamp(r * 255.0 + (h - 0.5) * 12.0), if family == Family::Metal { 255 } else { 0 }, 255]);
        }
    }
    let si = size as i64;
    let at = |x: i64, y: i64| height[(((y + si) % si) * si + (x + si) % si) as usize] as f64;
    for y in 0..si {
        for x in 0..si {
            let dx = (at(x - 1, y) - at(x + 1, y)) * 1.5;
            let dy = (at(x, y - 1) - at(x, y + 1)) * 1.5;
            let l = hypot3(dx, dy, 1.0);
            let o = ((y * si + x) * 4) as usize;
            normals[o..o + 4].copy_from_slice(&[clamp((dx / l * 0.5 + 0.5) * 255.0), clamp((dy / l * 0.5 + 0.5) * 255.0), clamp((1.0 / l * 0.5 + 0.5) * 255.0), 255]);
        }
    }
    MaterialMaps { size, colour, normals, rough }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_follow_surface_style() {
        assert_eq!(family_of("oak-planks"), Family::Wood);
        assert_eq!(family_of("iron-ore"), Family::Ore);
        assert_eq!(family_of("red-sand"), Family::Sand);
        assert_eq!(family_of("stone-bricks"), Family::Stone);
        assert_eq!(families_of("grass"), [Family::Grass, Family::GrassSide, Family::Dirt]);
        assert!(featured("grass") && !featured("stone"));
    }

    #[test]
    fn maps_are_opaque_and_sized() {
        let m = create_material_maps(Family::Wood, 32);
        assert_eq!(m.colour.len(), 32 * 32 * 4);
        assert!(m.colour.chunks(4).all(|p| p[3] == 255));
    }
}
