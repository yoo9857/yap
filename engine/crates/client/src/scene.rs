//! Shared drawing types and the camera. N2 shows the island from an orbit camera (drag to turn,
//! pinch or wheel to zoom); the player and its follow camera replace it in N3.

use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};

/// One terrain vertex, 28 bytes (the island near the castle is ~900k of them: at 56 bytes the
/// first upload was 50 MB and stalled a phone-class GPU for most of a second).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Debug, PartialEq)]
pub struct Vertex {
    pub pos: [f32; 3],
    /// Unit normal as snorm8 (w unused).
    pub nrm: [i8; 4],
    /// rgb: the tint in sRGB (the block colour, or white for blocks whose surface carries its
    /// colour; the shader linearises it); a: the layer of the surface texture array.
    pub look: [u8; 4],
    /// Surface texture coordinates: one tile per metre (the web's planar kit UVs). f32: world
    /// coordinates reach 160 m, past what f16 keeps to a texel.
    pub uv: [f32; 2],
}

impl Vertex {
    pub fn new(pos: [f32; 3], nrm: [f32; 3], tint: [u8; 3], layer: u8, uv: [f32; 2]) -> Self {
        let n = nrm.map(|c| (c.clamp(-1.0, 1.0) * 127.0).round() as i8);
        Self { pos, nrm: [n[0], n[1], n[2], 0], look: [tint[0], tint[1], tint[2], layer], uv }
    }
}

/// The vertex layout the terrain pipelines read.
pub const VERTEX_ATTRIBUTES: [wgpu::VertexAttribute; 4] = wgpu::vertex_attr_array![0 => Float32x3, 1 => Snorm8x4, 2 => Unorm8x4, 3 => Float32x2];


/// One brick top that carries studs: an instance of the Blender stud meshes (`studs.rs`, the
/// web's stud `InstancedMesh`es). 16 bytes; a grass chunk has ~250 of them.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Debug, PartialEq)]
pub struct StudInstance {
    /// The centre of the brick's top face.
    pub pos: [f32; 3],
    /// As `Vertex::look`: the top band's tint and surface layer.
    pub look: [u8; 4],
}

/// The stud instance layout (vertex buffer 1, stepped per instance).
pub const STUD_ATTRIBUTES: [wgpu::VertexAttribute; 2] = wgpu::vertex_attr_array![4 => Float32x3, 5 => Unorm8x4];

/// Studs are drawn within this many metres of the focus (voxelView.ts STUD_RANGE): 4 cm caps are
/// sub-pixel beyond it, and they would be most of the triangles.
pub const STUD_RANGE: f32 = 32.0;

/// A colour picked in sRGB (as on the web) to the linear value an sRGB surface expects.
pub fn linear(srgb: [f32; 3]) -> [f32; 3] {
    srgb.map(|c| if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) })
}

/// The web's default island seed (craftGame.ts DEFAULT_SEED).
pub const ISLAND_SEED: f64 = 20260718.0;

/// The web camera's lens (render/renderer.ts: PerspectiveCamera(70, aspect, 0.1, 400)).
pub const FOV_DEG: f32 = 70.0;
pub const NEAR: f32 = 0.1;
pub const FAR: f32 = 400.0;

/// A fixed view (eye, look direction, vertical fov in degrees): `tools/shot-native-compare.mjs`
/// records one from the web game so both renderers can be compared from the same camera.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FixedView {
    pub eye: Vec3,
    pub dir: Vec3,
    pub fov: f32,
}

impl FixedView {
    /// "ex,ey,ez,dx,dy,dz,fov"; None (with a log line) when malformed.
    pub fn parse(s: &str) -> Option<Self> {
        let n: Vec<f32> = s.split(',').map(|p| p.trim().parse::<f32>()).collect::<Result<_, _>>().ok()?;
        let [ex, ey, ez, dx, dy, dz, fov] = n[..] else { return None };
        let dir = Vec3::new(dx, dy, dz);
        (n.iter().all(|v| v.is_finite()) && dir.length() > 1e-6 && fov > 1.0 && fov < 179.0).then(|| Self { eye: Vec3::new(ex, ey, ez), dir: dir.normalize(), fov })
    }
}

/// An orbit camera around a focus point, or a fixed view.
pub struct Camera {
    pub focus: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub distance: f32,
    pub fixed: Option<FixedView>,
}

impl Default for Camera {
    fn default() -> Self {
        // the castle (CASTLE_CENTER 40) seen from the south lawn, like the web's first view
        Self { focus: Vec3::new(40.0, 14.0, 44.0), yaw: 1.2, pitch: 0.42, distance: 70.0, fixed: None }
    }
}

impl Camera {
    pub fn drag(&mut self, dx: f32, dy: f32) {
        self.yaw -= dx * 0.006;
        self.pitch = (self.pitch + dy * 0.005).clamp(0.08, 1.45);
    }

    /// Zoom by a factor (pinch ratio or a wheel step), kept between a close look and the whole map.
    pub fn zoom(&mut self, factor: f32) {
        self.distance = (self.distance * factor).clamp(8.0, 220.0);
    }

    pub fn eye(&self) -> Vec3 {
        if let Some(f) = &self.fixed {
            return f.eye;
        }
        self.focus + Vec3::new(self.yaw.cos() * self.pitch.cos(), self.pitch.sin(), self.yaw.sin() * self.pitch.cos()) * self.distance
    }

    pub fn view_proj(&self, aspect: f32) -> Mat4 {
        // wgpu clip space: depth 0..1, Y up (glam's "directx" projection)
        let (fov, target) = match &self.fixed {
            Some(f) => (f.fov, f.eye + f.dir),
            None => (FOV_DEG, self.focus),
        };
        glam::camera::rh::proj::directx::perspective(fov.to_radians(), aspect.max(0.01), NEAR, FAR) * glam::camera::rh::view::look_at_mat4(self.eye(), target, Vec3::Y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vertex_is_28_bytes_and_packs_its_normal() {
        assert_eq!(std::mem::size_of::<Vertex>(), 28);
        let v = Vertex::new([1.0, 2.0, 3.0], [0.0, 1.0, -1.0], [10, 20, 30], 7, [0.5, 160.25]);
        assert_eq!(v.nrm, [0, 127, -127, 0]);
        assert_eq!(v.look, [10, 20, 30, 7]);
    }

    #[test]
    fn fixed_views_parse_or_are_refused() {
        let v = FixedView::parse("39.9,22.9,64.3,0,-0.2474,0.9689,70").unwrap();
        assert_eq!(v.fov, 70.0);
        assert!((v.dir.length() - 1.0).abs() < 1e-5);
        for bad in ["", "1,2,3", "1,2,3,0,0,0,70", "1,2,3,0,1,0,0", "a,b,c,d,e,f,g", "1,2,3,0,1,0,70,9", "1,2,NaN,0,1,0,70"] {
            assert!(FixedView::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn zoom_and_pitch_stay_in_range() {
        let mut c = Camera::default();
        for _ in 0..100 {
            c.zoom(2.0);
            c.drag(0.0, 1000.0);
        }
        assert_eq!(c.distance, 220.0);
        assert!(c.pitch <= 1.45);
        for _ in 0..100 {
            c.zoom(0.1);
        }
        assert_eq!(c.distance, 8.0);
    }
}
