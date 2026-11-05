//! The winit application. Android rules shape it:
//! - the window (and so the surface) exists only between `resumed` and `suspended`; nothing GPU-
//!   side touches a window outside that span. The DEVICE survives (`Renderer::attach/detach`);
//! - a lost device rebuilds the renderer and re-requests every chunk; a renderer that cannot be
//!   built is retried on the next resume instead of crashing the app.
//!
//! The world is generated once (the web's island, same seed) and meshed by the `Mesher` thread;
//! the frame loop only uploads finished chunks and picks each chunk's form by distance (LOD).

use crate::chunks::{Mesher, CHUNK, CHUNKS_X, CHUNKS_Z};
use crate::gpu::{Frame, Renderer};
use crate::quality::{AutoTuner, Preset};
use crate::scene::{self, Camera, ISLAND_SEED};
use crate::surfaces::PendingSurfaces;
use craftyap_core::world::{generate_island, World};
use glam::Vec3;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, Touch, TouchPhase, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Window, WindowId};

/// The web's LOD: near (joined brick shells) within this many metres of the focus, far beyond,
/// with hysteresis so a chunk on the line does not flip back and forth.
const LOD_NEAR: f32 = 22.0;
const LOD_HYSTERESIS: f32 = 4.0;
/// Chunk uploads per frame stop after this many milliseconds (at least one chunk per frame).
const UPLOAD_BUDGET_MS: f32 = 4.0;

/// Run until the window closes (desktop) or the activity is destroyed (Android).
pub fn run(event_loop: EventLoop<()>) -> anyhow::Result<()> {
    event_loop.set_control_flow(ControlFlow::Poll);
    let mut app = App::new();
    event_loop.run_app(&mut app)?;
    Ok(())
}

struct App {
    window: Option<Arc<Window>>,
    renderer: Option<Renderer>,
    camera: Camera,
    preset: Option<Preset>,
    tuner: AutoTuner,
    last_frame: Option<Instant>,
    display: Option<winit::event_loop::OwnedDisplayHandle>,
    surfaces: PendingSurfaces,
    // input
    touches: HashMap<u64, (f64, f64)>,
    pinch: Option<f64>,
    mouse_down: bool,
    cursor: (f64, f64),
    // world
    mesher: Mesher,
    /// Chunk forms (cx, cz, far) asked of the mesher, and those uploaded.
    requested: HashSet<(i32, i32, bool)>,
    near_now: HashSet<(i32, i32)>,
    lod_focus: Option<Vec3>,
    started: Instant,
    logged_ready: bool,
}

impl App {
    fn new() -> Self {
        // the textures are made on their own threads while the world is generated and the window opens
        let surfaces = PendingSurfaces::start();
        let t = Instant::now();
        let world: Arc<World> = Arc::new(generate_island(ISLAND_SEED));
        log::info!("island generated in {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);
        Self {
            window: None,
            renderer: None,
            camera: {
                // desktop comparison runs (tools/shot-native-compare.mjs): a fixed camera
                let mut c = Camera::default();
                if let Ok(s) = std::env::var("CRAFTYAP_VIEW") {
                    c.fixed = scene::FixedView::parse(&s);
                    match c.fixed {
                        Some(v) => {
                            log::info!("fixed view {v:?}");
                            c.focus = v.eye + v.dir * 20.0; // LOD around what is looked at
                        }
                        None => log::warn!("CRAFTYAP_VIEW is not ex,ey,ez,dx,dy,dz,fov: ignored"),
                    }
                }
                c
            },
            preset: None,
            tuner: AutoTuner::new(60.0),
            last_frame: None,
            display: None,
            surfaces,
            touches: HashMap::new(),
            pinch: None,
            mouse_down: false,
            cursor: (0.0, 0.0),
            mesher: Mesher::new(world),
            requested: HashSet::new(),
            near_now: HashSet::new(),
            lod_focus: None,
            started: Instant::now(),
            logged_ready: false,
        }
    }

    fn build_renderer(&mut self) {
        let Some(window) = self.window.clone() else { return };
        let preset = self.preset.unwrap_or(Preset::Medium);
        let Some(display) = self.display.clone() else { return };
        let maps = self.surfaces.get();
        match Renderer::new(window, display, preset.settings(), &maps) {
            Ok(r) => {
                if self.preset.is_none() {
                    let initial = Preset::initial(&r.info, &r.limits);
                    log::info!("quality: {initial:?} (auto)");
                    self.preset = Some(initial);
                }
                self.renderer = Some(r);
                // a new device has none of the chunks: ask for them again
                self.requested.clear();
                self.lod_focus = None;
            }
            Err(err) => log::error!("cannot start the renderer, retrying on the next resume: {err:#}"),
        }
    }

    /// Upload finished chunks; when the focus moved, pick every chunk's form and request missing
    /// forms nearest first (far forms of the whole map first: they are cheap and fill the view).
    fn update_chunks(&mut self) {
        let Some(r) = &mut self.renderer else { return };
        // uploads are a frame's biggest cost (the first fill is ~25 MB): spend at most
        // UPLOAD_BUDGET_MS per frame and leave the rest queued; they arrive nearest first
        let t = Instant::now();
        for b in self.mesher.finished() {
            r.upload(b.cx, b.cz, b.far, &b.mesh.opaque, &b.mesh.clear, &b.mesh.studs);
            if t.elapsed().as_secs_f32() * 1000.0 > UPLOAD_BUDGET_MS {
                break;
            }
        }
        let focus = self.camera.focus;
        if self.lod_focus.is_some_and(|f| f.distance_squared(focus) < 4.0 * 4.0) {
            return;
        }
        self.lod_focus = Some(focus);
        let mut order: Vec<(f32, i32, i32)> = Vec::new();
        for cx in 0..CHUNKS_X {
            for cz in 0..CHUNKS_Z {
                let (x0, z0) = ((cx * CHUNK) as f32, (cz * CHUNK) as f32);
                let dx = focus.x.clamp(x0, x0 + CHUNK as f32) - focus.x;
                let dz = focus.z.clamp(z0, z0 + CHUNK as f32) - focus.z;
                order.push(((dx * dx + dz * dz).sqrt(), cx, cz));
            }
        }
        order.sort_by(|a, b| a.0.total_cmp(&b.0));
        for &(_, cx, cz) in &order {
            if self.requested.insert((cx, cz, true)) {
                self.mesher.request(cx, cz, true);
            }
        }
        for &(d, cx, cz) in &order {
            let was_near = self.near_now.contains(&(cx, cz));
            let near = if was_near { d <= LOD_NEAR + LOD_HYSTERESIS } else { d <= LOD_NEAR };
            r.want(cx, cz, !near);
            if near {
                self.near_now.insert((cx, cz));
                if self.requested.insert((cx, cz, false)) {
                    self.mesher.request(cx, cz, false);
                }
            } else {
                self.near_now.remove(&(cx, cz));
            }
        }
    }

    fn on_touch(&mut self, id: u64, phase: TouchPhase, x: f64, y: f64) {
        match phase {
            TouchPhase::Started => {
                self.touches.insert(id, (x, y));
                self.pinch = None;
            }
            TouchPhase::Moved => {
                let Some(prev) = self.touches.insert(id, (x, y)) else { return };
                match self.touches.len() {
                    1 => self.camera.drag((x - prev.0) as f32, (y - prev.1) as f32),
                    2 => {
                        let pts: Vec<_> = self.touches.values().copied().collect();
                        let spread = ((pts[0].0 - pts[1].0).powi(2) + (pts[0].1 - pts[1].1).powi(2)).sqrt();
                        if let Some(before) = self.pinch {
                            if spread > 1.0 {
                                self.camera.zoom((before / spread) as f32);
                            }
                        }
                        self.pinch = Some(spread);
                    }
                    _ => {}
                }
            }
            TouchPhase::Ended | TouchPhase::Cancelled => {
                self.touches.remove(&id);
                self.pinch = None;
            }
        }
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.display.get_or_insert_with(|| event_loop.owned_display_handle());
        if self.window.is_none() {
            let attrs = Window::default_attributes().with_title("CraftYap").with_inner_size(winit::dpi::LogicalSize::new(1100.0, 700.0));
            match event_loop.create_window(attrs) {
                Ok(w) => self.window = Some(Arc::new(w)),
                Err(err) => {
                    log::error!("cannot open the window: {err}");
                    return;
                }
            }
        }
        log::info!("resumed");
        // the device survives a pause: only the window's surface is new
        let attached = match (&mut self.renderer, self.window.clone()) {
            (Some(r), Some(w)) => match r.attach(w) {
                Ok(()) => true,
                Err(err) => {
                    log::warn!("cannot attach the new window, rebuilding the renderer: {err:#}");
                    false
                }
            },
            _ => false,
        };
        if !attached {
            self.renderer = None;
            self.build_renderer();
        }
        self.last_frame = None;
    }

    fn suspended(&mut self, _: &ActiveEventLoop) {
        // Android: the native window is about to go away ??drop everything that refers to it,
        // keep the device
        log::info!("suspended");
        if let Some(r) = &mut self.renderer {
            r.detach();
        }
        if cfg!(target_os = "android") {
            self.window = None;
        }
        self.touches.clear();
        self.pinch = None;
        self.mouse_down = false;
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                if let Some(r) = &mut self.renderer {
                    r.resize(size.width, size.height);
                }
            }
            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } => self.mouse_down = state == ElementState::Pressed,
            WindowEvent::CursorMoved { position, .. } => {
                if self.mouse_down {
                    self.camera.drag((position.x - self.cursor.0) as f32, (position.y - self.cursor.1) as f32);
                }
                self.cursor = (position.x, position.y);
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let steps = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y,
                    MouseScrollDelta::PixelDelta(p) => (p.y / 60.0) as f32,
                };
                self.camera.zoom(0.9f32.powf(steps));
            }
            WindowEvent::Touch(Touch { id, phase, location, .. }) => self.on_touch(id, phase, location.x, location.y),
            WindowEvent::RedrawRequested => {
                let now = Instant::now();
                let dt = self.last_frame.map_or(0.0, |t| (now - t).as_secs_f32());
                self.last_frame = Some(now);
                if self.touches.is_empty() && !self.mouse_down && self.camera.fixed.is_none() {
                    self.camera.yaw += dt * 0.08;
                }
                self.update_chunks();
                let Some(r) = &mut self.renderer else { return };
                if !self.logged_ready && self.requested.len() >= (CHUNKS_X * CHUNKS_Z) as usize && r.drawn_vertices() > 0 {
                    self.logged_ready = true;
                    log::info!("first chunks on screen {:.0} ms after start", self.started.elapsed().as_secs_f64() * 1000.0);
                }
                match r.render(&self.camera) {
                    Frame::Drawn | Frame::Skipped => {}
                    Frame::DeviceLost => {
                        self.renderer = None;
                        self.build_renderer();
                        return;
                    }
                }
                if let (Some(preset), true) = (self.preset, dt > 0.0) {
                    if let Some(lower) = self.tuner.frame(preset, dt * 1000.0) {
                        log::info!("quality: frames run long, stepping down to {lower:?}");
                        self.preset = Some(lower);
                        r.set_settings(lower.settings());
                    }
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _: &ActiveEventLoop) {
        if let Some(w) = &self.window {
            w.request_redraw();
        }
    }
}
