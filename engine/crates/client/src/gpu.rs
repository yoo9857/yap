//! The GPU side, split by lifetime (Android destroys the native window on every pause):
//! - `Renderer` lives as long as the GPU device: instance, adapter, device, the terrain mesh, the
//!   pipeline. A pause does not touch it, so a resume costs a surface, not a device.
//! - `Target` lives as long as one window: the surface, its configuration, depth and MSAA targets.
//!   `detach` drops it on pause, `attach` builds a new one on resume.
//!
//! Recovery: an outdated or lost SURFACE is reconfigured and the frame skipped; a timed-out frame is
//! skipped; a lost DEVICE (driver reset, GPU hang) is flagged by wgpu's callback, `render` reports
//! it, and the app builds a new `Renderer`.

use crate::chunks::CHUNK;
use crate::quality::Settings;
use crate::scene::{self, StudInstance, Vertex, STUD_RANGE};
use crate::studs;
use crate::ui::{UiVertex, UI_ATTRIBUTES};
use crate::surfaces::SurfaceMaps;
use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use wgpu::util::DeviceExt;
use winit::window::Window;

/// craftGame.ts's sky: FOG_COLOR at the horizon (the fog fades into it), SKY_TOP overhead, and
/// the island's linear fog (THREE.Fog(FOG_COLOR, 95, 245), on view depth).
const HORIZON: u32 = 0x9fd8f5;
const SKY_TOP: u32 = 0x6fbfee;
/// craftGame.ts view distance, the island's "Normal" preset (VIEW_PRESETS.island[1] = 88 m):
/// fog thickens from 45% of it and is opaque exactly at it; chunks stop being drawn 8 m past it
/// (voxelView setRenderDistance), so the far terrain fades out instead of popping at a cut.
pub const VIEW_DISTANCE: f32 = 88.0;
const FOG_NEAR: f32 = VIEW_DISTANCE * 0.45;
const FOG_FAR: f32 = VIEW_DISTANCE;
const RENDER_DISTANCE: f32 = VIEW_DISTANCE + 8.0;

/// A web hex colour (sRGB) as the linear RGBA an sRGB surface expects.
fn hex(c: u32) -> [f32; 4] {
    let [r, g, b] = scene::linear([(c >> 16) as f32 / 255.0, ((c >> 8) & 255) as f32 / 255.0, (c & 255) as f32 / 255.0]);
    [r, g, b, 1.0]
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Uniforms {
    view_proj: [[f32; 4]; 4],
    inv_view_proj: [[f32; 4]; 4],
    eye: [f32; 4],
    sun: [f32; 4],
    horizon: [f32; 4],
    top: [f32; 4],
    /// x: fog start, y: fog end (metres of view depth)
    fog: [f32; 4],
    /// xyz: the LOD/stud focus
    focus: [f32; 4],
    /// x: Stud_HQ out to here, y: Stud_LOD1 out to here (metres)
    studs: [f32; 4],
    /// The sun's shadow camera (renderer.ts sun.shadow.camera), world → light clip space.
    light: [[f32; 4]; 4],
    /// x: one shadow texel in uv, y: depth bias, z: 1 when shadows are on
    shadow: [f32; 4],
    /// waterMesh.ts uniforms: x uTime (s), yz uOrigin (the field window's absolute origin, mod 1024)
    water: [f32; 4],
}

/// renderer.ts: SUN_OFFSET and the shadow camera box (±22 m, near 1, far 120), bias -0.0004.
const SUN_OFFSET: glam::Vec3 = glam::Vec3::new(18.0, 35.0, 14.0);
const SHADOW_HALF: f32 = 22.0;
const SHADOW_NEAR: f32 = 1.0;
const SHADOW_FAR: f32 = 120.0;
const SHADOW_BIAS: f32 = 0.0004;

/// The sun's view-projection around `target`, its centre snapped to whole shadow texels in the
/// light's plane (renderer.ts trackTarget: a box sliding by fractions of a texel makes every
/// shadow edge crawl while walking).
pub fn light_matrix(target: glam::Vec3, map_size: u32) -> glam::Mat4 {
    let z = SUN_OFFSET.normalize();
    let x = glam::Vec3::Y.cross(z).normalize();
    let y = z.cross(x);
    let texel = 2.0 * SHADOW_HALF / map_size.max(1) as f32;
    let a = (target.dot(x) / texel).round() * texel;
    let b = (target.dot(y) / texel).round() * texel;
    let snapped = x * a + y * b + z * target.dot(z);
    let view = glam::camera::rh::view::look_at_mat4(snapped + SUN_OFFSET, snapped, glam::Vec3::Y);
    let proj = glam::camera::rh::proj::directx::orthographic(-SHADOW_HALF, SHADOW_HALF, -SHADOW_HALF, SHADOW_HALF, SHADOW_NEAR, SHADOW_FAR);
    proj * view
}

/// The shadow map (a 1 × 1 stand-in while shadows are off, so the bind group stays valid).
fn shadow_map(device: &wgpu::Device, size: u32) -> wgpu::TextureView {
    let size = size.max(1);
    device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some("shadow map"),
            size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth32Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
        .create_view(&Default::default())
}

/// What the terrain bind group is made of, kept to make it again (a new shadow map size).
struct TerrainInputs {
    surfaces: wgpu::TextureView,
    sampler: wgpu::Sampler,
    normals: wgpu::TextureView,
    orm: wgpu::TextureView,
    materials: wgpu::Buffer,
    shadow_sampler: wgpu::Sampler,
}

fn terrain_group(device: &wgpu::Device, layout: &wgpu::BindGroupLayout, uniforms: &wgpu::Buffer, i: &TerrainInputs, shadow: &wgpu::TextureView) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("uniforms"), layout, entries: &[
        wgpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&i.surfaces) },
        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&i.sampler) },
        wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&i.normals) },
        wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&i.orm) },
        wgpu::BindGroupEntry { binding: 5, resource: i.materials.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::TextureView(shadow) },
        wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::Sampler(&i.shadow_sampler) },
    ] })
}

/// The pipelines for one (surface format, sample count).
struct Pipelines {
    format: wgpu::TextureFormat,
    samples: u32,
    terrain: wgpu::RenderPipeline,
    /// See-through blocks: blended, depth-tested but not written (drawn after the opaque world).
    clear: wgpu::RenderPipeline,
    ghost: wgpu::RenderPipeline,
    /// The Blender studs instanced on brick tops: the original near, the light form farther.
    stud_hq: wgpu::RenderPipeline,
    /// The HOME / TT characters (character.rs): CPU-skinned, lit like the terrain, their face texture.
    character: wgpu::RenderPipeline,
    /// Furniture (furniture.rs): one baked, vertex-coloured mesh, lit like the characters.
    furniture: wgpu::RenderPipeline,
    campus_clear: wgpu::RenderPipeline,
    fire_fx: wgpu::RenderPipeline,
    shadow_furniture: wgpu::RenderPipeline,
    /// The water surface (waterMesh.ts): blended, no depth write, both faces, after the glass.
    water: wgpu::RenderPipeline,
    stud_lod: wgpu::RenderPipeline,
    sky: wgpu::RenderPipeline,
    /// The screen overlay (ui.wgsl): blended, no depth.
    ui: wgpu::RenderPipeline,
    /// Depth only, from the sun: blocks and characters (studs cast no shadow, like the web).
    shadow_terrain: wgpu::RenderPipeline,
    shadow_char: wgpu::RenderPipeline,
}

/// What a frame did, for the app to act on.
pub enum Frame {
    Drawn,
    Skipped,
    /// The device is gone: build a new renderer.
    DeviceLost,
}

fn backends() -> wgpu::Backends {
    // Android: Vulkan where it works, GLES on the low-end phones whose Vulkan drivers do not
    if cfg!(target_os = "android") {
        wgpu::Backends::VULKAN | wgpu::Backends::GL
    } else {
        wgpu::Backends::PRIMARY | wgpu::Backends::GL
    }
}

/// The web's opacity for see-through blocks (voxelView.ts makeMaterial).
pub const CLEAR_OPACITY: f64 = 0.55;

/// A vertex buffer rewritten every frame: grown when too small, never shrunk.
#[derive(Default)]
struct Dynamic {
    buffer: Option<wgpu::Buffer>,
    count: u32,
}

impl Dynamic {
    fn write<T: bytemuck::Pod>(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, items: &[T], label: &str) {
        self.count = items.len() as u32;
        if items.is_empty() {
            return;
        }
        let bytes: &[u8] = bytemuck::cast_slice(items);
        if self.buffer.as_ref().is_none_or(|b| b.size() < bytes.len() as u64) {
            let size = (bytes.len() as u64).next_power_of_two().max(4096);
            self.buffer = Some(device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }));
        }
        if let Some(b) = &self.buffer {
            queue.write_buffer(b, 0, bytes);
        }
    }
    fn draw<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        if let (Some(b), true) = (&self.buffer, self.count > 0) {
            pass.set_vertex_buffer(0, b.slice(..));
            pass.draw(0..self.count, 0..1);
        }
    }
}

/// An sRGB RGBA texture with the given mip levels below level 0.
fn upload_rgba(device: &wgpu::Device, queue: &wgpu::Queue, label: &str, w: u32, h: u32, rgba: &[u8], mips: &[(u32, u32, Vec<u8>)]) -> wgpu::Texture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1 + mips.len() as u32,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8UnormSrgb,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let levels = std::iter::once((w, h, rgba)).chain(mips.iter().map(|(w, h, px)| (*w, *h, px.as_slice())));
    for (level, (lw, lh, px)) in levels.enumerate() {
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: level as u32, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            px,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(lw * 4), rows_per_image: Some(lh) },
            wgpu::Extent3d { width: lw, height: lh, depth_or_array_layers: 1 },
        );
    }
    texture
}

fn ui_group(device: &wgpu::Device, layout: &wgpu::BindGroupLayout, atlas: &wgpu::Texture, picture: &wgpu::Texture, sampler: &wgpu::Sampler) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("ui"),
        layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&atlas.create_view(&Default::default())) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&picture.create_view(&Default::default())) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(sampler) },
        ],
    })
}

/// A vertex buffer and its vertex count (none when the list was empty).
type Mesh = Option<(wgpu::Buffer, u32)>;

/// One chunk form on the GPU: its opaque and its see-through triangles.
struct Form {
    opaque: Mesh,
    clear: Mesh,
}

/// One chunk on the GPU: its near and far forms (both kept, so a LOD flip is a swap) and which
/// one is wanted. A form not uploaded yet falls back to the other.
#[derive(Default)]
struct ChunkGpu {
    near: Option<Form>,
    far: Option<Form>,
    want_far: bool,
    /// Stud instances (with the far form: every chunk has one).
    studs: Mesh,
    /// The water surface (with the far form).
    water: Mesh,
}

/// One window's presentation state.
struct Target {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    depth: wgpu::TextureView,
    msaa: Option<wgpu::TextureView>,
}

pub struct Renderer {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    shader: wgpu::ShaderModule,
    pipeline_layout: wgpu::PipelineLayout,
    pipeline: Option<Pipelines>,
    chunks: HashMap<(i32, i32), ChunkGpu>,
    /// The Blender stud meshes (`studs.rs`: Stud_HQ, Stud_LOD1) as vertex + index buffers and index
    /// count; None if the compiled-in GLB could not be read (no studs, logged).
    stud_meshes: [Option<(wgpu::Buffer, wgpu::Buffer, u32)>; 2],
    /// Per-frame geometry: the player's body (terrain vertices) and the overlay.
    actor: Dynamic,
    /// Character meshes this frame per model, and each model's face texture bind group.
    /// Characters by texture slot: HOME, TT, held items (the pickaxe's atlas), the player's own
    /// live face (face.rs).
    char_meshes: [Dynamic; 4],
    furniture: Dynamic,
    campus: Dynamic,
    campus_clear: Dynamic,
    fire_fx: Dynamic,
    fire_props: Dynamic,
    /// The pet (pet.rs): posed on the CPU every frame, drawn and shadowed like furniture.
    pets: Dynamic,
    /// The placement ghost (one cell's triangles, flat-tinted, drawn see-through).
    ghost: Dynamic,
    /// The water's detail texture (water.rs, waterMesh.ts waterDetail) and its clock (set by the app).
    water_group: wgpu::BindGroup,
    pub water_clock: [f32; 3],
    char_groups: [Option<wgpu::BindGroup>; 4],
    /// The live face's texture (written in place as the face changes).
    face_texture: Option<(wgpu::Texture, u32, u32)>,
    char_bgl: wgpu::BindGroupLayout,
    char_layout: wgpu::PipelineLayout,
    overlay: Dynamic,
    ui_shader: wgpu::ShaderModule,
    ui_layout: wgpu::PipelineLayout,
    /// The text atlas (text.rs: R8, ATLAS × ATLAS).
    atlas: wgpu::Texture,
    /// Overlay bind groups: the text atlas + one menu picture (art.rs) + the sampler, one per
    /// picture (by Art index; None until decoded), and `ui_plain` with a 1×1 white picture for
    /// segments that draw no picture.
    ui_bgl: wgpu::BindGroupLayout,
    ui_sampler: wgpu::Sampler,
    ui_plain: wgpu::BindGroup,
    ui_art: Vec<Option<wgpu::BindGroup>>,
    /// Which bind group each run of overlay vertices uses (from the painter).
    overlay_segments: Vec<(u32, Option<usize>)>,
    /// False while a full-screen menu is up: only the overlay is drawn.
    pub world_visible: bool,
    uniforms: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    terrain_bgl: wgpu::BindGroupLayout,
    terrain_inputs: TerrainInputs,
    /// The shadow map (size per preset; 0 = off), and the uniforms-only group its pass binds.
    shadow_size: u32,
    shadow_view: wgpu::TextureView,
    shadow_group: wgpu::BindGroup,
    shadow_layout: wgpu::PipelineLayout,
    target: Option<Target>,
    settings: Settings,
    lost: Arc<AtomicBool>,
    pub info: wgpu::AdapterInfo,
    pub limits: wgpu::Limits,
}

impl Renderer {
    /// A device that can draw to `window`, and the window attached. `display`: the event loop's
    /// display handle (GLES needs it to present: Android's EGL path).
    pub fn new(window: Arc<Window>, display: winit::event_loop::OwnedDisplayHandle, settings: Settings, maps: &SurfaceMaps) -> Result<Self> {
        let mut desc = wgpu::InstanceDescriptor::new_with_display_handle(Box::new(display));
        desc.backends = backends();
        let instance = wgpu::Instance::new(desc);
        let surface = instance.create_surface(window.clone()).context("create the window surface")?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
            apply_limit_buckets: false,
        }))
        .context("no GPU adapter can draw to this window")?;
        let info = adapter.get_info();
        log::info!("GPU: {} ({:?}, {:?})", info.name, info.backend, info.device_type);
        // ask for no more than the adapter has: GLES phones have small limits
        let required = wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits());
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("craftyap"),
            required_features: wgpu::Features::empty(),
            required_limits: required,
            ..Default::default()
        }))
        .context("open the GPU device")?;
        let lost = Arc::new(AtomicBool::new(false));
        {
            let lost = lost.clone();
            device.set_device_lost_callback(move |reason, message| {
                log::error!("GPU device lost ({reason:?}): {message}");
                lost.store(true, Ordering::SeqCst);
            });
        }
        device.on_uncaptured_error(Arc::new(|err| log::error!("GPU error: {err}")));

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("terrain"), source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()) });
        let (surfaces, sampler) = surface_textures(&device, &queue, maps);
        let normals = texture_array(&device, &queue, "normals", &maps.normals, crate::surfaces::DETAIL, wgpu::TextureFormat::Rgba8Unorm);
        let orm = texture_array(&device, &queue, "roughness", &maps.orm, crate::surfaces::DETAIL, wgpu::TextureFormat::Rgba8Unorm);
        // per layer: [roughness, metalness, normal strength, clearcoat], [emissive rgb, uses its picture]
        let plan = crate::looks::layers();
        let mut params = vec![[0f32; 4]; MAX_LAYERS * 3];
        for (i, layer) in plan.iter().enumerate().take(MAX_LAYERS) {
            params[i * 3..i * 3 + 3].copy_from_slice(&crate::looks::layer_params(*layer));
        }
        let materials = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("materials"), contents: bytemuck::cast_slice(&params), usage: wgpu::BufferUsages::UNIFORM });
        let uniforms = device.create_buffer(&wgpu::BufferDescriptor { label: Some("uniforms"), size: std::mem::size_of::<Uniforms>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("uniforms"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2Array, multisampled: false }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
                wgpu::BindGroupLayoutEntry { binding: 3, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2Array, multisampled: false }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 4, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2Array, multisampled: false }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 5, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 6, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 7, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison), count: None },
            ],
        });
        // hardware PCF: each comparison sample is already a 2 × 2 filtered test
        let shadow_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("shadow"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            compare: Some(wgpu::CompareFunction::LessEqual),
            ..Default::default()
        });
        let terrain_inputs = TerrainInputs { surfaces, sampler, normals, orm, materials, shadow_sampler };
        let shadow_size = settings.shadow_map;
        let shadow_view = shadow_map(&device, shadow_size);
        let bind_group = terrain_group(&device, &layout, &uniforms, &terrain_inputs, &shadow_view);
        let shadow_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("shadow"),
            entries: &[wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None }],
        });
        let shadow_group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("shadow"), layout: &shadow_bgl, entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() }] });
        let shadow_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("shadow"), bind_group_layouts: &[Some(&shadow_bgl)], ..Default::default() });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("terrain"), bind_group_layouts: &[Some(&layout)], ..Default::default() });
        let char_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("character"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        // the water detail: linear data (slopes, noise, heights), repeating, mipmapped
        let water_group = {
            let size = crate::water::DETAIL;
            let mut level = crate::water::detail_texture();
            let mut levels = vec![(size, level.clone())];
            let mut s = size;
            while s > 1 {
                let n = s / 2;
                let mut next = vec![0u8; (n * n * 4) as usize];
                for y in 0..n {
                    for x in 0..n {
                        for c in 0..4 {
                            let at = |xx: u32, yy: u32| level[((yy * s + xx) * 4 + c) as usize] as u32;
                            next[((y * n + x) * 4 + c) as usize] = ((at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1) + 2) / 4) as u8;
                        }
                    }
                }
                levels.push((n, next.clone()));
                level = next;
                s = n;
            }
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("water detail"),
                size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: 1 },
                mip_level_count: levels.len() as u32,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            for (mip, (w, px)) in levels.iter().enumerate() {
                queue.write_texture(
                    wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: mip as u32, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                    px,
                    wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: Some(*w) },
                    wgpu::Extent3d { width: *w, height: *w, depth_or_array_layers: 1 },
                );
            }
            let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("water detail"),
                address_mode_u: wgpu::AddressMode::Repeat,
                address_mode_v: wgpu::AddressMode::Repeat,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::MipmapFilterMode::Linear,
                ..Default::default()
            });
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("water"),
                layout: &char_bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&texture.create_view(&Default::default())) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) },
                ],
            })
        };
        let char_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("character"), bind_group_layouts: &[Some(&layout), Some(&char_bgl)], ..Default::default() });
        let limits = adapter.limits();
        let stud_meshes = match studs::parse(studs::GLB) {
            Ok(s) => [&s.hq, &s.lod].map(|m| {
                let v = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("stud"), contents: bytemuck::cast_slice(&m.vertices), usage: wgpu::BufferUsages::VERTEX });
                // a u16 index buffer must be a multiple of 4 bytes
                let mut idx = m.indices.clone();
                if idx.len() % 2 == 1 {
                    idx.push(0);
                }
                let i = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("stud"), contents: bytemuck::cast_slice(&idx), usage: wgpu::BufferUsages::INDEX });
                Some((v, i, m.indices.len() as u32))
            }),
            Err(e) => {
                log::error!("block-studs.glb: {e:#}; bricks are drawn without studs");
                [None, None]
            }
        };
        let ui_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("ui"), source: wgpu::ShaderSource::Wgsl(include_str!("ui.wgsl").into()) });
        let atlas = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("text atlas"),
            size: wgpu::Extent3d { width: crate::text::ATLAS, height: crate::text::ATLAS, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let ui_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("ui"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let ui_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("ui art"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let white = upload_rgba(&device, &queue, "ui plain", 1, 1, &[255, 255, 255, 255], &[]);
        let ui_plain = ui_group(&device, &ui_bgl, &atlas, &white, &ui_sampler);
        let ui_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("ui"), bind_group_layouts: &[Some(&ui_bgl)], ..Default::default() });
        let mut r = Self { instance, adapter, device, queue, shader, pipeline_layout, pipeline: None, chunks: HashMap::new(), stud_meshes, actor: Dynamic::default(), char_meshes: [Dynamic::default(), Dynamic::default(), Dynamic::default(), Dynamic::default()], furniture: Dynamic::default(), campus:Dynamic::default(),campus_clear:Dynamic::default(),fire_fx:Dynamic::default(),fire_props:Dynamic::default(), pets: Dynamic::default(), ghost: Dynamic::default(), water_group, water_clock: [0.0; 3], char_groups: [None, None, None, None], face_texture: None, char_bgl, char_layout, overlay: Dynamic::default(), ui_shader, ui_layout, atlas, ui_bgl, ui_sampler, ui_plain, ui_art: Vec::new(), overlay_segments: Vec::new(), world_visible: true, uniforms, bind_group, terrain_bgl: layout, terrain_inputs, shadow_size, shadow_view, shadow_group, shadow_layout, target: None, settings, lost, info, limits };
        r.attach_surface(surface, window.inner_size())?;
        Ok(r)
    }

    /// A chunk form finished meshing: upload it (an empty form uploads nothing but counts as built).
    /// `studs` arrive with the far form only (the near form's list is empty and ignored).
    #[allow(clippy::too_many_arguments)]
    pub fn upload(&mut self, cx: i32, cz: i32, far: bool, opaque: &[Vertex], clear: &[Vertex], studs: &[StudInstance], water: &[crate::water::WaterVertex]) {
        fn mesh<T: bytemuck::Pod>(device: &wgpu::Device, items: &[T], label: &str) -> Mesh {
            (!items.is_empty()).then(|| {
                let b = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: bytemuck::cast_slice(items), usage: wgpu::BufferUsages::VERTEX });
                (b, items.len() as u32)
            })
        }
        let form = Form { opaque: mesh(&self.device, opaque, "chunk"), clear: mesh(&self.device, clear, "chunk") };
        let studs = far.then(|| mesh(&self.device, studs, "studs"));
        let water = far.then(|| mesh(&self.device, water, "water"));
        let chunk = self.chunks.entry((cx, cz)).or_default();
        *(if far { &mut chunk.far } else { &mut chunk.near }) = Some(form);
        if let Some(s) = studs {
            chunk.studs = s;
        }
        if let Some(w) = water {
            chunk.water = w;
        }
    }

    /// A character model's face texture (once per device; mips like every picture).
    pub fn set_character_texture(&mut self, slot: usize, width: u32, height: u32, rgba: &[u8]) {
        let img = crate::art::Image { slot: 0, width, height, rgba: rgba.to_vec() };
        let texture = upload_rgba(&self.device, &self.queue, "character face", width, height, rgba, &img.mips());
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("character"),
            layout: &self.char_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&texture.create_view(&Default::default())) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.ui_sampler) },
            ],
        });
        if let Some(g) = self.char_groups.get_mut(slot) {
            *g = Some(group);
        }
    }

    /// The player's live face (slot 3): written into the same texture while its size holds.
    pub fn set_face_texture(&mut self, width: u32, height: u32, rgba: &[u8]) {
        let img = crate::art::Image { slot: 0, width, height, rgba: rgba.to_vec() };
        let mips = img.mips();
        if let Some((tex, w, h)) = &self.face_texture {
            if (*w, *h) == (width, height) {
                let level = |mip: u32, w: u32, h: u32, data: &[u8]| {
                    self.queue.write_texture(
                        wgpu::TexelCopyTextureInfo { texture: tex, mip_level: mip, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                        data,
                        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: Some(h) },
                        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                    );
                };
                level(0, width, height, rgba);
                for (i, (w, h, data)) in mips.iter().enumerate() {
                    level(i as u32 + 1, *w, *h, data);
                }
                return;
            }
        }
        let texture = upload_rgba(&self.device, &self.queue, "live face", width, height, rgba, &mips);
        self.char_groups[3] = Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("live face"),
            layout: &self.char_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&texture.create_view(&Default::default())) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.ui_sampler) },
            ],
        }));
        self.face_texture = Some((texture, width, height));
    }

    pub fn has_character_texture(&self, slot: usize) -> bool {
        self.char_groups.get(slot).is_some_and(Option::is_some)
    }

    /// The field's furniture (re-baked only when the layout or the window changes).
    pub fn set_furniture(&mut self, vertices: &[crate::furniture::FurnitureVertex]) {
        self.furniture.write(&self.device, &self.queue, vertices, "furniture");
    }
    pub fn set_campus(&mut self,opaque:&[crate::furniture::FurnitureVertex],glass:&[crate::furniture::FurnitureVertex]){
        self.campus.write(&self.device,&self.queue,opaque,"fire campus");
        self.campus_clear.write(&self.device,&self.queue,glass,"fire campus glass");
    }
    pub fn set_fire_props(&mut self,vertices:&[crate::furniture::FurnitureVertex]){self.fire_props.write(&self.device,&self.queue,vertices,"fire extinguisher");}
    pub fn set_fire_fx(&mut self,vertices:&[crate::furniture::FurnitureVertex]){self.fire_fx.write(&self.device,&self.queue,vertices,"fire effects");}

    /// The placement ghost (empty: none).
    pub fn set_ghost(&mut self, vertices: &[Vertex]) {
        self.ghost.write(&self.device, &self.queue, vertices, "ghost");
    }

    /// The pet this frame (world space, vertex-coloured: the furniture pipeline).
    pub fn set_pets(&mut self, vertices: &[crate::furniture::FurnitureVertex]) {
        self.pets.write(&self.device, &self.queue, vertices, "pets");
    }

    /// The characters of one model this frame (world-space, CPU-skinned).
    pub fn set_characters(&mut self, slot: usize, vertices: &[crate::character::CharVertex]) {
        if let Some(d) = self.char_meshes.get_mut(slot) {
            d.write(&self.device, &self.queue, vertices, "characters");
        }
    }

    /// The player's body this frame (terrain vertices, world space).
    pub fn set_actor(&mut self, vertices: &[Vertex]) {
        self.actor.write(&self.device, &self.queue, vertices, "actor");
    }

    /// A menu picture finished decoding (art.rs): upload it with its mip chain. A new device needs
    /// them all again (the app keeps the decoded pictures for that).
    pub fn add_art(&mut self, img: &crate::art::Image) {
        let mips = img.mips();
        let texture = upload_rgba(&self.device, &self.queue, "ui art", img.width, img.height, &img.rgba, &mips);
        let i = img.slot;
        if self.ui_art.len() <= i {
            self.ui_art.resize_with(i + 1, || None);
        }
        self.ui_art[i] = Some(ui_group(&self.device, &self.ui_bgl, &self.atlas, &texture, &self.ui_sampler));
    }

    /// How many chunks have a form on the GPU (the loading bar).
    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    /// The overlay this frame (ui.rs): vertices, the runs of them that sample each picture, and new glyphs.
    pub fn set_overlay(&mut self, vertices: &[UiVertex], segments: &[(u32, Option<usize>)], glyphs: &[crate::text::Upload]) {
        self.overlay_segments.clear();
        self.overlay_segments.extend_from_slice(segments);
        for g in glyphs {
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &self.atlas, mip_level: 0, origin: wgpu::Origin3d { x: g.x, y: g.y, z: 0 }, aspect: wgpu::TextureAspect::All },
                &g.data,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(g.w), rows_per_image: Some(g.h) },
                wgpu::Extent3d { width: g.w, height: g.h, depth_or_array_layers: 1 },
            );
        }
        self.overlay.write(&self.device, &self.queue, vertices, "overlay");
    }

    /// The surface size in physical pixels (None while detached).
    pub fn surface_size(&self) -> Option<(u32, u32)> {
        self.target.as_ref().map(|t| (t.config.width, t.config.height))
    }

    /// Forget every chunk (another world).
    pub fn clear_chunks(&mut self) {
        self.chunks.clear();
    }

    /// Which form a chunk should draw.
    pub fn want(&mut self, cx: i32, cz: i32, far: bool) {
        self.chunks.entry((cx, cz)).or_default().want_far = far;
    }

    /// Vertices drawn last frame (for the log / perf overlay).
    pub fn drawn_vertices(&self) -> u64 {
        self.chunks.values().filter_map(|c| Self::form(c)).flat_map(|f| [&f.opaque, &f.clear]).flatten().map(|m| m.1 as u64).sum()
    }

    fn form(c: &ChunkGpu) -> Option<&Form> {
        let (want, other) = if c.want_far { (&c.far, &c.near) } else { (&c.near, &c.far) };
        want.as_ref().or(other.as_ref())
    }

    /// A new window after a resume: same device, new surface.
    pub fn attach(&mut self, window: Arc<Window>) -> Result<()> {
        let surface = self.instance.create_surface(window.clone()).context("create the window surface")?;
        self.attach_surface(surface, window.inner_size())
    }

    /// The window is going away (a pause): drop everything that refers to it.
    pub fn detach(&mut self) {
        self.target = None;
    }

    /// New quality settings without a new device (the auto tuner, a settings change).
    pub fn set_settings(&mut self, settings: Settings) {
        self.settings = settings;
        if settings.shadow_map != self.shadow_size {
            self.shadow_size = settings.shadow_map;
            self.shadow_view = shadow_map(&self.device, self.shadow_size);
            self.bind_group = terrain_group(&self.device, &self.terrain_bgl, &self.uniforms, &self.terrain_inputs, &self.shadow_view);
        }
        if let Some(t) = &self.target {
            let (format, w, h) = (t.config.format, t.config.width, t.config.height);
            let samples = self.samples_for(format);
            self.ensure_pipeline(format, samples);
            if let Some(t) = &mut self.target {
                (t.depth, t.msaa) = targets(&self.device, format, w, h, samples);
            }
        }
    }

    fn samples_for(&self, format: wgpu::TextureFormat) -> u32 {
        let want = self.settings.msaa;
        if self.adapter.get_texture_format_features(format).flags.sample_count_supported(want) { want } else { 1 }
    }

    fn attach_surface(&mut self, surface: wgpu::Surface<'static>, size: winit::dpi::PhysicalSize<u32>) -> Result<()> {
        let caps = surface.get_capabilities(&self.adapter);
        let format = caps.formats.iter().copied().find(|f| f.is_srgb()).or_else(|| caps.formats.first().copied()).ok_or_else(|| anyhow!("the surface supports no format"))?;
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::AutoVsync,
            desired_maximum_frame_latency: 2,
            alpha_mode: caps.alpha_modes.first().copied().unwrap_or(wgpu::CompositeAlphaMode::Auto),
            color_space: wgpu::SurfaceColorSpace::Auto,
            // the UI pass blends in sRGB space, like a browser: it draws on a non-sRGB view of
            // the same image (where the platform can make one)
            view_formats: { let ui = self.ui_format(format); if ui != format { vec![ui] } else { vec![] } },
        };
        surface.configure(&self.device, &config);
        let samples = self.samples_for(format);
        self.ensure_pipeline(format, samples);
        let (depth, msaa) = targets(&self.device, format, config.width, config.height, samples);
        log::info!("surface {}x{} {:?}, {} samples", config.width, config.height, format, samples);
        self.target = Some(Target { surface, config, depth, msaa });
        Ok(())
    }

    /// The format the UI pass draws in: the surface's non-sRGB twin when the platform can view the
    /// surface that way. Blending then happens on sRGB values, as a browser blends CSS colours; on an
    /// sRGB view it happens in linear light, where an 88 % navy panel over the bright menu art shows
    /// the picture through it like a 50 % one, and the app could never match the web's look.
    fn ui_format(&self, format: wgpu::TextureFormat) -> wgpu::TextureFormat {
        let views = self.adapter.get_downlevel_capabilities().flags.contains(wgpu::DownlevelFlags::SURFACE_VIEW_FORMATS);
        if format.is_srgb() && views { format.remove_srgb_suffix() } else { format }
    }

    fn ensure_pipeline(&mut self, format: wgpu::TextureFormat, samples: u32) {
        if matches!(&self.pipeline, Some(p) if p.format == format && p.samples == samples) {
            return;
        }
        let terrain = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("terrain"),
            layout: Some(&self.pipeline_layout),
            vertex: wgpu::VertexState {
                module: &self.shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<Vertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &scene::VERTEX_ATTRIBUTES })],
            },
            fragment: Some(wgpu::FragmentState { module: &self.shader, entry_point: Some("fs"), compilation_options: Default::default(), targets: &[Some(format.into())] }),
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState { format: wgpu::TextureFormat::Depth32Float, depth_write_enabled: Some(true), depth_compare: Some(wgpu::CompareFunction::Less), stencil: Default::default(), bias: Default::default() }),
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            multiview_mask: None,
            cache: None,
        });
        let character = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("character"),
            layout: Some(&self.char_layout),
            vertex: wgpu::VertexState {
                module: &self.shader,
                entry_point: Some("char_vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<crate::character::CharVertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2] })],
            },
            fragment: Some(wgpu::FragmentState { module: &self.shader, entry_point: Some("char_fs"), compilation_options: Default::default(), targets: &[Some(format.into())] }),
            // the model is closed; back faces never show
            primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Back), ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState { format: wgpu::TextureFormat::Depth32Float, depth_write_enabled: Some(true), depth_compare: Some(wgpu::CompareFunction::Less), stencil: Default::default(), bias: Default::default() }),
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            multiview_mask: None,
            cache: None,
        });
        let shadow = |label: &str, entry: &str, stride: u64, attributes: &[wgpu::VertexAttribute]| {
            self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&self.shadow_layout),
                vertex: wgpu::VertexState {
                    module: &self.shader,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    buffers: &[Some(wgpu::VertexBufferLayout { array_stride: stride, step_mode: wgpu::VertexStepMode::Vertex, attributes })],
                },
                fragment: None,
                // both faces cast: thin walls and an open roof still throw their shadow
                primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
                // a little slope bias on top of the shader's constant one keeps sloped faces clean
                depth_stencil: Some(wgpu::DepthStencilState { format: wgpu::TextureFormat::Depth32Float, depth_write_enabled: Some(true), depth_compare: Some(wgpu::CompareFunction::Less), stencil: Default::default(), bias: wgpu::DepthBiasState { constant: 0, slope_scale: 1.5, clamp: 0.0 } }),
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let shadow_terrain = shadow("shadow terrain", "shadow_vs", std::mem::size_of::<Vertex>() as u64, &scene::VERTEX_ATTRIBUTES);
        let char_attrs = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2];
        let shadow_char = shadow("shadow character", "char_shadow_vs", std::mem::size_of::<crate::character::CharVertex>() as u64, &char_attrs);
        let furn_attrs = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Unorm8x4];
        let shadow_furniture = shadow("shadow furniture", "char_shadow_vs", std::mem::size_of::<crate::furniture::FurnitureVertex>() as u64, &furn_attrs);
        let furniture = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("furniture"),
            layout: Some(&self.pipeline_layout),
            vertex: wgpu::VertexState {
                module: &self.shader,
                entry_point: Some("furn_vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<crate::furniture::FurnitureVertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &furn_attrs })],
            },
            fragment: Some(wgpu::FragmentState { module: &self.shader, entry_point: Some("furn_fs"), compilation_options: Default::default(), targets: &[Some(format.into())] }),
            // tubs and basins are open (hollow parts): both faces draw
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState { format: wgpu::TextureFormat::Depth32Float, depth_write_enabled: Some(true), depth_compare: Some(wgpu::CompareFunction::Less), stencil: Default::default(), bias: Default::default() }),
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            multiview_mask: None,
            cache: None,
        });
        let fire_clear_pipeline=|entry:&str,label:&str|self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor{
            label:Some(label),layout:Some(&self.pipeline_layout),
            vertex:wgpu::VertexState{module:&self.shader,entry_point:Some("furn_vs"),compilation_options:Default::default(),buffers:&[Some(wgpu::VertexBufferLayout{array_stride:std::mem::size_of::<crate::furniture::FurnitureVertex>()as u64,step_mode:wgpu::VertexStepMode::Vertex,attributes:&furn_attrs})]},
            fragment:Some(wgpu::FragmentState{module:&self.shader,entry_point:Some(entry),compilation_options:Default::default(),targets:&[Some(wgpu::ColorTargetState{format,blend:Some(wgpu::BlendState::ALPHA_BLENDING),write_mask:wgpu::ColorWrites::ALL})]}),
            primitive:wgpu::PrimitiveState{cull_mode:None,..Default::default()},
            depth_stencil:Some(wgpu::DepthStencilState{format:wgpu::TextureFormat::Depth32Float,depth_write_enabled:Some(false),depth_compare:Some(wgpu::CompareFunction::LessEqual),stencil:Default::default(),bias:Default::default()}),
            multisample:wgpu::MultisampleState{count:samples,..Default::default()},multiview_mask:None,cache:None});
        let campus_clear=fire_clear_pipeline("furn_fs","campus windows");
        let fire_fx=fire_clear_pipeline("fire_fx_fs","fire smoke spray");
        let water_attrs = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x4, 3 => Float32x3, 4 => Float32x3];
        let water = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("water"),
            layout: Some(&self.char_layout),
            vertex: wgpu::VertexState {
                module: &self.shader,
                entry_point: Some("water_vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<crate::water::WaterVertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &water_attrs })],
            },
            fragment: Some(wgpu::FragmentState { module: &self.shader, entry_point: Some("water_fs"), compilation_options: Default::default(), targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })] }),
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState { format: wgpu::TextureFormat::Depth32Float, depth_write_enabled: Some(false), depth_compare: Some(wgpu::CompareFunction::Less), stencil: Default::default(), bias: Default::default() }),
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            multiview_mask: None,
            cache: None,
        });
        let clear = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("clear"),
            layout: Some(&self.pipeline_layout),
            vertex: wgpu::VertexState {
                module: &self.shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<Vertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &scene::VERTEX_ATTRIBUTES })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &self.shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState { format: wgpu::TextureFormat::Depth32Float, depth_write_enabled: Some(false), depth_compare: Some(wgpu::CompareFunction::Less), stencil: Default::default(), bias: Default::default() }),
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            multiview_mask: None,
            cache: None,
        });
        let ghost = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("ghost"),
            layout: Some(&self.pipeline_layout),
            vertex: wgpu::VertexState {
                module: &self.shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<Vertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &scene::VERTEX_ATTRIBUTES })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &self.shader,
                entry_point: Some("fs_ghost"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Back), ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState { format: wgpu::TextureFormat::Depth32Float, depth_write_enabled: Some(false), depth_compare: Some(wgpu::CompareFunction::LessEqual), stencil: Default::default(), bias: Default::default() }),
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            multiview_mask: None,
            cache: None,
        });
        let stud = |entry: &str| self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(entry),
            layout: Some(&self.pipeline_layout),
            vertex: wgpu::VertexState {
                module: &self.shader,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                buffers: &[
                    Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<Vertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &scene::VERTEX_ATTRIBUTES }),
                    Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<StudInstance>() as u64, step_mode: wgpu::VertexStepMode::Instance, attributes: &scene::STUD_ATTRIBUTES }),
                ],
            },
            fragment: Some(wgpu::FragmentState { module: &self.shader, entry_point: Some("fs"), compilation_options: Default::default(), targets: &[Some(format.into())] }),
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState { format: wgpu::TextureFormat::Depth32Float, depth_write_enabled: Some(true), depth_compare: Some(wgpu::CompareFunction::Less), stencil: Default::default(), bias: Default::default() }),
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            multiview_mask: None,
            cache: None,
        });
        let (stud_hq, stud_lod) = (stud("stud_hq_vs"), stud("stud_lod_vs"));
        let ui_format = self.ui_format(format);
        // gamma: the colours stay sRGB values end to end (the non-sRGB view); else the old linear path
        let gamma = !ui_format.is_srgb();
        let ui = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("ui"),
            layout: Some(&self.ui_layout),
            vertex: wgpu::VertexState {
                module: &self.ui_shader,
                entry_point: Some(if gamma { "vs_gamma" } else { "vs" }),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<UiVertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &UI_ATTRIBUTES })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &self.ui_shader,
                entry_point: Some(if gamma { "fs_gamma" } else { "fs" }),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: ui_format, blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            // its own pass after the world: single-sampled (every shape anti-aliases itself), no depth
            depth_stencil: None,
            multisample: wgpu::MultisampleState { count: 1, ..Default::default() },
            multiview_mask: None,
            cache: None,
        });
        // the sky: one full-screen triangle drawn first, behind everything (no depth write)
        let sky = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("sky"),
            layout: Some(&self.pipeline_layout),
            vertex: wgpu::VertexState { module: &self.shader, entry_point: Some("sky_vs"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState { module: &self.shader, entry_point: Some("sky_fs"), compilation_options: Default::default(), targets: &[Some(format.into())] }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: Some(wgpu::DepthStencilState { format: wgpu::TextureFormat::Depth32Float, depth_write_enabled: Some(false), depth_compare: Some(wgpu::CompareFunction::Always), stencil: Default::default(), bias: Default::default() }),
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            multiview_mask: None,
            cache: None,
        });
        self.pipeline = Some(Pipelines { format, samples, terrain, clear, ghost, stud_hq, stud_lod, character, furniture, campus_clear, fire_fx, shadow_furniture, water, sky, ui, shadow_terrain, shadow_char });
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return; // minimised: keep the old size until it comes back
        }
        let Some(t) = &mut self.target else { return };
        t.config.width = width;
        t.config.height = height;
        t.surface.configure(&self.device, &t.config);
        let samples = self.pipeline.as_ref().map_or(1, |p| p.samples);
        (t.depth, t.msaa) = targets(&self.device, t.config.format, width, height, samples);
    }

    pub fn render(&mut self, camera: &scene::Camera) -> Frame {
        if self.lost.load(Ordering::SeqCst) {
            return Frame::DeviceLost;
        }
        let (Some(t), Some(pipelines)) = (&self.target, &self.pipeline) else { return Frame::Skipped };
        let frame = match t.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => return Frame::Skipped,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                t.surface.configure(&self.device, &t.config);
                return Frame::Skipped;
            }
            other => {
                log::warn!("surface: {other:?}");
                return Frame::Skipped;
            }
        };
        let aspect = t.config.width as f32 / t.config.height as f32;
        let view_proj = camera.view_proj(aspect);
        let eye = camera.eye();
        let u = Uniforms {
            view_proj: view_proj.to_cols_array_2d(),
            inv_view_proj: view_proj.inverse().to_cols_array_2d(),
            eye: [eye.x, eye.y, eye.z, 1.0],
            // render/renderer.ts SUN_OFFSET (18, 35, 14), normalised: toward the sun
            sun: { let v = glam::Vec3::new(18.0, 35.0, 14.0).normalize(); [v.x, v.y, v.z, 0.0] },
            horizon: hex(HORIZON),
            top: hex(SKY_TOP),
            fog: [FOG_NEAR, FOG_FAR, CLEAR_OPACITY as f32, 0.0],
            focus: [camera.focus.x, camera.focus.y, camera.focus.z, 0.0],
            studs: [studs::HQ_DISTANCE, STUD_RANGE, 0.0, 0.0],
            light: light_matrix(camera.focus, self.shadow_size).to_cols_array_2d(),
            shadow: [1.0 / self.shadow_size.max(1) as f32, SHADOW_BIAS, if self.shadow_size > 0 { 1.0 } else { 0.0 }, 0.0],
            water: [self.water_clock[0], self.water_clock[1], self.water_clock[2], 0.0],
        };
        self.queue.write_buffer(&self.uniforms, 0, bytemuck::bytes_of(&u));
        let view = frame.texture.create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        if self.shadow_size > 0 && self.world_visible {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("shadow"),
                color_attachments: &[],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &self.shadow_view, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }), stencil_ops: None }),
                ..Default::default()
            });
            pass.set_bind_group(0, &self.shadow_group, &[]);
            pass.set_pipeline(&pipelines.shadow_terrain);
            // only chunks the 44 m box can see (its corner reaches ~31 m; tall walls lean in from further)
            let focus = camera.focus;
            for form in self.chunks.iter().filter(|(&(cx, cz), _)| {
                let (x0, z0) = ((cx * CHUNK) as f32, (cz * CHUNK) as f32);
                let dx = focus.x.clamp(x0, x0 + CHUNK as f32) - focus.x;
                let dz = focus.z.clamp(z0, z0 + CHUNK as f32) - focus.z;
                dx * dx + dz * dz <= 48.0 * 48.0
            }).filter_map(|(_, c)| Self::form(c)) {
                for (buffer, count) in [&form.opaque, &form.clear].into_iter().flatten() {
                    pass.set_vertex_buffer(0, buffer.slice(..));
                    pass.draw(0..*count, 0..1);
                }
            }
            pass.set_pipeline(&pipelines.shadow_char);
            for m in &self.char_meshes {
                m.draw(&mut pass);
            }
            pass.set_pipeline(&pipelines.shadow_furniture);
            self.furniture.draw(&mut pass);
            self.campus.draw(&mut pass);
            self.fire_props.draw(&mut pass);
            self.pets.draw(&mut pass);
        }
        {
            let (target, resolve) = match &t.msaa {
                Some(m) => (m, Some(&view)),
                None => (&view, None),
            };
            let s = hex(HORIZON);
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("terrain"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    depth_slice: None,
                    resolve_target: resolve,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: s[0] as f64, g: s[1] as f64, b: s[2] as f64, a: 1.0 }), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &t.depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }), stencil_ops: None }),
                ..Default::default()
            });
            // a menu covers the screen with its own art: skip the world (battery), keep the overlay
            if self.world_visible {
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.set_pipeline(&pipelines.sky);
            pass.draw(0..3, 0..1);
            pass.set_pipeline(&pipelines.terrain);
            // past the render distance (nearest point of the chunk, from the focus) nothing is drawn:
            // the fog is opaque there already
            let focus = camera.focus;
            let in_range = |cx: i32, cz: i32| {
                let (x0, z0) = ((cx * CHUNK) as f32, (cz * CHUNK) as f32);
                let dx = focus.x.clamp(x0, x0 + CHUNK as f32) - focus.x;
                let dz = focus.z.clamp(z0, z0 + CHUNK as f32) - focus.z;
                dx * dx + dz * dz <= RENDER_DISTANCE * RENDER_DISTANCE
            };
            for form in self.chunks.iter().filter(|(&(cx, cz), _)| in_range(cx, cz)).filter_map(|(_, c)| Self::form(c)) {
                if let Some((buffer, count)) = &form.opaque {
                    pass.set_vertex_buffer(0, buffer.slice(..));
                    pass.draw(0..*count, 0..1);
                }
            }
            // studs, each form only on chunks that reach into its distance band (the shader drops
            // the tops outside it, so every top is drawn by exactly one form)
            let reach = |cx: i32, cz: i32| {
                let (x0, z0) = ((cx * CHUNK) as f32, (cz * CHUNK) as f32);
                let dx = focus.x.clamp(x0, x0 + CHUNK as f32) - focus.x;
                let dz = focus.z.clamp(z0, z0 + CHUNK as f32) - focus.z;
                (dx * dx + dz * dz).sqrt()
            };
            for (pipeline, mesh, band) in [(&pipelines.stud_hq, &self.stud_meshes[0], studs::HQ_DISTANCE), (&pipelines.stud_lod, &self.stud_meshes[1], STUD_RANGE)] {
                let Some((vertices, indices, index_count)) = mesh else { continue };
                pass.set_pipeline(pipeline);
                pass.set_vertex_buffer(0, vertices.slice(..));
                pass.set_index_buffer(indices.slice(..), wgpu::IndexFormat::Uint16);
                for (&(cx, cz), c) in &self.chunks {
                    let Some((buffer, count)) = &c.studs else { continue };
                    if reach(cx, cz) <= band {
                        pass.set_vertex_buffer(1, buffer.slice(..));
                        pass.draw_indexed(0..*index_count, 0, 0..*count);
                    }
                }
            }
            // the player's body: opaque, with the terrain's lighting and fog
            pass.set_pipeline(&pipelines.terrain);
            self.actor.draw(&mut pass);
            // furniture: the server's layout, baked (furniture.rs)
            pass.set_pipeline(&pipelines.furniture);
            self.furniture.draw(&mut pass);
            self.campus.draw(&mut pass);
            self.fire_props.draw(&mut pass);
            self.pets.draw(&mut pass);
            // the characters: their own pipeline (face texture), the same lighting and fog
            pass.set_pipeline(&pipelines.character);
            for k in 0..4 {
                if let Some(g) = &self.char_groups[k] {
                    pass.set_bind_group(1, g, &[]);
                    self.char_meshes[k].draw(&mut pass);
                }
            }
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.set_pipeline(&pipelines.campus_clear);
            self.campus_clear.draw(&mut pass);
            pass.set_pipeline(&pipelines.fire_fx);
            self.fire_fx.draw(&mut pass);
            // see-through blocks last, farthest chunk first (as three sorts transparent objects)
            let mut clear: Vec<(f32, &(wgpu::Buffer, u32))> = self
                .chunks
                .iter()
                .filter(|(&(cx, cz), _)| in_range(cx, cz))
                .filter_map(|(&(cx, cz), c)| {
                    let mesh = Self::form(c)?.clear.as_ref()?;
                    let centre = glam::Vec2::new(((cx * CHUNK) as f32) + CHUNK as f32 / 2.0, ((cz * CHUNK) as f32) + CHUNK as f32 / 2.0);
                    Some((centre.distance_squared(glam::Vec2::new(eye.x, eye.z)), mesh))
                })
                .collect();
            if !clear.is_empty() {
                clear.sort_by(|a, b| b.0.total_cmp(&a.0));
                pass.set_pipeline(&pipelines.clear);
                for (_, (buffer, count)) in clear {
                    pass.set_vertex_buffer(0, buffer.slice(..));
                    pass.draw(0..*count, 0..1);
                }
            }
            // the placement ghost, over the solid world
            pass.set_pipeline(&pipelines.ghost);
            self.ghost.draw(&mut pass);
            // the water last of all, farthest chunk first
            let mut water: Vec<(f32, &(wgpu::Buffer, u32))> = self
                .chunks
                .iter()
                .filter(|(&(cx, cz), _)| in_range(cx, cz))
                .filter_map(|(&(cx, cz), c)| {
                    let mesh = c.water.as_ref()?;
                    let centre = glam::Vec2::new(((cx * CHUNK) as f32) + CHUNK as f32 / 2.0, ((cz * CHUNK) as f32) + CHUNK as f32 / 2.0);
                    Some((centre.distance_squared(glam::Vec2::new(eye.x, eye.z)), mesh))
                })
                .collect();
            if !water.is_empty() {
                water.sort_by(|a, b| b.0.total_cmp(&a.0));
                pass.set_pipeline(&pipelines.water);
                pass.set_bind_group(1, &self.water_group, &[]);
                for (_, (buffer, count)) in water {
                    pass.set_vertex_buffer(0, buffer.slice(..));
                    pass.draw(0..*count, 0..1);
                }
            }
            }
        }
        {
            // the overlay last, over everything, in its own pass on the UI view of the same image
            let ui_view = frame.texture.create_view(&wgpu::TextureViewDescriptor { format: Some(self.ui_format(t.config.format)), ..Default::default() });
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("ui"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &ui_view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })],
                ..Default::default()
            });
            pass.set_pipeline(&pipelines.ui);
            if let (Some(buffer), true) = (&self.overlay.buffer, self.overlay.count > 0) {
                pass.set_vertex_buffer(0, buffer.slice(..));
                let total = self.overlay.count;
                let mut runs = self.overlay_segments.clone();
                if runs.first().is_none_or(|r| r.0 != 0) {
                    runs.insert(0, (0, None));
                }
                for (k, &(start, art)) in runs.iter().enumerate() {
                    let end = runs.get(k + 1).map_or(total, |r| r.0).min(total);
                    if start >= end {
                        continue;
                    }
                    // a picture not uploaded yet draws with the plain group (its quads come out white-tinted
                    // only if the painter drew them; it skips pictures it does not have)
                    let group = art.and_then(|i| self.ui_art.get(i).and_then(Option::as_ref)).unwrap_or(&self.ui_plain);
                    pass.set_bind_group(0, group, &[]);
                    pass.draw(start..end, 0..1);
                }
            }
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame);
        Frame::Drawn
    }
}

/// Upload the block surfaces (made off the main thread, `surfaces.rs`) as one texture array:
/// a layer per family, sRGB, full mip chain.
/// The material table's size in the shader (shader.wgsl `materials`: three vec4 per layer).
pub const MAX_LAYERS: usize = 128;

/// One texture array from per-layer mip chains (square, `size` at mip 0).
fn texture_array(device: &wgpu::Device, queue: &wgpu::Queue, label: &str, layers: &[Vec<Vec<u8>>], size: u32, format: wgpu::TextureFormat) -> wgpu::TextureView {
    let levels = layers.first().map_or(1, |c| c.len() as u32);
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: layers.len().max(1) as u32 },
        mip_level_count: levels,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    for (layer, chain) in layers.iter().enumerate() {
        for (mip, level) in chain.iter().enumerate() {
            let side = (size >> mip).max(1);
            queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: mip as u32, origin: wgpu::Origin3d { x: 0, y: 0, z: layer as u32 }, aspect: wgpu::TextureAspect::All },
                level,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(side * 4), rows_per_image: Some(side) },
                wgpu::Extent3d { width: side, height: side, depth_or_array_layers: 1 },
            );
        }
    }
    texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() })
}

fn surface_textures(device: &wgpu::Device, queue: &wgpu::Queue, maps: &SurfaceMaps) -> (wgpu::TextureView, wgpu::Sampler) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("surfaces"),
        size: wgpu::Extent3d { width: maps.size, height: maps.size, depth_or_array_layers: maps.layers.len() as u32 },
        mip_level_count: maps.levels(),
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8UnormSrgb,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    for (layer, chain) in maps.layers.iter().enumerate() {
        for (mip, level) in chain.iter().enumerate() {
            let size = (maps.size >> mip).max(1);
            queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: mip as u32, origin: wgpu::Origin3d { x: 0, y: 0, z: layer as u32 }, aspect: wgpu::TextureAspect::All },
                level,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size * 4), rows_per_image: Some(size) },
                wgpu::Extent3d { width: size, height: size, depth_or_array_layers: 1 },
            );
        }
    }
    let view = texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("surfaces"),
        address_mode_u: wgpu::AddressMode::Repeat,
        address_mode_v: wgpu::AddressMode::Repeat,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        anisotropy_clamp: 4,
        ..Default::default()
    });
    (view, sampler)
}

fn targets(device: &wgpu::Device, format: wgpu::TextureFormat, width: u32, height: u32, samples: u32) -> (wgpu::TextureView, Option<wgpu::TextureView>) {
    let size = wgpu::Extent3d { width, height, depth_or_array_layers: 1 };
    let make = |label, format, samples| {
        device
            .create_texture(&wgpu::TextureDescriptor { label: Some(label), size, mip_level_count: 1, sample_count: samples, dimension: wgpu::TextureDimension::D2, format, usage: wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[] })
            .create_view(&Default::default())
    };
    let depth = make("depth", wgpu::TextureFormat::Depth32Float, samples);
    let msaa = (samples > 1).then(|| make("msaa", format, samples));
    (depth, msaa)
}
