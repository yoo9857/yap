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
const FOG_NEAR: f32 = 95.0;
const FOG_FAR: f32 = 245.0;

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
}

/// The pipelines for one (surface format, sample count).
struct Pipelines {
    format: wgpu::TextureFormat,
    samples: u32,
    terrain: wgpu::RenderPipeline,
    /// See-through blocks: blended, depth-tested but not written (drawn after the opaque world).
    clear: wgpu::RenderPipeline,
    /// The Blender studs instanced on brick tops: the original near, the light form farther.
    stud_hq: wgpu::RenderPipeline,
    stud_lod: wgpu::RenderPipeline,
    sky: wgpu::RenderPipeline,
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
    uniforms: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
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
        let uniforms = device.create_buffer(&wgpu::BufferDescriptor { label: Some("uniforms"), size: std::mem::size_of::<Uniforms>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("uniforms"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2Array, multisampled: false }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("uniforms"), layout: &layout, entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&surfaces) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&sampler) },
        ] });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("terrain"), bind_group_layouts: &[Some(&layout)], ..Default::default() });
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
        let mut r = Self { instance, adapter, device, queue, shader, pipeline_layout, pipeline: None, chunks: HashMap::new(), stud_meshes, uniforms, bind_group, target: None, settings, lost, info, limits };
        r.attach_surface(surface, window.inner_size())?;
        Ok(r)
    }

    /// A chunk form finished meshing: upload it (an empty form uploads nothing but counts as built).
    /// `studs` arrive with the far form only (the near form's list is empty and ignored).
    pub fn upload(&mut self, cx: i32, cz: i32, far: bool, opaque: &[Vertex], clear: &[Vertex], studs: &[StudInstance]) {
        fn mesh<T: bytemuck::Pod>(device: &wgpu::Device, items: &[T], label: &str) -> Mesh {
            (!items.is_empty()).then(|| {
                let b = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: bytemuck::cast_slice(items), usage: wgpu::BufferUsages::VERTEX });
                (b, items.len() as u32)
            })
        }
        let form = Form { opaque: mesh(&self.device, opaque, "chunk"), clear: mesh(&self.device, clear, "chunk") };
        let studs = far.then(|| mesh(&self.device, studs, "studs"));
        let chunk = self.chunks.entry((cx, cz)).or_default();
        *(if far { &mut chunk.far } else { &mut chunk.near }) = Some(form);
        if let Some(s) = studs {
            chunk.studs = s;
        }
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
            view_formats: vec![],
        };
        surface.configure(&self.device, &config);
        let samples = self.samples_for(format);
        self.ensure_pipeline(format, samples);
        let (depth, msaa) = targets(&self.device, format, config.width, config.height, samples);
        log::info!("surface {}x{} {:?}, {} samples", config.width, config.height, format, samples);
        self.target = Some(Target { surface, config, depth, msaa });
        Ok(())
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
        self.pipeline = Some(Pipelines { format, samples, terrain, clear, stud_hq, stud_lod, sky });
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
            sun: [0.4, 0.85, 0.3, 0.0],
            horizon: hex(HORIZON),
            top: hex(SKY_TOP),
            fog: [FOG_NEAR, FOG_FAR, CLEAR_OPACITY as f32, 0.0],
            focus: [camera.focus.x, camera.focus.y, camera.focus.z, 0.0],
            studs: [studs::HQ_DISTANCE, STUD_RANGE, 0.0, 0.0],
        };
        self.queue.write_buffer(&self.uniforms, 0, bytemuck::bytes_of(&u));
        let view = frame.texture.create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
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
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.set_pipeline(&pipelines.sky);
            pass.draw(0..3, 0..1);
            pass.set_pipeline(&pipelines.terrain);
            for form in self.chunks.values().filter_map(Self::form) {
                if let Some((buffer, count)) = &form.opaque {
                    pass.set_vertex_buffer(0, buffer.slice(..));
                    pass.draw(0..*count, 0..1);
                }
            }
            // studs, each form only on chunks that reach into its distance band (the shader drops
            // the tops outside it, so every top is drawn by exactly one form)
            let focus = camera.focus;
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
            // see-through blocks last, farthest chunk first (as three sorts transparent objects)
            let mut clear: Vec<(f32, &(wgpu::Buffer, u32))> = self
                .chunks
                .iter()
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
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame);
        Frame::Drawn
    }
}

/// Upload the block surfaces (made off the main thread, `surfaces.rs`) as one texture array:
/// a layer per family, sRGB, full mip chain.
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
