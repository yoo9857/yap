//! Which texture layer and tint each block face band draws with: the web's choice, generated into
//! `tiles_gen.rs` by tools/engine-tiles.mjs (picture tiles, the AI albedos, or the procedural family
//! maps). The texture array is laid out as `layers()`: the 13 family maps, then every picture tile,
//! then one baked copy per (tile, multiplier) pair (a tint above 1, like the grass top's
//! GRASS_TINT, cannot ride in an 8-bit vertex colour).

use crate::tiles_gen::{Surface, Tint, BLOCK_BANDS, TILES};
use craftyap_core::blocks_gen::BLOCKS;
use craftyap_core::surface::Family;
use std::sync::OnceLock;

/// A face band's vertex tint (sRGB) and texture layer.
type Look = ([u8; 3], u8);

/// One layer of the surface texture array.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Layer {
    Family(Family),
    /// `TILES[i]`, optionally multiplied (in linear light) by a tint.
    Tile(usize, Option<[f32; 3]>),
}

/// The array's layers in order.
pub fn layers() -> Vec<Layer> {
    let mut out: Vec<Layer> = Family::ALL.iter().map(|&f| Layer::Family(f)).collect();
    out.extend((0..TILES.len()).map(|i| Layer::Tile(i, None)));
    for (_, bands) in BLOCK_BANDS {
        for &(surface, tint) in bands {
            if let (Surface::Tile(i), Tint::Mul(m)) = (surface, tint) {
                if !out.contains(&Layer::Tile(i, Some(m))) {
                    out.push(Layer::Tile(i, Some(m)));
                }
            }
        }
    }
    out
}

fn layer_index(layer: Layer) -> u8 {
    static ALL: OnceLock<Vec<Layer>> = OnceLock::new();
    ALL.get_or_init(layers).iter().position(|l| *l == layer).unwrap_or(0) as u8
}

/// A block face band's look (0 top, 1 side, 2 bottom): the vertex tint (sRGB) and the layer.
/// Blocks the table does not know (none today: tools/engine-tiles.mjs covers every non-fluid
/// block) fall back to the block colour on the coat map.
pub fn band_look(block: u8, band: usize) -> ([u8; 3], u8) {
    // per vertex in the mesher: a table, built once
    static TABLE: OnceLock<Vec<[Look; 3]>> = OnceLock::new();
    TABLE.get_or_init(|| (0..=255u8).map(|b| [0, 1, 2].map(|band| look(b, band))).collect())[block as usize][band.min(2)]
}

fn look(block: u8, band: usize) -> ([u8; 3], u8) {
    let def = BLOCKS.iter().find(|b| b.id == block);
    let color = def.map_or([255, 0, 255], |b| b.color);
    let Some((_, bands)) = BLOCK_BANDS.iter().find(|(id, _)| *id == block) else {
        return (color, Family::Coat.index() as u8);
    };
    let (surface, tint) = bands[band.min(2)];
    let layer = match (surface, tint) {
        (Surface::Family(f), _) => Layer::Family(f),
        (Surface::Tile(i), Tint::Mul(m)) => Layer::Tile(i, Some(m)),
        (Surface::Tile(i), _) => Layer::Tile(i, None),
    };
    let rgb = match tint {
        Tint::Color => color,
        Tint::White | Tint::Mul(_) => [255; 3],
    };
    (rgb, layer_index(layer))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_solid_block_has_its_web_bands() {
        for b in BLOCKS.iter().filter(|b| !b.fluid) {
            assert!(BLOCK_BANDS.iter().any(|(id, _)| *id == b.id), "{} missing from tiles_gen.rs: re-run tools/engine-tiles.mjs", b.key);
        }
        assert!(layers().len() < 256, "the layer index is a byte");
    }

    #[test]
    fn the_web_choices_arrive() {
        let id = |k: &str| craftyap_core::world::id(k);
        let tile = |name: &str| layer_index(Layer::Tile(TILES.iter().position(|t| t.name == name).unwrap(), None));
        // castle stone bricks: their picture tile, untinted, on every face
        for band in 0..3 {
            assert_eq!(band_look(id("stone-bricks"), band), ([255; 3], tile("tile-stone-bricks")));
        }
        // grass: AI top (with GRASS_TINT baked into its own layer), procedural side and bottom
        let (rgb, top) = band_look(id("grass"), 0);
        assert_eq!(rgb, [255; 3]);
        assert!(matches!(layers()[top as usize], Layer::Tile(_, Some(_))));
        assert_eq!(band_look(id("grass"), 1).1, Family::GrassSide.index() as u8);
        assert_eq!(band_look(id("grass"), 2).1, Family::Dirt.index() as u8);
        // sand: the procedural family times the block colour
        let sand = BLOCKS.iter().find(|b| b.key == "sand").unwrap();
        assert_eq!(band_look(sand.id, 0), (sand.color, Family::Sand.index() as u8));
    }
}
