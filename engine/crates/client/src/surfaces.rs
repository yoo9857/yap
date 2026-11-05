//! The block surface textures, made OFF the main thread: generation starts when the app starts,
//! in parallel with the window and device, spread over the cores. The renderer only uploads the
//! finished levels. The maps outlive any device, so a lost device rebuilds without remaking them.
//!
//! One texture array at SIZE, laid out as `looks::layers()`:
//! - the 13 procedural family maps (blockMaterials.ts createMaterialMaps via the core, made at the
//!   web's 128 texels and upsampled 2× as a GPU's bilinear filter would read them);
//! - the picture tiles and AI albedos (`tiles_gen.rs`: the web's frameless tiles, baked by
//!   tools/engine-tiles.mjs, and the AI albedo files themselves), decoded from WebP, flipped as
//!   three uploads them, scaled to SIZE (the 512 AI albedos by a 2×2 box: their first mip);
//! - tiles that carry a multiplier (the grass top's GRASS_TINT), with it applied in linear light.
//!
//! Two more arrays with the same layers, at DETAIL texels (the web's procedural maps are 128;
//! these are the lighting's fine grain, not the picture): normals and roughness/metalness (three's
//! roughnessMap.g / metalnessMap.b). A layer uses its own maps when it has them (the AI albedos),
//! else its family's procedural ones (`looks::layer_family`), as the web's materials do.
//!
//! A tile that cannot be decoded is logged and drawn flat grey: never a crash.

use crate::looks::{layer_family, layers, Layer};
use crate::tiles_gen::TILES;
use craftyap_core::surface::create_material_maps;
use std::sync::Arc;
use std::thread::JoinHandle;

/// Tile size in texels (one tile per metre, like the web's planar kit UVs).
pub const SIZE: u32 = 256;
/// The size the web makes its procedural maps at (createMaterialMaps' default).
const FAMILY_SIZE: usize = 128;
/// Normal and roughness maps: the web's procedural size.
pub const DETAIL: u32 = 128;

/// Every layer's colour map with its full mip chain: `layers[layer][mip]` (RGBA8, sRGB).
pub struct SurfaceMaps {
    pub size: u32,
    pub layers: Vec<Vec<Vec<u8>>>,
    /// Per layer: the normal map and the roughness/metalness map, each with its mips, at DETAIL.
    pub normals: Vec<Vec<Vec<u8>>>,
    pub orm: Vec<Vec<Vec<u8>>>,
}

impl SurfaceMaps {
    pub fn levels(&self) -> u32 {
        self.size.ilog2() + 1
    }
    #[cfg(test)]
    pub fn detail_levels(&self) -> u32 {
        DETAIL.ilog2() + 1
    }

    /// Make every layer now, spread over the CPU's cores.
    pub fn build() -> Self {
        let plan = layers();
        let workers = std::thread::available_parallelism().map_or(2, |n| n.get()).clamp(1, 6);
        type Chains = (Vec<Vec<u8>>, Vec<Vec<u8>>, Vec<Vec<u8>>);
        let mut out: Vec<Option<Chains>> = vec![None; plan.len()];
        std::thread::scope(|s| {
            let per = plan.len().div_ceil(workers);
            for (k, slots) in out.chunks_mut(per).enumerate() {
                let plan = &plan;
                s.spawn(move || {
                    for (j, slot) in slots.iter_mut().enumerate() {
                        let layer = plan[k * per + j];
                        let (n, o) = detail(layer);
                        *slot = Some((mip_chain(base(layer), SIZE), mip_chain(n, DETAIL), mip_chain(o, DETAIL)));
                    }
                });
            }
        });
        let flat = || (mip_chain(vec![200; (SIZE * SIZE * 4) as usize], SIZE), mip_chain(flat_normal(), DETAIL), mip_chain(flat_orm(), DETAIL));
        let (mut layers, mut normals, mut orm) = (Vec::new(), Vec::new(), Vec::new());
        for (a, n, o) in out.into_iter().map(|l| l.unwrap_or_else(flat)) {
            layers.push(a);
            normals.push(n);
            orm.push(o);
        }
        Self { size: SIZE, layers, normals, orm }
    }
}

/// A layer's full-size RGBA texels.
fn base(layer: Layer) -> Vec<u8> {
    match layer {
        Layer::Family(f) => upsample(&create_material_maps(f, FAMILY_SIZE).colour, FAMILY_SIZE),
        Layer::Tile(i, mul) => match tile(i) {
            Ok(mut px) => {
                if let Some(m) = mul {
                    multiply(&mut px, m);
                }
                px
            }
            Err(e) => {
                log::error!("surface tile {}: {e}; drawn flat", TILES[i].name);
                vec![200; (SIZE * SIZE * 4) as usize]
            }
        },
    }
}

/// A straight-up normal (no bumps) and a fully rough, non-metal surface: what a layer whose maps
/// cannot be read is lit with.
fn flat_normal() -> Vec<u8> {
    [128u8, 128, 255, 255].repeat((DETAIL * DETAIL) as usize)
}
fn flat_orm() -> Vec<u8> {
    [255u8, 255, 0, 255].repeat((DETAIL * DETAIL) as usize)
}

/// A layer's normal and roughness/metalness maps at DETAIL.
fn detail(layer: Layer) -> (Vec<u8>, Vec<u8>) {
    if let Layer::Tile(i, _) = layer {
        let t = &TILES[i];
        if let (Some(n), Some(o)) = (t.normal, t.roughness) {
            match (decode(n, t.flip_y, DETAIL as usize), decode(o, t.flip_y, DETAIL as usize)) {
                (Ok(n), Ok(o)) => return (n, o),
                (Err(e), _) | (_, Err(e)) => log::error!("surface tile {} detail maps: {e}; using its family's", t.name),
            }
        }
    }
    let maps = create_material_maps(layer_family(layer), DETAIL as usize);
    (maps.normals, maps.rough)
}

/// Decode `TILES[i]` to SIZE×SIZE RGBA in GPU row order.
pub fn tile(i: usize) -> Result<Vec<u8>, String> {
    decode(TILES[i].webp, TILES[i].flip_y, SIZE as usize)
}

/// Decode a WebP to `side`×`side` RGBA in GPU row order (halved down from a larger power of two).
fn decode(webp: &[u8], flip_y: bool, side_out: usize) -> Result<Vec<u8>, String> {
    let mut d = image_webp::WebPDecoder::new(std::io::Cursor::new(webp)).map_err(|e| e.to_string())?;
    let (w, h) = d.dimensions();
    let mut raw = vec![0u8; d.output_buffer_size().ok_or("image too large")?];
    d.read_image(&mut raw).map_err(|e| e.to_string())?;
    let mut px: Vec<u8> = if d.has_alpha() { raw } else { raw.as_chunks::<3>().0.iter().flat_map(|p| [p[0], p[1], p[2], 255]).collect() };
    let (mut side, s) = (w as usize, side_out);
    if w != h || !side.is_power_of_two() || side < s {
        return Err(format!("{w}x{h}: tiles are square powers of two, at least {s}"));
    }
    while side > s {
        px = half(&px, side);
        side /= 2;
    }
    if flip_y {
        // three uploads an image with row 0 at v = 1
        px = px.chunks_exact(s * 4).rev().flatten().copied().collect();
    }
    Ok(px)
}

/// 2× bilinear upsample with wrap: the texel centres of the double map sit at ¼ / ¾ between the
/// source's, so sampling it reads (almost) what a linear filter reads from the source.
fn upsample(src: &[u8], n: usize) -> Vec<u8> {
    let m = n * 2;
    let mut out = vec![0u8; m * m * 4];
    let wrap = |v: f32| (v as i32).rem_euclid(n as i32) as usize;
    for y in 0..m {
        for x in 0..m {
            let (sx, sy) = ((x as f32 + 0.5) / 2.0 - 0.5, (y as f32 + 0.5) / 2.0 - 0.5);
            let (x0, y0) = (sx.floor(), sy.floor());
            let (fx, fy) = (sx - x0, sy - y0);
            let (xa, xb, ya, yb) = (wrap(x0), wrap(x0 + 1.0), wrap(y0), wrap(y0 + 1.0));
            for c in 0..4 {
                let at = |xx: usize, yy: usize| src[(yy * n + xx) * 4 + c] as f32;
                let v = (at(xa, ya) * (1.0 - fx) + at(xb, ya) * fx) * (1.0 - fy) + (at(xa, yb) * (1.0 - fx) + at(xb, yb) * fx) * fy;
                out[(y * m + x) * 4 + c] = v.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

/// Multiply sRGB texels by a linear-light factor (three: decoded map × material colour).
fn multiply(px: &mut [u8], m: [f32; 3]) {
    let to_lin = |c: u8| {
        let c = c as f32 / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let to_srgb = |l: f32| {
        let l = l.clamp(0.0, 1.0);
        let c = if l <= 0.0031308 { l * 12.92 } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 };
        (c * 255.0).round() as u8
    };
    for p in px.as_chunks_mut::<4>().0 {
        for c in 0..3 {
            p[c] = to_srgb(to_lin(p[c]) * m[c]);
        }
    }
}

fn mip_chain(mut level: Vec<u8>, top: u32) -> Vec<Vec<u8>> {
    let mut size = top as usize;
    let mut chain = Vec::new();
    while size > 1 {
        let next = half(&level, size);
        chain.push(std::mem::replace(&mut level, next));
        size /= 2;
    }
    chain.push(level);
    chain
}

/// One mip step: 2×2 box average (the tiles wrap, so no edge handling is needed).
fn half(src: &[u8], size: usize) -> Vec<u8> {
    let h = size / 2;
    let mut out = vec![0u8; h * h * 4];
    for y in 0..h {
        for x in 0..h {
            for c in 0..4 {
                let at = |dx: usize, dy: usize| src[((y * 2 + dy) * size + x * 2 + dx) * 4 + c] as u32;
                out[(y * h + x) * 4 + c] = ((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1) + 2) / 4) as u8;
            }
        }
    }
    out
}

/// Maps being made on a background thread; `get` waits for them the first time (by then they
/// are usually done: the window and the device take longer). A generator that panicked is
/// logged and the maps are made again here, so a texture bug never leaves the app without one.
pub struct PendingSurfaces {
    job: Option<JoinHandle<SurfaceMaps>>,
    ready: Option<Arc<SurfaceMaps>>,
}

impl PendingSurfaces {
    pub fn start() -> Self {
        let job = std::thread::Builder::new()
            .name("surfaces".into())
            .spawn(|| {
                let t = std::time::Instant::now();
                let maps = SurfaceMaps::build();
                log::info!("block surfaces made in {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);
                maps
            })
            .map_err(|e| log::error!("cannot start the surface thread, making them inline: {e}"))
            .ok();
        Self { job, ready: None }
    }

    pub fn get(&mut self) -> Arc<SurfaceMaps> {
        if let Some(r) = &self.ready {
            return r.clone();
        }
        let maps = match self.job.take().map(JoinHandle::join) {
            Some(Ok(maps)) => maps,
            Some(Err(_)) => {
                log::error!("the surface thread panicked; making the surfaces inline");
                SurfaceMaps::build()
            }
            None => SurfaceMaps::build(),
        };
        let maps = Arc::new(maps);
        self.ready = Some(maps.clone());
        maps
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_layer_has_a_full_mip_chain() {
        let maps = SurfaceMaps::build();
        let plan = layers();
        assert_eq!(maps.layers.len(), plan.len());
        assert_eq!((maps.normals.len(), maps.orm.len()), (plan.len(), plan.len()));
        for chain in maps.normals.iter().chain(&maps.orm) {
            assert_eq!(chain.len() as u32, maps.detail_levels());
            assert_eq!(chain[0].len(), (DETAIL * DETAIL * 4) as usize);
        }
        for (k, chain) in maps.layers.iter().enumerate() {
            assert_eq!(chain.len() as u32, maps.levels());
            for (mip, level) in chain.iter().enumerate() {
                let side = (SIZE >> mip) as usize;
                assert_eq!(level.len(), side * side * 4, "layer {k} mip {mip}");
            }
            // a family layer is the web's 128-texel map, doubled: its mip 1 stays close to it
            if let Layer::Family(f) = plan[k] {
                let web = create_material_maps(f, FAMILY_SIZE).colour;
                let mean = chain[1].iter().zip(&web).map(|(a, b)| (*a as i32 - *b as i32).abs()).sum::<i32>() as f64 / web.len() as f64;
                assert!(mean < 6.0, "{f:?}: mean difference {mean}");
            }
        }
    }

    #[test]
    fn every_tile_decodes_at_size() {
        for (i, t) in TILES.iter().enumerate() {
            let px = tile(i).unwrap_or_else(|e| panic!("{}: {e}", t.name));
            assert_eq!(px.len(), (SIZE * SIZE * 4) as usize);
            let first = &px[..4];
            assert!(px.as_chunks::<4>().0.iter().any(|p| p[..] != *first), "{} is a flat fill", t.name);
        }
    }

    #[test]
    fn the_ai_tiles_bring_their_own_normal_maps() {
        let ai = TILES.iter().position(|t| t.name == "ai-grass").unwrap();
        let (n, _) = detail(Layer::Tile(ai, None));
        // a real normal map: mostly facing out (blue high), and not flat
        let px = n.as_chunks::<4>().0;
        assert!(px.iter().filter(|p| p[2] > 180).count() > px.len() / 2);
        assert!(px.iter().any(|p| p[..] != px[0][..]));
    }

    #[test]
    fn a_multiplier_works_in_linear_light() {
        let mut px = vec![100, 100, 100, 255];
        multiply(&mut px, [1.0, 1.3, 0.5]);
        assert_eq!(px[0], 100);
        assert!(px[1] > 110 && px[1] < 120, "{}", px[1]);
        assert!(px[2] < 75);
        assert_eq!(px[3], 255);
    }
}
