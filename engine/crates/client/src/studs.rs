//! The brick-top studs: the Blender asset `assets/blocks/studs` (block-studs.glb), the SAME file
//! the web game loads (apps/client/src/craft/blockStuds.ts). Two meshes, each a whole 1 m top
//! (four studs), origin at the centre of the top face, +Y up:
//! - `Stud_HQ`: the original (568 triangles), drawn within `HQ_DISTANCE` of the focus;
//! - `Stud_LOD1`: the same silhouette at 8 segments without the sub-centimetre bevels (152), out to
//!   `scene::STUD_RANGE`.
//!
//! The GLB is compiled in, so a phone needs no file access for it; a GLB this code cannot read is
//! a build-time test failure (`the_shipped_glb_reads`), never a runtime surprise.

use crate::scene::Vertex;
use anyhow::{anyhow, bail, Context, Result};

/// The GLB both renderers draw (the web serves this very file).
pub const GLB: &[u8] = include_bytes!("../../../../apps/client/public/models/blocks/block-studs.glb");

/// assets/blocks/studs/runtime/manifest.json `lodDistance` (blockStuds.ts STUD_HQ_DISTANCE).
pub const HQ_DISTANCE: f32 = 12.0;

/// One stud mesh: vertices and triangle indices.
pub struct StudMesh {
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u16>,
}

pub struct Studs {
    pub hq: StudMesh,
    pub lod: StudMesh,
}

/// Read both meshes out of a GLB.
pub fn parse(glb: &[u8]) -> Result<Studs> {
    let u32_at = |o: usize| -> Result<u32> { Ok(u32::from_le_bytes(glb.get(o..o + 4).ok_or_else(|| anyhow!("GLB truncated at {o}"))?.try_into()?)) };
    if glb.get(0..4) != Some(b"glTF") || u32_at(8)? as usize != glb.len() {
        bail!("not a GLB (or its length field is wrong)");
    }
    let json_len = u32_at(12)? as usize;
    let json: serde_json::Value = serde_json::from_slice(glb.get(20..20 + json_len).context("JSON chunk")?).context("GLB JSON")?;
    let bin_at = 20 + json_len;
    let bin_len = u32_at(bin_at)? as usize;
    let bin = glb.get(bin_at + 8..bin_at + 8 + bin_len).context("BIN chunk")?;

    let accessor = |i: &serde_json::Value| -> Result<(&[u8], usize, u64, usize)> {
        let a = &json["accessors"][i.as_u64().context("accessor index")? as usize];
        let v = &json["bufferViews"][a["bufferView"].as_u64().context("bufferView")? as usize];
        let start = (v["byteOffset"].as_u64().unwrap_or(0) + a["byteOffset"].as_u64().unwrap_or(0)) as usize;
        let count = a["count"].as_u64().context("count")? as usize;
        let comps = match a["type"].as_str() {
            Some("SCALAR") => 1,
            Some("VEC2") => 2,
            Some("VEC3") => 3,
            other => bail!("accessor type {other:?}"),
        };
        let kind = a["componentType"].as_u64().context("componentType")?;
        let size = match kind {
            5126 | 5125 => 4,
            5123 => 2,
            other => bail!("component type {other}"),
        };
        if v["byteStride"].as_u64().is_some_and(|s| s as usize != comps * size) {
            bail!("interleaved buffer views are not read here");
        }
        let bytes = bin.get(start..start + count * comps * size).context("accessor outside the BIN chunk")?;
        Ok((bytes, comps, kind, count))
    };
    let floats = |i: &serde_json::Value, want: usize| -> Result<Vec<f32>> {
        let (bytes, comps, kind, _) = accessor(i)?;
        if kind != 5126 || comps != want {
            bail!("expected float VEC{want}");
        }
        Ok(bytes.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect())
    };

    let mesh = |name: &str| -> Result<StudMesh> {
        let m = json["meshes"].as_array().context("meshes")?.iter().find(|m| m["name"] == name).ok_or_else(|| anyhow!("no mesh {name}"))?;
        let p = &m["primitives"][0];
        let pos = floats(&p["attributes"]["POSITION"], 3)?;
        let nrm = floats(&p["attributes"]["NORMAL"], 3)?;
        if nrm.len() != pos.len() {
            bail!("{name}: normals do not match positions");
        }
        let (bytes, _, kind, count) = accessor(&p["indices"])?;
        let indices: Vec<u16> = match kind {
            5123 => bytes.as_chunks::<2>().0.iter().map(|b| u16::from_le_bytes(*b)).collect(),
            5125 => bytes.as_chunks::<4>().0.iter().map(|b| u32::from_le_bytes(*b)).map(u16::try_from).collect::<Result<_, _>>()?,
            _ => bail!("{name}: index type {kind}"),
        };
        let n = pos.len() / 3;
        if count % 3 != 0 || indices.iter().any(|&i| i as usize >= n) {
            bail!("{name}: bad triangle list");
        }
        // studs take world-planar texture coordinates in the shader: the GLB's uv is not needed
        let vertices = (0..n).map(|k| Vertex::new([pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]], [nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]], [255; 3], 0, [0.0; 2])).collect();
        Ok(StudMesh { vertices, indices })
    };
    Ok(Studs { hq: mesh("Stud_HQ")?, lod: mesh("Stud_LOD1")? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_glb_reads() {
        let s = parse(GLB).expect("block-studs.glb");
        // assets/blocks/studs/runtime/manifest.json
        assert_eq!(s.hq.indices.len() / 3, 568);
        assert_eq!(s.lod.indices.len() / 3, 152);
        for m in [&s.hq, &s.lod] {
            for v in &m.vertices {
                // four 20 cm studs on 0.5 m centres, 4 cm tall, standing on the top face
                assert!(v.pos[1] > -1e-4 && v.pos[1] < 0.0401, "{:?}", v.pos);
                assert!(v.pos[0].abs() < 0.351 && v.pos[2].abs() < 0.351, "{:?}", v.pos);
                // every face looks away from its stud: up, or out from the stud's axis (the base
                // flare of the original, r 9.8 -> 10 cm, faces out and slightly down)
                let (ox, oz) = (0.25f32.copysign(v.pos[0]), 0.25f32.copysign(v.pos[2]));
                let out = (v.pos[0] - ox) * v.nrm[0] as f32 + (v.pos[2] - oz) * v.nrm[2] as f32;
                assert!(v.nrm[1] > 0 || out > 0.0, "{:?} {:?}", v.pos, v.nrm);
            }
        }
    }

    #[test]
    fn broken_files_are_refused() {
        assert!(parse(b"").is_err());
        assert!(parse(b"glTFxxxxxxxxxxxxxxxx").is_err());
        let mut cut = GLB.to_vec();
        cut.truncate(GLB.len() / 2);
        assert!(parse(&cut).is_err());
    }
}
