//! Water on screen: the surface from the core's port of waterGeometry.ts (`water_mesh.rs`, parity-
//! tested against the TypeScript bit for bit) per chunk, and the detail texture of waterMesh.ts
//! (`waterDetail`: periodic value noise → slopes, foam noise, heights), made by the same algorithm.
//! The look itself is `water_fs` in shader.wgsl (waterMesh.ts's material, line for line).
//!
//! Like voxelView, a shaped block holding water (`World::wet`) is handed to the mesher AS that water;
//! the brick is drawn opaque over whatever water falls inside it.

use crate::chunks::CHUNK;
use craftyap_core::blocks_gen::SOLID;
use craftyap_core::water_mesh::build_water_mesh;
use craftyap_core::world::{World, WORLD_X, WORLD_Y, WORLD_Z};

/// One water vertex: position, normal, (wave, wet, foam, depth), flow, impact (weighted).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, bytemuck::Pod, bytemuck::Zeroable)]
pub struct WaterVertex {
    pub pos: [f32; 3],
    pub nrm: [f32; 3],
    pub look: [f32; 4],
    pub flow: [f32; 3],
    pub impact: [f32; 3],
}

/// The water of one chunk as a triangle list (empty: no water there).
pub fn mesh_water(world: &World, cx: i32, cz: i32) -> Vec<WaterVertex> {
    let get = |x: i32, y: i32, z: i32| -> u8 {
        if World::in_bounds(x, y, z) {
            let w = world.wet[World::index(x, y, z)];
            if w != 0 {
                return w;
            }
        }
        world.get(x, y, z)
    };
    let (x0, z0) = (cx * CHUNK, cz * CHUNK);
    let mut cells = Vec::new();
    for y in 0..WORLD_Y {
        for z in z0..(z0 + CHUNK).min(WORLD_Z) {
            for x in x0..(x0 + CHUNK).min(WORLD_X) {
                let b = get(x, y, z);
                if b != 0 && !SOLID[b as usize] {
                    cells.push([x, y, z]);
                }
            }
        }
    }
    if cells.is_empty() {
        return Vec::new();
    }
    let Some(mesh) = build_water_mesh(&get, &cells) else {
        return Vec::new();
    };
    log::debug!("water: chunk {cx},{cz}: {} cells, {} triangles", cells.len(), mesh.indices.len() / 3);
    mesh.indices
        .iter()
        .map(|&i| {
            let i = i as usize;
            let v3 = |a: &[f32]| [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
            WaterVertex {
                pos: v3(&mesh.position),
                nrm: v3(&mesh.normal),
                look: [mesh.wave[i], mesh.wet[i], mesh.foam[i], mesh.depth[i]],
                flow: v3(&mesh.flow),
                impact: v3(&mesh.impact),
            }
        })
        .collect()
}

/// waterMesh.ts `waterDetail`: 128 × 128 RGBA — slope x, slope y, foam noise, height. Periodic.
pub const DETAIL: u32 = 128;

pub fn detail_texture() -> Vec<u8> {
    let size = DETAIL as i32;
    let hash = |x: i32, y: i32| -> f64 {
        let mut n = x.wrapping_mul(374761393) ^ y.wrapping_mul(668265263);
        n = (n ^ ((n as u32) >> 13) as i32).wrapping_mul(1274126177);
        ((n ^ ((n as u32) >> 16) as i32) as u32) as f64 / 4294967295.0
    };
    let value = |x: f64, y: f64, period: i32| -> f64 {
        let (ix, iy) = (x.floor() as i32, y.floor() as i32);
        let (fx, fy) = (x - ix as f64, y - iy as f64);
        let (u, v) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
        let a = hash(ix % period, iy % period);
        let b = hash((ix + 1) % period, iy % period);
        let c = hash(ix % period, (iy + 1) % period);
        let d = hash((ix + 1) % period, (iy + 1) % period);
        (a + (b - a) * u) * (1.0 - v) + (c + (d - c) * u) * v
    };
    let n = (size * size) as usize;
    let (mut heights, mut noise) = (vec![0.0f64; n], vec![0.0f64; n]);
    for y in 0..size {
        for x in 0..size {
            let i = (y * size + x) as usize;
            let (fx, fy) = (x as f64, y as f64);
            heights[i] = value(fx / 8.0, fy / 8.0, 16) * 0.65 + value(fx / 4.0, fy / 4.0, 32) * 0.35;
            noise[i] = value(fx / 16.0, fy / 16.0, 8) * 0.7 + value(fx / 4.0, fy / 4.0, 32) * 0.3;
        }
    }
    let round = |v: f64| -> u8 { (v.clamp(0.0, 1.0) * 255.0 + 0.5).floor() as u8 };
    let mut bytes = vec![0u8; n * 4];
    for y in 0..size {
        for x in 0..size {
            let i = (y * size + x) as usize;
            let dx = heights[(y * size + (x + 1) % size) as usize] - heights[(y * size + (x + size - 1) % size) as usize];
            let dy = heights[(((y + 1) % size) * size + x) as usize] - heights[(((y + size - 1) % size) * size + x) as usize];
            bytes[i * 4] = round(0.5 + dx * 2.5);
            bytes[i * 4 + 1] = round(0.5 + dy * 2.5);
            bytes[i * 4 + 2] = round(noise[i]);
            bytes[i * 4 + 3] = round(heights[i]);
        }
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use craftyap_core::world::generate_field;

    #[test]
    fn a_pool_has_a_surface_and_dry_ground_has_none() {
        let mut w = generate_field();
        assert!(mesh_water(&w, 2, 2).is_empty());
        for x in 34..40 {
            for z in 34..40 {
                w.set(x, 4, z, 19);
            }
        }
        let m = mesh_water(&w, 2, 2);
        assert!(!m.is_empty() && m.len().is_multiple_of(3));
        let top = m.iter().map(|v| v.pos[1]).fold(f32::MIN, f32::max);
        assert!(top > 4.5 && top < 5.01, "a source's surface sits near the cell top: {top}");
        assert!(m.iter().all(|v| v.pos.iter().chain(&v.nrm).chain(&v.look).all(|c| c.is_finite())));
    }

    #[test]
    fn a_shape_holding_water_is_meshed_as_that_water() {
        let mut w = generate_field();
        w.set_shaped(40, 4, 40, craftyap_core::world::id("stone"), 51); // a half block
        assert!(mesh_water(&w, 2, 2).is_empty());
        w.wet[World::index(40, 4, 40)] = 19;
        assert!(!mesh_water(&w, 2, 2).is_empty());
    }

    #[test]
    fn the_detail_texture_tiles_and_spans_its_range() {
        let t = detail_texture();
        assert_eq!(t.len(), (DETAIL * DETAIL * 4) as usize);
        let heights: Vec<u8> = t.chunks(4).map(|p| p[3]).collect();
        let (lo, hi) = (*heights.iter().min().unwrap(), *heights.iter().max().unwrap());
        assert!(hi - lo > 100, "heights vary: {lo}..{hi}");
        // slopes go both ways around flat (128), in both directions
        for c in 0..2 {
            assert!(t.chunks(4).any(|p| p[c] < 100) && t.chunks(4).any(|p| p[c] > 156), "channel {c}");
        }
    }
}
