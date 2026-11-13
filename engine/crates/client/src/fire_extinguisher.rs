#![allow(clippy::chunks_exact_to_as_chunks, clippy::too_many_arguments)]
//! The same articulated Blender extinguisher on native platforms (metres, Y up).
use crate::{
    furniture::FurnitureVertex as Vertex,
    ui::{Painter, Rect},
};
use glam::{Mat4, Quat, Vec3};
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct Part {
    name: String,
    start: usize,
    count: usize,
    pivot: [f32; 3],
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    grip: [f32; 3],
    nozzle_pivot: [f32; 3],
    nozzle_tip: [f32; 3],
    hose_anchor: [f32; 3],
    hose_direction: [f32; 3],
    hose_radius: f32,
    nozzle_inlet: [f32; 3],
    parts: Vec<Part>,
}
struct Model {
    vertices: Vec<Vertex>,
    meta: Metadata,
}
fn data() -> &'static Model {
    static MODEL: OnceLock<Model> = OnceLock::new();
    MODEL.get_or_init(|| {
        let raw = include_bytes!("../../../assets/fire-extinguisher/model.bin");
        let vertices = raw
            .chunks_exact(28)
            .map(|b| {
                let f = |i| f32::from_le_bytes(b[i..i + 4].try_into().expect("float"));
                Vertex {
                    pos: [f(0), f(4), f(8)],
                    nrm: [f(12), f(16), f(20)],
                    color: [b[24], b[25], b[26], b[27]],
                }
            })
            .collect();
        Model {
            vertices,
            meta: serde_json::from_str(include_str!(
                "../../../assets/fire-extinguisher/parts.json"
            ))
            .expect("extinguisher parts"),
        }
    })
}
pub fn grip() -> Vec3 {
    Vec3::from(data().meta.grip)
}
pub fn nozzle_pivot() -> Vec3 {
    Vec3::from(data().meta.nozzle_pivot)
}
/// Returns the actual nozzle tip and its forward vector, in the caller's coordinate system.
pub fn mesh(
    body: Mat4,
    pin_out: f32,
    squeeze: f32,
    nozzle: Option<(Vec3, Vec3)>,
    out: &mut Vec<Vertex>,
) -> (Vec3, Vec3) {
    mesh_with_pin(body, pin_out, squeeze, nozzle, out, false, None)
}
/// The hand closes on the grip, a little ahead of the moving nozzle pivot.
pub(crate) fn carry(
    body: Mat4,
    squeeze: f32,
    hand: Vec3,
    aim: Vec3,
    forward: Vec3,
    out: &mut Vec<Vertex>,
) -> (Vec3, Vec3) {
    let pivot = hand - (aim - hand).normalize_or(Vec3::Z) * 0.036;
    mesh_with_pin(
        body,
        1.,
        squeeze,
        Some((pivot, aim)),
        out,
        false,
        Some(forward),
    )
}

fn mesh_with_pin(
    body: Mat4,
    pin_out: f32,
    squeeze: f32,
    nozzle: Option<(Vec3, Vec3)>,
    out: &mut Vec<Vertex>,
    retain_pin: bool,
    hose_forward: Option<Vec3>,
) -> (Vec3, Vec3) {
    let model = data();
    let squeeze = if pin_out >= 0.99 {
        squeeze.clamp(0., 1.)
    } else {
        0.
    };
    let nozzle_matrix = nozzle
        .map(|(hand, aim)| {
            Mat4::from_translation(hand)
                * Mat4::from_quat(Quat::from_rotation_arc(
                    Vec3::Z,
                    (aim - hand).normalize_or_zero(),
                ))
                * Mat4::from_translation(-nozzle_pivot())
        })
        .unwrap_or(body);
    for part in &model.meta.parts {
        let pivot = Vec3::from(part.pivot);
        let matrix = match part.name.as_str() {
            "SafetyPin" if pin_out >= 0.99 && !retain_pin => continue,
            "SafetyPin" if pin_out >= 0.99 => {
                body * Mat4::from_translation(Vec3::new(0.24, 0.012, 0.13))
                    * Mat4::from_rotation_x(-std::f32::consts::FRAC_PI_2)
                    * Mat4::from_translation(-pivot)
            }
            "SafetyPin" => body * Mat4::from_translation(Vec3::X * 0.136 * pin_out),
            "Lever" => {
                body * Mat4::from_translation(pivot)
                    * Mat4::from_rotation_x(0.20 * squeeze)
                    * Mat4::from_translation(-pivot)
            }
            "Hose" if nozzle.is_some() => continue,
            "Nozzle" => nozzle_matrix,
            _ => body,
        };
        for v in &model.vertices[part.start..part.start + part.count] {
            out.push(Vertex {
                pos: matrix.transform_point3(Vec3::from(v.pos)).to_array(),
                nrm: matrix
                    .transform_vector3(Vec3::from(v.nrm))
                    .normalize_or_zero()
                    .to_array(),
                color: v.color,
            });
        }
    }
    if nozzle.is_some() {
        hose(
            body.transform_point3(Vec3::from(model.meta.hose_anchor)),
            nozzle_matrix.transform_point3(nozzle_pivot() + Vec3::from(model.meta.nozzle_inlet)),
            body.transform_vector3(Vec3::from(model.meta.hose_direction)),
            nozzle_matrix.transform_vector3(Vec3::Z),
            model.meta.hose_radius,
            hose_forward.map_or(Vec3::Y * -0.112, |forward| {
                forward * 0.216 - Vec3::Y * 0.052
            }),
            out,
        );
    }
    let tip = nozzle_matrix.transform_point3(nozzle_pivot() + Vec3::from(model.meta.nozzle_tip));
    (
        tip,
        nozzle_matrix.transform_vector3(Vec3::Z).normalize_or_zero(),
    )
}
fn hose(
    a: Vec3,
    c: Vec3,
    start_dir: Vec3,
    end_dir: Vec3,
    radius: f32,
    clearance: Vec3,
    out: &mut Vec<Vertex>,
) {
    const SEGMENTS: usize = 24;
    const SIDES: usize = 10;
    let bend = (a.distance(c) * 0.24).clamp(0.036, 0.104);
    let b = a + start_dir * bend;
    let d = c - end_dir * bend;
    let mut rings = Vec::new();
    let mut right = Vec3::ZERO;
    for i in 0..=SEGMENTS {
        let t = i as f32 / SEGMENTS as f32;
        let s = 1. - t;
        let at = a * s * s * s
            + b * 3. * s * s * t
            + d * 3. * s * t * t
            + c * t * t * t
            + clearance * 16. * s * s * t * t;
        let tangent = ((b - a) * 3. * s * s
            + (d - b) * 6. * s * t
            + (c - d) * 3. * t * t
            + clearance * 32. * s * t * (1. - 2. * t))
            .normalize_or_zero();
        right -= tangent * right.dot(tangent);
        if right.length_squared() < 0.001 {
            right = tangent.cross(if tangent.y.abs() > 0.95 {
                Vec3::Z
            } else {
                Vec3::Y
            });
        }
        right = right.normalize_or_zero();
        let up = right.cross(tangent);
        for j in 0..SIDES {
            let angle = j as f32 * std::f32::consts::TAU / SIDES as f32;
            let n = right * angle.cos() + up * angle.sin();
            rings.push(Vertex {
                pos: (at + n * radius).to_array(),
                nrm: n.to_array(),
                color: [38, 56, 66, 255],
            });
        }
    }
    for i in 0..SEGMENTS {
        for j in 0..SIDES {
            let a = i * SIDES + j;
            let b = i * SIDES + (j + 1) % SIDES;
            for k in [a, a + SIDES, b, b, a + SIDES, b + SIDES] {
                out.push(rings[k]);
            }
        }
    }
}
/// Depth-sorted projection of the actual mesh, so Android's lesson shows the movable parts too.
pub fn preview(
    p: &mut Painter,
    rect: Rect,
    pin: f32,
    squeeze: f32,
    aimed: f32,
    focus: u8,
    time: f32,
    sweep: f32,
    powder: &mut crate::fire_powder::Powder,
    dt: f64,
) -> ([f32; 2], [f32; 2]) {
    let mut mesh_data = Vec::new();
    let (tip, direction) = mesh_with_pin(
        Mat4::IDENTITY,
        pin,
        squeeze,
        (aimed > 0.).then_some((
            Vec3::new(0.112, 0.216, 0.176).lerp(Vec3::new(0.28, 0.28, 0.05), aimed),
            Vec3::new(0.48 + sweep * 0.30, 0.02, 0.02),
        )),
        &mut mesh_data,
        true,
        None,
    );
    let rotation = Quat::from_rotation_x(0.12) * Quat::from_rotation_y(-0.55);
    let view = Vec3::Z;
    let close = focus < 2;
    let scale = if focus == 1 {
        (rect.h / 0.19).min(rect.w / 0.36)
    } else if focus == 3 {
        (rect.h / 0.44).min(rect.w / 0.64)
    } else if close {
        (rect.h / 0.27).min(rect.w / 0.43)
    } else {
        (rect.h / 0.65).min(rect.w / 0.95)
    };
    let centre = if focus == 1 {
        Vec3::new(0.02 + pin * 0.08, 0.515, 0.03)
    } else if focus == 3 {
        Vec3::new(0.17, 0.36, 0.06)
    } else if close {
        Vec3::new(0., 0.47, 0.03)
    } else {
        Vec3::new(0.20, 0.26, 0.)
    };
    let project = |point: Vec3| {
        let v = rotation * (point - centre);
        [
            rect.x + rect.w * 0.5 + v.x * scale,
            rect.y + rect.h * 0.5 - v.y * scale,
        ]
    };
    let mut triangles = mesh_data
        .chunks_exact(3)
        .filter(|tri| rotation.mul_vec3(Vec3::from(tri[0].nrm)).dot(view) > -0.1)
        .collect::<Vec<_>>();
    triangles.sort_by(|a, b| {
        let depth = |t: &[Vertex]| {
            t.iter()
                .map(|v| rotation.mul_vec3(Vec3::from(v.pos)).z)
                .sum::<f32>()
        };
        depth(a).total_cmp(&depth(b))
    });
    let light = Vec3::new(-0.3, 0.8, 0.6).normalize();
    for tri in triangles {
        let points = std::array::from_fn(|i| {
            let v = rotation * (Vec3::from(tri[i].pos) - centre);
            [
                rect.x + rect.w * 0.5 + v.x * scale,
                rect.y + rect.h * 0.5 - v.y * scale,
            ]
        });
        let mut color = tri[0].color;
        let shade = 0.62 + 0.38 * (rotation * Vec3::from(tri[0].nrm)).dot(light).max(0.);
        for channel in &mut color[..3] {
            *channel = (*channel as f32 * shade) as u8;
        }
        p.triangle_in(rect, points, color);
    }
    let marker = project(match focus {
        0 => Vec3::new(0.0288, 0.4384, 0.1112),
        1 => Vec3::new(0.0584 + pin * 0.136, 0.508, 0.028),
        3 => Vec3::new(0., 0.52, 0.07),
        _ => {
            if aimed > 0. {
                Vec3::new(0.28, 0.28, 0.17)
            } else {
                Vec3::new(0.112, 0.216, 0.2984)
            }
        }
    });
    let fire = project(Vec3::new(0.65, 0.02, 0.02));
    if !close {
        p.disc(
            fire[0],
            fire[1] - 10.,
            14. + (time * 8.).sin() * 2.,
            [255, 142, 29, 255],
        );
        p.disc(fire[0], fire[1] - 6., 8., [255, 216, 59, 255]);
        p.ring(fire[0], fire[1] + 4., 23., 3., [27, 141, 89, 255]);
    }
    if focus < 4 && focus != 1 {
        p.ring(
            marker[0],
            marker[1],
            17. + (time * 5.).sin() * 2.,
            3.,
            [255, 205, 38, 255],
        );
        p.disc(marker[0], marker[1], 4., [255, 250, 227, 255]);
    }
    let range = tip.distance(Vec3::new(0.48 + sweep * 0.30, 0.02, 0.02));
    let spray = (squeeze > 0.1 && pin >= 0.99 && !close).then_some((
        tip.as_dvec3(),
        direction.as_dvec3(),
        f64::from(range),
    ));
    powder.step(dt, spray);
    for (position, size, color) in powder.visible() {
        let [x, y] = project(position.as_vec3());
        let radius = size as f32 * scale * 0.45;
        if x - radius >= rect.x
            && x + radius <= rect.x + rect.w
            && y - radius >= rect.y
            && y + radius <= rect.y + rect.h
        {
            p.disc(x, y, radius, color);
        }
    }
    (marker, fire)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lever_is_physically_locked_until_pin_is_withdrawn() {
        let mut a = vec![];
        let mut b = vec![];
        mesh(Mat4::IDENTITY, 0., 0., None, &mut a);
        mesh(Mat4::IDENTITY, 0., 1., None, &mut b);
        assert_eq!(
            bytemuck::cast_slice::<Vertex, u8>(&a),
            bytemuck::cast_slice::<Vertex, u8>(&b)
        );
    }
    #[test]
    fn nozzle_tip_follows_the_other_hand_and_aim() {
        let hand = Vec3::new(-0.3, 1.1, 0.3);
        let aim = Vec3::new(0., 0.4, 3.);
        let mut out = vec![];
        let (tip, dir) = mesh(Mat4::IDENTITY, 1., 1., Some((hand, aim)), &mut out);
        assert!((dir - (aim - hand).normalize()).length() < 1e-5);
        assert!((tip - hand).length() > 0.12);
        assert!((tip - hand).cross(dir).length() < 1e-5);
        assert!(out.iter().all(|v| Vec3::from(v.pos).is_finite()));
    }
    #[test]
    fn exported_asset_is_human_scale_and_parts_are_complete() {
        let m = data();
        for name in ["Body", "SafetyPin", "Lever", "Hose", "Nozzle"] {
            assert!(m.meta.parts.iter().any(|p| p.name == name && p.count > 0));
        }
        let height = m.vertices.iter().map(|v| v.pos[1]).fold(0., f32::max);
        assert!((0.50..=0.57).contains(&height));
        assert_eq!(
            m.vertices.len() * 28,
            include_bytes!("../../../assets/fire-extinguisher/model.bin").len()
        );
    }
}
