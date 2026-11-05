//! The winit application. Android rules shape it:
//! - the window (and so the surface) exists only between `resumed` and `suspended`; nothing GPU-
//!   side touches a window outside that span. The DEVICE survives (`Renderer::attach/detach`);
//! - a lost device rebuilds the renderer and re-requests every chunk; a renderer that cannot be
//!   built is retried on the next resume instead of crashing the app.
//!
//! The world is generated once (the web's island, same seed) and meshed by the `Mesher` thread;
//! the frame loop only uploads finished chunks and picks each chunk's form by distance (LOD).
//!
//! The player (N3): `Input` (keys + captured mouse, or touch stick / look / jump) -> `Player`
//! (the core's voxel body at 60 Hz) -> `FollowCamera` (craftCamera.ts) -> the overlay (`ui.rs`).
//! `CRAFTYAP_VIEW` (web <-> native comparison shots) still pins a fixed camera instead;
//! `CRAFTYAP_TOUCH=1` shows the touch controls on a desktop (checking the phone layout).

use crate::building::{self, Dig, Hotbar};
use crate::character::{self, Animator, CharVertex, Kind, Motion, Posture};
use craftyap_core::world::RayHit;
use crate::chunks::{Mesher, CHUNK, CHUNKS_X, CHUNKS_Z};
use crate::field::FieldWindow;
use crate::follow::FollowCamera;
use crate::gpu::{Frame, Renderer};
use crate::input::Input;
use crate::player::{Player, EYE_HEIGHT};
use crate::art::{ArtLoader, Image, ALL as ALL_ART, SLOTS};
use crate::ime;
use crate::menu::{LoadProgress, Menu, Outcome, Pointer, Ui};
use crate::profile::Profile;
use crate::text::Text;
use crate::ui::Painter;
use crate::quality::{AutoTuner, Preset};
use crate::scene::{self, Camera, ISLAND_SEED};
use crate::surfaces::PendingSurfaces;
use craftyap_core::world::{generate_island, surface_y, World};
use glam::{DVec3, Vec3};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use winit::application::ApplicationHandler;
use winit::event::{DeviceEvent, DeviceId, ElementState, MouseButton, Touch, TouchPhase, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{KeyCode, PhysicalKey};
use winit::window::{CursorGrabMode, Window, WindowId};

/// voxelWorld.ts CRAFT_SPAWN: the open grass south of the castle, looking at it (yaw pi = -z).
const SPAWN: (f64, f64) = (40.5, 72.5);
const SPAWN_YAW: f64 = std::f64::consts::PI;

/// The web's LOD: near (joined brick shells) within this many metres of the focus, far beyond,
/// with hysteresis so a chunk on the line does not flip back and forth.
const LOD_NEAR: f32 = 22.0;
const LOD_HYSTERESIS: f32 = 4.0;
/// Chunk uploads per frame stop after this many milliseconds (at least one chunk per frame).
const UPLOAD_BUDGET_MS: f32 = 4.0;

/// The open bag on the HUD: its layout, each shown item's (picture, count), its tab, the armed slot.
type BagHud = (crate::bag::Layout, Vec<(Option<usize>, Option<u32>)>, usize, usize);

/// The play screen's HUD, snapshotted from the app (crosshair, aim box, dig progress, hotbar, touch).
struct PlayHud {
    w: f32,
    h: f32,
    rects: Vec<crate::ui::Rect>,
    slots: Vec<(Option<usize>, Option<u32>)>,
    selected: usize,
    aim: Option<(Vec3, Vec3)>,
    /// The aimed face's four corners (the one the ray came in through), for the cracks.
    face: Option<[Vec3; 4]>,
    dig: Option<f32>,
    view_proj: glam::Mat4,
    eye: Vec3,
    touch: crate::input::TouchUi,
    /// Puffs playing: the cell centre and its age (s).
    poofs: Vec<(Vec3, f32)>,
    /// The pet chip: open, the adopted animal (adoption order), sitting.
    pet: Option<(bool, usize, bool)>,
    /// Solo island (the plate is drawn here; a class draws its own).
    island: bool,
    /// The construction piece in hand (the shape button shows it).
    piece: usize,
    /// The emote panel, when open: the posture taken and whether TT is the character.
    emote: Option<(Posture, bool)>,
    /// Where everything goes (hud_layout.rs), and the island plate's name.
    layout: crate::hud_layout::HudLayout,
    me: String,
    chatting: bool,
    /// The bag, when open: its layout, each shown item's (picture, count), its tab and armed slot.
    bag: Option<BagHud>,
    time: f32,
}

/// An item's picture slot: the pickaxe's own icon, a block's texture icon.
fn item_icon(key: &str) -> Option<usize> {
    if key == building::PICKAXE_KEY {
        return Some(crate::art::Art::ItemPickaxe.index());
    }
    building::def(key).and_then(|d| crate::art::icon_slot(d.texture))
}

/// craftGame.ts beginWork: a changed action (or any one-shot) is a new sequence number.
fn begin_work(wire: &mut (&'static str, u32, bool), action: &'static str, looped: bool) {
    let (a, seq, l) = *wire;
    if action != a || looped != l || !looped {
        *wire = (action, (seq + 1) % 1_000_000_000, looped);
        log::debug!("work: {action} #{} loop {looped}", wire.1);
    }
}

/// Does the segment a → b pass through the box [lo, hi] (slab test)?
fn segment_hits_box(a: DVec3, b: DVec3, lo: DVec3, hi: DVec3) -> bool {
    let d = b - a;
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for i in 0..3 {
        if d[i].abs() < 1e-9 {
            if a[i] < lo[i] || a[i] > hi[i] {
                return false;
            }
            continue;
        }
        let (mut u, mut v) = ((lo[i] - a[i]) / d[i], (hi[i] - a[i]) / d[i]);
        if u > v {
            std::mem::swap(&mut u, &mut v);
        }
        t0 = t0.max(u);
        t1 = t1.min(v);
        if t0 > t1 {
            return false;
        }
    }
    true
}

/// A point in the world on the screen (dp), or None behind the camera.
fn project(view_proj: glam::Mat4, w: f32, h: f32, at: Vec3) -> Option<(f32, f32)> {
    let clip = view_proj * at.extend(1.0);
    if clip.w <= 0.1 {
        return None;
    }
    Some(((clip.x / clip.w * 0.5 + 0.5) * w, (0.5 - clip.y / clip.w * 0.5) * h))
}

fn draw_play_hud(p: &mut Painter, t: &mut Text, hud: &PlayHud) {
    p.touch_hud = hud.touch.visible;
    if let Some((min, max)) = hud.aim {
        p.aim_box(hud.view_proj, hud.eye, min, max);
    }
    let (cx, cy) = (hud.w / 2.0, hud.h / 2.0);
    for &(at, age) in &hud.poofs {
        // sized like a block and a half where it is: the screen distance of a point beside it
        let side = (at - hud.eye).cross(Vec3::Y).normalize_or_zero() * 0.75;
        if let (Some(c), Some(e)) = (project(hud.view_proj, hud.w, hud.h, at), project(hud.view_proj, hud.w, hud.h, at + side)) {
            let size = (2.0 * ((e.0 - c.0).powi(2) + (e.1 - c.1).powi(2)).sqrt()).clamp(24.0, 260.0);
            p.poof(c.0, c.1, size, age);
        }
    }
    p.crosshair(cx, cy);
    if let (Some(f), Some(face)) = (hud.dig, hud.face) {
        // the face's screen box (all four corners in front of the camera)
        let pts: Vec<(f32, f32)> = face.iter().filter_map(|&c| project(hud.view_proj, hud.w, hud.h, c)).collect();
        if pts.len() == 4 {
            let (x0, x1) = pts.iter().fold((f32::MAX, f32::MIN), |a, p| (a.0.min(p.0), a.1.max(p.0)));
            let (y0, y1) = pts.iter().fold((f32::MAX, f32::MIN), |a, p| (a.0.min(p.1), a.1.max(p.1)));
            p.crack(crate::ui::Rect::new(x0, y0, x1 - x0, y1 - y0), f);
        }
    }
    if let Some(f) = hud.dig {
        p.dig_progress(cx, cy, f);
    }
    p.hotbar(t, &hud.rects, &hud.slots, hud.selected);
    p.touch_controls(&hud.touch, hud.piece);
    use crate::hud_layout::Sys;
    if hud.island {
        p.plate(t, hud.layout.plate, crate::art::Art::NavHome, &format!("{} · 블록 섬", hud.me), None);
    }
    for &(sys, r) in &hud.layout.system {
        match sys {
            Sys::Pet => {} // drawn with its row below
            Sys::Emote => p.sys_button(r, crate::art::Art::GlyphEmote, hud.emote.is_some()),
            Sys::Bag => p.sys_button(r, crate::art::Art::GlyphBag, hud.bag.is_some()),
            Sys::Chat => p.sys_button(r, crate::art::Art::GlyphChat, hud.chatting),
            Sys::Menu => p.sys_button(r, if hud.island { crate::art::Art::NavMenu } else { crate::art::Art::GlyphExit }, false),
        }
    }
    if let Some((l, items, tab, armed)) = &hud.bag {
        if let Some(r) = hud.rects.get(*armed) {
            p.armed_ring(*r, hud.time);
        }
        p.hotbar(t, &hud.rects, &hud.slots, hud.selected);
        p.bag(t, l, items, *tab, *armed);
    }
    if let Some((posture, tt)) = hud.emote {
        p.emote_panel(t, hud.w, posture, tt);
    }
    if let (Some((open, adopted, sitting)), Some(chip)) = (hud.pet, hud.layout.sys(Sys::Pet)) {
        p.pet_hud(t, chip, &hud.layout.pet_row, open, adopted, sitting);
    }
}

/// This frame's characters to the GPU (each model's face texture first, once per device).
fn upload_characters(r: &mut Renderer, meshes: &[Vec<CharVertex>; 4]) {
    for kind in [Kind::Home, Kind::Tt] {
        let slot = kind as usize;
        if !r.has_character_texture(slot) && !meshes[slot].is_empty() {
            if let Some(m) = character::model(kind) {
                let (w, h, px) = &m.texture;
                r.set_character_texture(slot, *w, *h, px);
            }
        }
        r.set_characters(slot, &meshes[slot]);
    }
    // held items: the pickaxe's atlas in the third slot
    if !r.has_character_texture(2) && !meshes[2].is_empty() {
        if let Some(i) = crate::held::item() {
            let (w, h, px) = &i.texture;
            r.set_character_texture(2, *w, *h, px);
        }
    }
    r.set_characters(2, &meshes[2]);
    // the player's live face (its texture is uploaded by the app as it changes)
    r.set_characters(3, &meshes[3]);
}

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
    // input and the player
    input: Input,
    player: Player,
    follow: FollowCamera,
    // world: the island (solo) or the shared field (a class / party room)
    world: Arc<World>,
    island: Arc<World>,
    /// The island as generated (the save is the difference from it), the cells changed since, the
    /// bag kept while away in a field, and when the save was last written / last changed.
    island_pristine: Arc<World>,
    island_edits: HashMap<(i32, i32, i32), (u8, u8)>,
    island_bag: HashMap<String, u32>,
    island_dirty: bool,
    island_saved_at: f64,
    field: Option<FieldWindow>,
    mesher: Mesher,
    /// Every request gets a stamp; a result counts only if it answers the newest request for its
    /// chunk form (the world changed under older ones).
    stamp: u64,
    latest: HashMap<(i32, i32, bool), u64>,
    /// Chunk forms (cx, cz, far) asked of the mesher, and those uploaded.
    requested: HashSet<(i32, i32, bool)>,
    near_now: HashSet<(i32, i32)>,
    lod_focus: Option<Vec3>,
    started: Instant,
    logged_ready: bool,
    /// Building (building.rs): the hotbar, the dig in progress, what the crosshair is on, the
    /// held mouse button and right clicks since last frame, the solid furniture (grid cells), and
    /// the play screen's size (for the hotbar's touch hit test).
    hotbar: Hotbar,
    /// The web's sounds (sound.rs), and the beat of hand-dig taps.
    sound: crate::sound::Sound,
    dig_beat: f64,
    /// Digging this frame (the hands' Interact layer) and the dug block's surface family (its taps).
    digging_now: bool,
    /// The placement ghost: a world holding only the target cell (meshed by the real mesher, so
    /// the ghost is exactly the brick that will appear) and the (cell, block, shape, fits) it shows.
    ghost_world: Option<World>,
    ghost_tables: Option<craftyap_core::scan::Tables>,
    ghost_key: Option<([i32; 3], u8, u8, bool)>,
    /// The player's live face (face.rs) and the pictures being decoded for it; a composed texture
    /// waiting for the renderer; whether the renderer holds one (the body draws with it then).
    face_loader: crate::face::Loader,
    face: Option<crate::face::Face>,
    face_pending: Option<(u32, u32, Vec<u8>)>,
    face_live: bool,
    /// The emote panel (C) and our own: posture, the last emote and its sequence (character.ts).
    emote_open: bool,
    posture: Posture,
    emote_wire: (&'static str, u32),
    /// The construction piece in hand (building.rs PIECES) and its turn / tip (quarter turns).
    piece: usize,
    piece_rot: u8,
    piece_tilt: u8,
    /// The held pickaxe: its pose, the strike in progress (itemAttack.ts) and a dig press this frame.
    held_pose: crate::held::HeldPose,
    attack: crate::held::Attack,
    /// craftGame.ts workAction / workSeq / workLoop: what our hands do, as the class hears it.
    work_wire: (&'static str, u32, bool),
    dig_family: craftyap_core::surface::Family,
    dig: Dig,
    aim: Option<RayHit>,
    mouse_dig: bool,
    dig_was: bool,
    place_clicks: u32,
    /// Landing/breaking puffs (cell centre, age s), aged by build_frame.
    poofs: Vec<(Vec3, f32)>,
    /// The pet (pet.rs): spawned beside the player in each world, posed into `pet_mesh` per frame.
    pet: Option<crate::pet::Companion>,
    pet_mesh: Vec<crate::furniture::FurnitureVertex>,
    /// The pet chip's row is open (pick an animal, sit/follow).
    pet_open: bool,
    /// The bag (bag.rs) and the finger steering it: (id, last y, moved).
    bag: crate::bag::Bag,
    bag_finger: Option<(u64, f32, bool)>,
    /// The island's bar as loaded from the bag (kept while away in a field).
    island_slots: Option<Vec<String>>,
    props: HashSet<(i32, i32, i32)>,
    hud_size: (f32, f32),
    /// The characters' animation state: ours, and each classmate's (by player id).
    own_anim: Animator,
    /// The furniture layout version and window origin last baked (re-bake when either changes).
    drawn_furniture: Option<(u64, i32, i32)>,
    remote_anims: HashMap<String, Animator>,
    /// The overlay font and its glyph atlas (text.rs).
    text: Text,
    /// The menus (loading, lobby, waiting room …) and whether they or the game are on screen.
    menu: Menu,
    in_menu: bool,
    /// The menu pointer (mouse, or the first finger while a menu is up) and that finger's id.
    pointer: Pointer,
    menu_finger: Option<u64>,
    /// The web's menu pictures: decoded on a thread, kept to upload again to a new device.
    art: ArtLoader,
    art_images: Vec<Image>,
    art_sizes: Vec<Option<(u32, u32)>>,
}

impl App {
    fn new() -> Self {
        // the textures are made on their own threads while the world is generated and the window opens
        let surfaces = PendingSurfaces::start();
        let t = Instant::now();
        let pristine: Arc<World> = Arc::new(generate_island(ISLAND_SEED));
        log::info!("island generated in {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);
        // the save: what the player changed on it, the bag and where they stood
        let saved = crate::island_save::IslandSave::load(ISLAND_SEED);
        let mut world = pristine.clone();
        let island_edits = saved.as_ref().map(|s| s.apply(Arc::make_mut(&mut world))).unwrap_or_default();
        let island_bag = saved.as_ref().map(|s| s.bag.clone()).unwrap_or_default();
        if let Some(s) = &saved {
            log::info!("island: loaded ({} cells, {} in the bag)", s.edits.len(), island_bag.values().sum::<u32>());
        }
        let resume = saved.as_ref().and_then(|s| s.player);
        let saved_slots = saved.as_ref().and_then(|s| s.hotbar.clone());
        let ground = surface_y(&world, SPAWN.0.floor() as i32, SPAWN.1.floor() as i32) as f64 + 1.0;
        let player = match resume.filter(|p| World::in_bounds(p[0] as i32, p[1].max(0.0) as i32, p[2] as i32)) {
            Some(p) => Player::new(&world, [p[0], p[1], p[2]], p[3]),
            None => Player::new(&world, [SPAWN.0, ground, SPAWN.1], SPAWN_YAW),
        };
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
            input: {
                let mut i = Input::default();
                i.touch_mode = cfg!(target_os = "android") || std::env::var("CRAFTYAP_TOUCH").is_ok();
                i
            },
            player,
            follow: FollowCamera::default(),
            mesher: Mesher::new(),
            island: world.clone(),
            island_pristine: pristine,
            island_edits,
            island_bag: island_bag.clone(),
            island_dirty: false,
            island_saved_at: 0.0,
            world,
            field: None,
            stamp: 0,
            latest: HashMap::new(),
            requested: HashSet::new(),
            near_now: HashSet::new(),
            lod_focus: None,
            started: Instant::now(),
            logged_ready: false,
            hotbar: {
                let mut h = Hotbar { counts: Some(island_bag), ..Hotbar::island() };
                if let Some(s) = &saved_slots {
                    h.load_slots(s);
                }
                h
            },
            sound: crate::sound::Sound::start(),
            dig_beat: 0.0,
            digging_now: false,
            work_wire: ("none", 0, false),
            face_loader: crate::face::Loader::default(),
            face: None,
            face_pending: None,
            face_live: false,
            emote_open: false,
            posture: Posture::Stand,
            emote_wire: ("none", 0),
            ghost_world: None,
            ghost_tables: None,
            ghost_key: None,
            piece: 0,
            piece_rot: 0,
            piece_tilt: 0,
            held_pose: crate::held::HeldPose::default(),
            attack: crate::held::Attack::default(),
            dig_family: craftyap_core::surface::Family::Stone,
            dig: Dig::default(),
            aim: None,
            mouse_dig: false,
            dig_was: false,
            place_clicks: 0,
            poofs: Vec::new(),
            pet: None,
            pet_mesh: Vec::new(),
            pet_open: false,
            bag: crate::bag::Bag::default(),
            bag_finger: None,
            island_slots: saved_slots,
            props: HashSet::new(),
            hud_size: (0.0, 0.0),
            own_anim: Animator::new(7),
            drawn_furniture: None,
            remote_anims: HashMap::new(),
            text: Text::new(),
            // CRAFTYAP_VIEW (comparison shots) starts straight in the world, no menus
            in_menu: std::env::var("CRAFTYAP_VIEW").is_err(),
            menu: Menu::new(Profile::load(), 0.0),
            pointer: Pointer::default(),
            menu_finger: None,
            art: ArtLoader::start(),
            art_images: Vec::new(),
            art_sizes: vec![None; SLOTS],
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
                // and none of the furniture, nor the live face
                self.drawn_furniture = None;
                self.face_live = false;
                if let Some(f) = &mut self.face {
                    f.mark_dirty();
                }
                // a new device has an empty atlas and no pictures: make and upload them again
                self.text.reset();
                if let Some(r) = &mut self.renderer {
                    for img in &self.art_images {
                        r.add_art(img);
                    }
                }
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
            if self.latest.get(&(b.cx, b.cz, b.far)) != Some(&b.stamp) {
                continue; // meshed from a world that has changed since
            }
            r.upload(b.cx, b.cz, b.far, &b.mesh.opaque, &b.mesh.clear, &b.mesh.studs, &b.mesh.water);
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
                self.stamp += 1;
                self.latest.insert((cx, cz, true), self.stamp);
                self.mesher.request(&self.world, cx, cz, true, self.stamp);
            }
        }
        for &(d, cx, cz) in &order {
            let was_near = self.near_now.contains(&(cx, cz));
            let near = if was_near { d <= LOD_NEAR + LOD_HYSTERESIS } else { d <= LOD_NEAR };
            r.want(cx, cz, !near);
            if near {
                self.near_now.insert((cx, cz));
                if self.requested.insert((cx, cz, false)) {
                    self.stamp += 1;
                    self.latest.insert((cx, cz, false), self.stamp);
                    self.mesher.request(&self.world, cx, cz, false, self.stamp);
                }
            } else {
                self.near_now.remove(&(cx, cz));
            }
        }
    }

    /// Mesh a chunk again (its cells changed): both forms it has, newest world.
    fn remesh(&mut self, cx: i32, cz: i32) {
        if !(0..CHUNKS_X).contains(&cx) || !(0..CHUNKS_Z).contains(&cz) {
            return;
        }
        for far in [true, false] {
            if self.requested.contains(&(cx, cz, far)) {
                self.stamp += 1;
                self.latest.insert((cx, cz, far), self.stamp);
                self.mesher.request(&self.world, cx, cz, far, self.stamp);
            }
        }
    }

    /// Every chunk again (a field scroll, a wiped field). What is on the GPU stays drawn until its
    /// replacement arrives, so the screen never shows a hole.
    fn remesh_all(&mut self) {
        self.requested.clear();
        self.latest.clear();
        self.lod_focus = None;
    }

    /// Write the island's save now (a no-op away from the island: the island's state is what was
    /// saved on leaving it).
    fn save_island(&mut self) {
        if self.field.is_some() && !self.hotbar.is_island() {
            return;
        }
        if let Some(c) = &self.hotbar.counts {
            self.island_bag = c.clone();
        }
        let b = &self.player.body;
        let mut save = crate::island_save::IslandSave::diff(ISLAND_SEED, &self.island_pristine, &self.island_edits, &self.island_bag, [b.x, b.y, b.z, self.player.yaw]);
        if self.hotbar.is_island() {
            self.island_slots = Some(self.hotbar.slots.iter().map(|s| s.to_string()).collect());
        }
        save.hotbar = self.island_slots.clone();
        save.save();
        self.island_dirty = false;
        self.island_saved_at = self.started.elapsed().as_secs_f64();
    }

    /// Change worlds (solo island ↔ a field): new player, every chunk new.
    fn set_world(&mut self, world: Arc<World>, spawn: [f64; 3], yaw: f64) {
        self.player = Player::new(&world, spawn, yaw);
        self.pet = None;
        // a new world keeps the player's zoom (and first person); the camera re-places itself
        self.world = world;
        if let (Some(c), true) = (&self.hotbar.counts, self.hotbar.is_island()) {
            // leaving the island: its bag waits here, and the island is saved as left
            self.island_bag = c.clone();
            self.save_island();
        }
        self.hotbar = if self.field.is_some() {
            let mut h = Hotbar::field();
            if !self.menu.profile.field_bar.is_empty() {
                h.load_slots(&self.menu.profile.field_bar);
            }
            h
        } else {
            let mut h = Hotbar { counts: Some(self.island_bag.clone()), ..Hotbar::island() };
            if let Some(s) = &self.island_slots {
                h.load_slots(s);
            }
            h
        };
        self.bag.open = false;
        self.dig.stop();
        self.aim = None;
        self.props.clear();
        self.remesh_all();
        self.near_now.clear();
        if let Some(r) = &mut self.renderer {
            r.clear_chunks();
        }
    }

    /// The menu says we are in a field: make sure the game is too, then play it.
    fn field_frame(&mut self, dt: f64) {
        let now = self.started.elapsed().as_secs_f64();
        if self.field.is_none() {
            let field = FieldWindow::new();
            let spawn = field.spawn();
            let world = field.world.clone();
            self.field = Some(field);
            self.set_world(world, spawn, std::f64::consts::PI);
            log::info!("field: entered");
        }
        self.menu.update(now, LoadProgress { art: 1.0, world: 1.0 });
        if !self.menu.in_field() {
            return; // left (or the session ended) this frame
        }
        if let Some(edit) = self.menu.focused_edit() {
            if ime::sync(edit) == ime::Synced::Submit {
                self.menu.submit();
            }
        }
        // the server's changes into the window
        let (mut dirty, mut reset, mut gather) = (HashSet::new(), false, None);
        if let (Some(c), Some(field)) = (self.menu.class_mut(), self.field.as_mut()) {
            if std::mem::take(&mut c.reset) {
                field.reset();
                reset = true;
            }
            let edits = c.take_edits();
            let wet = edits.iter().filter(|e| (19..=28).contains(&e.3)).count();
            if wet > 0 {
                log::debug!("field: {} edits, {wet} of them water", edits.len());
            }
            for e in edits {
                if let Some((gx, _, gz)) = field.apply(e.0, e.1 as i32, e.2, e.3, e.4) {
                    // a cell on a chunk border changes its neighbour's faces too
                    for (ox, oz) in [(0, 0), (-1, 0), (1, 0), (0, -1), (0, 1)] {
                        dirty.insert(((gx + ox).div_euclid(CHUNK), (gz + oz).div_euclid(CHUNK)));
                    }
                }
            }
            for cell in c.take_wet() {
                if let Some((gx, _, gz)) = field.apply_wet(cell.0, cell.1 as i32, cell.2, cell.3) {
                    dirty.insert((gx.div_euclid(CHUNK), gz.div_euclid(CHUNK)));
                }
            }
            if let Some(p) = c.gather.take() {
                let (gx, gz) = field.to_grid(p[0], p[2]);
                gather = Some([gx, p[1], gz]);
            }
        }
        if let Some(field) = &self.field {
            self.world = field.world.clone();
        }
        if reset {
            self.remesh_all();
        } else {
            for (cx, cz) in dirty {
                self.remesh(cx, cz);
            }
        }
        if let Some(at) = gather {
            self.player.teleport(&self.world, at);
            let view = crate::building::WithProps { world: &self.world, props: &self.props };
            if let Some(p) = &mut self.pet {
                let b = &self.player.body;
                p.recall(&view, (b.x, b.y, b.z));
            }
        }
        // typing in the chat holds the player still
        if self.menu.focus.is_some() {
            self.input.release_all();
        }
        let visible = self.step_player(dt);
        self.step_pet(dt);
        // the window follows the player in whole chunks
        if let Some(field) = self.field.as_mut() {
            if let Some((dx, dz)) = field.recenter(self.player.body.x, self.player.body.z) {
                self.player.shift(dx as f64, dz as f64);
                self.follow.shift(dx as f64, dz as f64);
                if let Some(p) = &mut self.pet {
                    p.shift(dx as f64, dz as f64);
                }
                self.world = field.world.clone();
                self.remesh_all();
            }
        }
        // the furniture, baked again when the server changed it or the window scrolled
        if let (Some(field), Some(c)) = (self.field.as_ref(), self.menu.class_mut()) {
            let key = (c.furniture_version, field.origin_x, field.origin_z);
            if self.drawn_furniture != Some(key) {
                let mesh = crate::furniture::bake(&c.furniture, field.origin_x, field.origin_z);
                // what the body bumps into: the solid pieces, in grid cells
                self.props = crate::furniture::solid_cells(&c.furniture).into_iter().map(|(x, y, z)| (x - field.origin_x, y, z - field.origin_z)).collect();
                log::info!("furniture: {} pieces, {} vertices", c.furniture.len(), mesh.len());
                if let Some(r) = &mut self.renderer {
                    r.set_furniture(&mesh);
                }
                self.drawn_furniture = Some(key);
            }
        }
        // building (after the window settled this frame: the aim is in its grid)
        self.input.build_buttons = self.menu.focus.is_none();
        // classmates where they are drawn (grid coordinates): no block goes inside one
        let classmates: Vec<craftyap_core::body::Body> = self.menu.class_mut().map(|c| c.remotes.values().filter_map(|r| r.last_drawn).map(|g| craftyap_core::body::Body::at(g[0], g[1], g[2])).collect()).unwrap_or_default();
        let locked = self.menu.class_mut().is_some_and(|c| !c.teacher && c.settings.as_ref().is_some_and(|s| s.build_locked));
        let edits = if locked { self.dig.stop(); Vec::new() } else { self.build_frame(dt, &classmates) };
        self.update_ghost(&classmates);
        if !edits.is_empty() {
            self.apply_field_edits(&edits);
        }
        let Some(field) = &self.field else { return };
        let (ax, az) = field.to_abs(self.player.body.x, self.player.body.z);
        let (ox, oz) = (field.origin_x as f64, field.origin_z as f64);
        let anim = if self.posture == Posture::Sit {
            "sit"
        } else if self.posture == Posture::Lie {
            "lie"
        } else if !self.player.body.grounded {
            if self.player.body.vy > 0.1 { "jump" } else { "fall" }
        } else if self.player.body.vx.hypot(self.player.body.vz) > 0.5 {
            "run"
        } else {
            "idle"
        };
        let (facing, py) = (self.player.facing, self.player.body.y);
        // classmates: where the server says they were RENDER_DELAY ago
        let mut meshes: [Vec<CharVertex>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
        self.own_character(dt, visible, &mut meshes);
        let mut tags: Vec<([f32; 3], String, bool)> = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        let tt = self.menu.profile.character == "tt";
        if let Some(c) = self.menu.class_mut() {
            let (wa, ws, wl) = self.work_wire;
            let held = crate::held::item().filter(|_| self.hotbar.holding_pickaxe()).map(|i| (i.def.id.as_str(), if self.attack.active() { (self.attack.time() / i.cycle()).rem_euclid(1.0) } else { 0.0 }));
            let base = craftyap_net::protocol::Presentation {
                character: tt.then(|| "tt".to_owned()),
                emote: (self.emote_wire.1 > 0).then(|| self.emote_wire.0.to_owned()),
                emote_seq: (self.emote_wire.1 > 0).then_some(self.emote_wire.1),
                ..Default::default()
            };
            c.tick_move(dt, now, [ax, py, az], facing, anim, (wa, ws, wl), held, base);
            let t = c.draw_time(now);
            for r in c.remotes.values_mut() {
                let Some((pos, yaw)) = r.at(t) else { continue };
                let grid = [pos[0] - ox, pos[1], pos[2] - oz];
                let moved = r.last_drawn.map_or(0.0, |l| ((grid[0] - l[0]).powi(2) + (grid[2] - l[2]).powi(2)).sqrt());
                r.last_drawn = Some(grid);
                // speed from how far the drawn body went (what the eye sees), not the reports
                let speed = if dt > 0.0 && moved < 4.0 { (moved / dt) as f32 } else { 0.0 };
                r.speed += (speed - r.speed) * (dt as f32 * 10.0).min(1.0);
                let kind = Kind::from_wire(r.character.as_deref());
                let Some(model) = character::model(kind) else { continue };
                let anim = self.remote_anims.entry(r.id.clone()).or_insert_with(|| Animator::new(r.id.bytes().map(u32::from).sum()));
                let posture = match r.anim.as_str() {
                    "sit" => Posture::Sit,
                    "lie" => Posture::Lie,
                    "crawl" => Posture::Crawl,
                    _ => Posture::Stand,
                };
                let air = r.anim == "jump" || r.anim == "fall";
                let motion = Motion { speed: if air { 0.0 } else { r.speed }, grounded: !air, vy: if r.anim == "jump" { 1.0 } else { -1.0 }, posture };
                let entries = anim.update(model, motion, dt as f32);
                anim.perform(&r.action.0, r.action.1, r.action.2);
                anim.emote(&r.emote.0, r.emote.1);
                anim.update_upper(model, motion, dt as f32);
                let upper = anim.upper();
                let at = Vec3::new(grid[0] as f32, grid[1] as f32, grid[2] as f32);
                model.skin_layered(&entries, &upper, at, yaw as f32, &mut meshes[kind as usize]);
                tags.push(([at.x, at.y + model.height + 0.35, at.z], r.name.clone(), r.teacher));
                seen.push(r.id.clone());
            }
        }
        self.remote_anims.retain(|id, _| seen.contains(id));
        let scale = self.scale();
        let pointer = self.pointer;
        let hud = self.renderer.as_ref().and_then(|r| r.surface_size()).map(|s| self.play_hud(s.0 as f32 / scale as f32, s.1 as f32 / scale as f32));
        let Some(r) = &mut self.renderer else { return };
        r.world_visible = true;
        r.set_actor(&[]);
        if let Some((w, h, rgba)) = self.face_pending.take() {
            r.set_face_texture(w, h, &rgba);
            self.face_live = true;
        }
        upload_characters(r, &meshes);
        let Some(size) = r.surface_size() else { return };
        let (w, h) = (size.0 as f64 / scale, size.1 as f64 / scale);
        self.input.set_screen(w, h);
        self.text.begin_frame();
        let mut p = Painter::new(size, scale).with_art(&self.art_sizes);
        // name tags over heads (projected; behind the camera or off screen: none)
        let vp = self.camera.view_proj((w / h) as f32);
        for (at, name, teacher) in &tags {
            let clip = vp * glam::Vec4::new(at[0], at[1], at[2], 1.0);
            if clip.w <= 0.1 {
                continue;
            }
            let (nx, ny) = (clip.x / clip.w, clip.y / clip.w);
            if nx.abs() > 1.1 || ny.abs() > 1.1 {
                continue;
            }
            let (sx, sy) = ((nx * 0.5 + 0.5) * w as f32, (0.5 - ny * 0.5) * h as f32);
            let label = if *teacher { format!("{name} 선생님") } else { name.clone() };
            p.name_plate(&mut self.text, &label, sx, sy, *teacher);
        }
        if let (None, Some(hud)) = (self.menu.focus, &hud) {
            draw_play_hud(&mut p, &mut self.text, hud);
        }
        let touch = cfg!(target_os = "android") || self.input.touch_mode;
        let mut ui = Ui { p: &mut p, t: &mut self.text, ptr: pointer, enabled: true, time: now as f32 };
        self.menu.draw(&mut ui, touch);
        r.set_overlay(&p.vertices, &p.segments, &self.text.take_uploads());
        self.end_pointer_frame();
        self.sync_ime_window();
    }

    /// One frame of building: aim, dig (held), place (presses). Returns the cells to write (grid).
    fn build_frame(&mut self, dt: f64, classmates: &[craftyap_core::body::Body]) -> Vec<(i32, i32, i32, u8, u8)> {
        let b = &self.player.body;
        let eye = [b.x, b.y + EYE_HEIGHT, b.z];
        self.aim = building::aim(&self.world, eye, self.player.yaw, self.player.pitch, self.hotbar.holding_water());
        let digging = self.mouse_dig || self.input.dig_held();
        let pressed = digging && !self.dig_was;
        self.dig_was = digging;
        let places = std::mem::take(&mut self.place_clicks) + self.input.take_place_taps();
        for _ in 0..self.input.take_shape_taps() {
            self.next_piece();
        }
        for _ in 0..self.input.take_turn_taps() {
            self.turn_piece(false);
        }
        let strike = self.step_strike(dt, digging, pressed);
        for f in &mut self.poofs {
            f.1 += dt as f32;
        }
        self.poofs.retain(|f| f.1 < crate::ui::POOF_SECONDS);
        let mut edits = Vec::new();
        let Some(hit) = self.aim else {
            self.dig.stop();
            return edits;
        };
        let [x, y, z] = hit.voxel;
        if pressed || places > 0 {
            log::debug!("build: aim {:?} before {:?} dist {:.2}, body {:.1},{:.1},{:.1} pitch {:.2}", hit.voxel, hit.before, hit.dist, self.player.body.x, self.player.body.y, self.player.body.z, self.player.pitch);
        }
        if digging {
            if self.hotbar.holding_water() {
                // the bucket scoops water (a press, not a hold)
                if pressed && craftyap_core::fluid::is_water(self.world.get(x, y, z)) {
                    edits.push((x, y, z, 0, 0));
                    self.sound.play("splash", 0.3);
                }
            } else if self.hotbar.holding_pickaxe() {
                // the pickaxe: strokes (a press commits one, holding repeats), and the block gives
                // way to blade impacts, each worth the swing's seconds × the block's efficiency
                self.player.act();
                self.dig_family = crate::sound::family_of_block(self.world.get(x, y, z));
                if pressed {
                    self.attack.request();
                }
            } else {
                let family = crate::sound::family_of_block(self.world.get(x, y, z));
                self.player.act();
                self.digging_now = true;
                self.dig_family = family;
                if let Some(block) = self.dig.step(&self.world, [x, y, z], dt) {
                    self.hotbar.collect(block);
                    edits.push((x, y, z, 0, 0));
                    self.sound.block(crate::sound::BlockSound::Break, family);
                    self.poofs.push((Vec3::new(x as f32 + 0.5, y as f32 + 0.5, z as f32 + 0.5), 0.0));
                    self.dig_beat = 0.0;
                } else if self.dig.fraction(&self.world).is_some() && character::model(Kind::Home).is_none() {
                    // hand digging taps on a beat (the web's fallback when there is no hand cue)
                    self.dig_beat -= dt;
                    if self.dig_beat <= 0.0 {
                        self.dig_beat = 0.35;
                        self.sound.block(crate::sound::BlockSound::Hit, family);
                    }
                }
            }
        } else {
            self.dig.stop();
        }
        // pickaxe impacts on the aimed block
        if let (Some(st), Some(item)) = (strike, crate::held::item()) {
            if st.to > st.from {
                let block = self.world.get(x, y, z);
                let key = building::def_by_id(block).map_or("", |d| d.key);
                let work = item.work(st.from, st.to, key);
                if let Some(broken) = self.dig.step(&self.world, [x, y, z], work) {
                    self.hotbar.collect(broken);
                    edits.push((x, y, z, 0, 0));
                    self.sound.block(crate::sound::BlockSound::Break, self.dig_family);
                    self.poofs.push((Vec3::new(x as f32 + 0.5, y as f32 + 0.5, z as f32 + 0.5), 0.0));
                } else if item.impacts(st.from, st.to) > 0 {
                    self.sound.block(crate::sound::BlockSound::Hit, self.dig_family);
                }
            }
        }
        if places > 0 {
            let cell = hit.before;
            let mut bodies = vec![self.player.body];
            bodies.extend_from_slice(classmates);
            // never a block inside the pet (craftGame.ts canPlace)
            bodies.extend(self.pet.as_ref().map(|p| p.body));
            if building::can_place(&self.world, &self.props, cell, &bodies) {
                if let Some(block) = self.hotbar.take() {
                    let shape = if craftyap_core::fluid::is_water(block) { 0 } else { building::piece_shape(self.piece, self.piece_rot, self.piece_tilt) };
                    edits.push((cell[0], cell[1], cell[2], block, shape));
                    if shape == 0 {
                        self.sound.play("splash", 0.25);
                    } else {
                        self.sound.place();
                        self.player.act();
                        self.own_anim.restart_work("Place");
                        begin_work(&mut self.work_wire, "place", false);
                        self.poofs.push((Vec3::new(cell[0] as f32 + 0.5, cell[1] as f32 + 0.3, cell[2] as f32 + 0.5), 0.0));
                    }
                }
            }
        }
        edits
    }

    /// The island is ours alone: write the cells and mesh their chunks again.
    fn apply_island_edits(&mut self, edits: &[(i32, i32, i32, u8, u8)]) {
        if edits.is_empty() {
            return;
        }
        let w = Arc::make_mut(&mut self.world);
        for &(x, y, z, block, shape) in edits {
            if shape == 0 { w.set(x, y, z, block) } else { w.set_shaped(x, y, z, block, shape) }
            // what the cell holds now (set_shaped may have refused a shape)
            self.island_edits.insert((x, y, z), (w.get(x, y, z), w.get_shape(x, y, z)));
        }
        self.island = self.world.clone();
        self.island_dirty = true;
        self.remesh_cells(edits.iter().map(|e| (e.0, e.2)));
    }

    /// The field is shared: write the cells at once (the web's optimistic edit) and tell the class;
    /// a refusal comes back as the server's own values (s-k-reject) like any edit.
    fn apply_field_edits(&mut self, edits: &[(i32, i32, i32, u8, u8)]) {
        let Some(field) = self.field.as_mut() else { return };
        let mut wire = Vec::new();
        for &(x, y, z, block, shape) in edits {
            let (ax, az) = (x + field.origin_x, z + field.origin_z);
            field.apply(ax, y, az, block, shape);
            wire.push(craftyap_net::protocol::Edit(ax, y as u8, az, block, shape));
        }
        self.world = field.world.clone();
        if let Some(c) = self.menu.class_mut() {
            c.send_edits(wire);
        }
        self.remesh_cells(edits.iter().map(|e| (e.0, e.2)));
    }

    /// Mesh again the chunks around these grid columns (a border cell changes its neighbour too).
    fn remesh_cells(&mut self, cells: impl Iterator<Item = (i32, i32)>) {
        let mut dirty = HashSet::new();
        for (gx, gz) in cells {
            for (ox, oz) in [(0, 0), (-1, 0), (1, 0), (0, -1), (0, 1)] {
                dirty.insert(((gx + ox).div_euclid(CHUNK), (gz + oz).div_euclid(CHUNK)));
            }
        }
        for (cx, cz) in dirty {
            self.remesh(cx, cz);
        }
    }

    /// What the play HUD shows this frame (a snapshot, so drawing never borrows the app).
    fn play_hud(&mut self, w: f32, h: f32) -> PlayHud {
        let touch = cfg!(target_os = "android") || self.input.touch_mode;
        self.hud_size = (w, h);
        let slots = (0..10)
            .map(|i| {
                let key = self.hotbar.slots[i];
                let icon = item_icon(key);
                (icon, self.hotbar.count(i))
            })
            .collect();
        let aim = self.aim.as_ref().map(|hit| {
            let v = hit.voxel;
            let min = Vec3::new(v[0] as f32, v[1] as f32, v[2] as f32);
            (min, min + Vec3::ONE)
        });
        let face = self.aim.as_ref().map(|hit| {
            let (v, b) = (hit.voxel, hit.before);
            let n = Vec3::new((b[0] - v[0]) as f32, (b[1] - v[1]) as f32, (b[2] - v[2]) as f32);
            let c = Vec3::new(v[0] as f32 + 0.5, v[1] as f32 + 0.5, v[2] as f32 + 0.5) + n * 0.501;
            // two axes across the face
            let u = if n.x.abs() > 0.5 { Vec3::Z } else { Vec3::X };
            let w2 = n.cross(u);
            [c + (u + w2) * 0.5, c + (u - w2) * 0.5, c - (u + w2) * 0.5, c - (u - w2) * 0.5]
        });
        PlayHud {
            w,
            h,
            face,
            rects: Painter::hotbar_rects(w, h, touch),
            slots,
            selected: self.hotbar.selected,
            aim,
            dig: self.dig.fraction(&self.world),
            view_proj: self.camera.view_proj(w / h.max(1.0)),
            eye: self.camera.eye(),
            touch: self.input.touch_ui(),
            poofs: self.poofs.clone(),
            island: self.field.is_none() && !self.menu.in_field(),
            piece: self.piece,
            emote: self.emote_open.then_some((self.posture, self.menu.profile.character == "tt")),
            layout: crate::hud_layout::layout(w, h, touch, self.menu.in_field()),
            me: self.menu.profile.name.clone(),
            chatting: self.menu.chatting(),
            bag: self.bag.open.then(|| {
                let items = self.hotbar.items();
                let shown = crate::bag::shown(&items, self.bag.tab);
                let rects = Painter::hotbar_rects(w, h, touch);
                let bottom = rects.first().map_or(h - 70.0, |r| r.y - 6.0);
                let l = crate::bag::layout(w, h, crate::hud_layout::MARGIN, bottom, shown.len(), self.bag.scroll);
                self.bag.scroll = self.bag.scroll.clamp(0.0, l.max_scroll);
                let tiles = shown.iter().map(|(k, n)| (item_icon(k), *n)).collect();
                (l, tiles, self.bag.tab, self.bag.armed)
            }),
            time: self.started.elapsed().as_secs_f32(),
            pet: self.pet.as_ref().map(|c| {
                let order = crate::pet::data().map_or(0, |d| d.order.iter().position(|k| k == c.rig.species).unwrap_or(0));
                (self.pet_open, order, c.brain.mode == crate::pet::Mode::Stay)
            }),
        }
    }

    /// A click is one frame long.
    fn end_pointer_frame(&mut self) {
        self.pointer.pressed = false;
        self.pointer.released = false;
        self.pointer.dy = 0.0;
        if !self.pointer.down {
            self.pointer.dragged = false;
        }
    }

    /// The window's scale factor (physical pixels per dp).
    fn scale(&self) -> f64 {
        self.window.as_ref().map_or(1.0, |w| w.scale_factor())
    }

    /// Capture the mouse for looking (desktop): locked if the platform can, confined otherwise.
    fn capture(&mut self, on: bool) {
        let Some(w) = &self.window else { return };
        if on {
            let ok = w.set_cursor_grab(CursorGrabMode::Locked).or_else(|_| w.set_cursor_grab(CursorGrabMode::Confined)).is_ok();
            w.set_cursor_visible(!ok);
            self.input.set_captured(ok, Instant::now());
        } else {
            let _ = w.set_cursor_grab(CursorGrabMode::None);
            w.set_cursor_visible(true);
            self.input.set_captured(false, Instant::now());
        }
    }

    /// Pictures decoded since last frame go to the GPU (and are kept for a new device).
    fn take_art(&mut self) {
        for img in self.art.take() {
            self.art_sizes[img.slot] = Some((img.width, img.height));
            if let Some(r) = &mut self.renderer {
                r.add_art(&img);
            }
            self.art_images.push(img);
        }
    }

    /// One menu frame: the server state ticks, the top screen draws over the art.
    fn menu_frame(&mut self) {
        let scale = self.scale();
        let loaded = self.art_sizes[..ALL_ART.len()].iter().filter(|s| s.is_some()).count() as f32 / ALL_ART.len() as f32;
        let world = self.renderer.as_ref().map_or(0.0, |r| r.chunk_count() as f32 / (CHUNKS_X * CHUNKS_Z) as f32).min(1.0);
        let now = self.started.elapsed().as_secs_f64();
        self.menu.update(now, LoadProgress { art: loaded, world });
        if let Some(edit) = self.menu.focused_edit() {
            if ime::sync(edit) == ime::Synced::Submit {
                self.menu.submit();
            }
        }
        let touch = cfg!(target_os = "android") || self.input.touch_mode;
        let Some(r) = &mut self.renderer else { return };
        r.world_visible = false;
        r.set_actor(&[]);
        let Some(size) = r.surface_size() else { return };
        self.text.begin_frame();
        let mut p = Painter::new(size, scale).with_art(&self.art_sizes);
        let mut ui = Ui { p: &mut p, t: &mut self.text, ptr: self.pointer, enabled: true, time: now as f32 };
        let outcome = self.menu.draw(&mut ui, touch);
        r.set_overlay(&p.vertices, &p.segments, &self.text.take_uploads());
        self.end_pointer_frame();
        if outcome == Outcome::PlaySolo {
            log::info!("menu: play solo");
            self.in_menu = false;
            if let Some(r) = &mut self.renderer {
                r.world_visible = true;
            }
        }
        self.sync_ime_window();
    }

    /// Desktop: the OS input method is on only while a field is focused.
    fn sync_ime_window(&self) {
        if cfg!(not(target_os = "android")) {
            if let Some(w) = &self.window {
                w.set_ime_allowed((self.in_menu || self.menu.in_field()) && self.menu.focus.is_some());
            }
        }
    }

    /// The menu screens own the pointer and keys (not the field, which is the game with a HUD).
    fn menu_owns_input(&self) -> bool {
        self.in_menu && !self.menu.in_field()
    }

    /// Back (Android) / Escape: the menu goes back a screen; in play, back to the menu.
    fn back(&mut self) {
        if self.in_menu {
            self.menu.back();
        } else {
            self.capture(false);
            self.input.release_all();
            self.in_menu = true;
        }
    }

    fn pointer_down(&mut self, x: f32, y: f32) {
        self.pointer.pos = (x, y);
        self.pointer.press_at = (x, y);
        self.pointer.down = true;
        self.pointer.pressed = true;
        self.pointer.dragged = false;
    }

    fn pointer_move(&mut self, x: f32, y: f32) {
        if self.pointer.down {
            self.pointer.dy += y - self.pointer.pos.1;
            let (dx, dy) = (x - self.pointer.press_at.0, y - self.pointer.press_at.1);
            if dx * dx + dy * dy > 12.0 * 12.0 {
                self.pointer.dragged = true;
            }
        }
        self.pointer.pos = (x, y);
    }

    fn pointer_up(&mut self, x: f32, y: f32) {
        self.pointer.pos = (x, y);
        self.pointer.down = false;
        self.pointer.released = true;
    }

    /// The player's own character (HOME; TT once the emote menu exists natively), animated from
    /// the body, skipped while the camera is inside it.
    fn own_character(&mut self, dt: f64, visible: f64, meshes: &mut [Vec<CharVertex>; 4]) {
        let kind = Kind::from_wire((self.menu.profile.character == "tt").then_some("tt"));
        let Some(model) = character::model(kind) else { return };
        // the live face: the character's own canvas, blinking and playing its expressions
        self.face_loader.want(kind);
        self.face_loader.poll();
        if self.face.as_ref().is_none_or(|f| f.kind != kind) {
            self.face = Some(crate::face::Face::new(kind));
            self.face_live = false;
        }
        if let Some(f) = &mut self.face {
            f.update(&self.face_loader, dt as f32);
            if let Some(rgba) = f.take() {
                let (w, h, _) = crate::face::canvas(kind);
                self.face_pending = Some((w, h, rgba.to_vec()));
            }
        }
        let b = &self.player.body;
        let motion = Motion { speed: b.vx.hypot(b.vz) as f32, grounded: b.grounded, vy: b.vy as f32, posture: self.posture };
        let entries = self.own_anim.update(model, motion, dt as f32);
        // the hands: Interact while digging (a Place one-shot keeps playing through), else nothing
        if std::mem::take(&mut self.digging_now) {
            self.own_anim.set_work(Some(("Interact", true)));
            begin_work(&mut self.work_wire, "interact", true);
        } else if self.own_anim_work_is("Interact") {
            self.own_anim.set_work(None);
            begin_work(&mut self.work_wire, "none", false);
        }
        self.own_anim.update_upper(model, motion, dt as f32);
        if self.own_anim.take_tap() && self.dig.fraction(&self.world).is_some() {
            self.sound.block(crate::sound::BlockSound::Hit, self.dig_family);
        }
        if self.own_anim.take_step() && b.grounded {
            // the block underfoot (the cell just below the feet), wet in shallow water
            let (fx, fy, fz) = (b.x.floor() as i32, (b.y - 0.05).floor() as i32, b.z.floor() as i32);
            let wet = craftyap_core::fluid::is_water(self.world.water_at(fx, fy + 1, fz));
            let family = crate::sound::family_of_block(self.world.get(fx, fy, fz));
            self.sound.step(family, wet);
        }
        if visible <= 0.5 {
            return;
        }
        let feet = self.player.drawn();
        let upper = self.own_anim.upper();
        let at = Vec3::new(feet[0] as f32, feet[1] as f32, feet[2] as f32);
        let holding = self.hotbar.holding_pickaxe() && !self.bag.open;
        let item = crate::held::item();
        let grip = item.and_then(|i| crate::held::grip(model, &i.def));
        let [m0, m1, m2, m3] = meshes;
        // drawn with the live face once it is on the GPU, the model's own texture until then
        let body = if self.face_live { m3 } else if kind == Kind::Home { m0 } else { m1 };
        match (item, grip) {
            (Some(item), Some(grip)) => {
                let phase = self.attack.active().then(|| self.attack.time() / item.cycle());
                let frame = crate::held::Frame { dt: dt as f32, phase, allowed: holding && b.grounded || holding && self.attack.active(), speed: motion.speed, gait_phase: self.own_anim.gait_phase(), grounded: b.grounded, yaw: self.player.facing as f32 };
                let hold = character::Hold { pose: &mut self.held_pose, grip: &grip, item, frame, out: m2 };
                model.skin_held(&entries, &upper, Some(hold), at, self.player.facing as f32, body);
            }
            _ => model.skin_layered(&entries, &upper, at, self.player.facing as f32, body),
        }
    }

    fn own_anim_work_is(&self, clip: &str) -> bool {
        self.own_anim.work().is_some_and(|w| w.0 == clip)
    }

    /// The pet: spawned beside the player (a new world, a new adoption), stepped and posed.
    fn step_pet(&mut self, dt: f64) {
        let species = crate::pet::species_or_dog(&self.menu.profile.pet);
        let view = crate::building::WithProps { world: &self.world, props: &self.props };
        let b = &self.player.body;
        let owner = (b.x, b.y, b.z);
        if self.pet.is_none() {
            self.pet = crate::pet::Companion::new(&view, (b.x + 1.2, b.y, b.z + 1.2), species, 0x9e37_79b9);
        }
        self.pet_mesh.clear();
        if let Some(p) = &mut self.pet {
            if p.rig.species != species {
                p.adopt(&view, species);
            }
            p.frame(&view, owner, dt, &mut self.pet_mesh);
            // a camera squeezed against the pet (a wall at the player's back) would sit inside it:
            // the pet gives way, as the robot does, instead of filling the screen
            // and so does a pet near the camera that stands between it and the player (a corridor)
            let (e, b) = (self.follow.eye, &p.body);
            let (hw, h) = (b.w.unwrap_or(0.5) / 2.0, b.h.unwrap_or(1.0));
            let lo = DVec3::new(b.x - hw - 0.3, b.y - 0.3, b.z - hw - 0.3);
            let hi = DVec3::new(b.x + hw + 0.3, b.y + h + 0.3, b.z + hw + 0.3);
            let inside = e.cmpgt(lo).all() && e.cmplt(hi).all();
            let chest = DVec3::new(owner.0, owner.1 + 0.8, owner.2);
            let near = (DVec3::new(b.x, b.y + h / 2.0, b.z) - e).length() < 3.0;
            if inside || near && segment_hits_box(e, chest, lo + 0.3, hi - 0.3) {
                self.pet_mesh.clear();
            }
        }
        if let Some(r) = &mut self.renderer {
            r.set_pets(&self.pet_mesh);
        }
    }

    /// Sit ↔ follow (P, the chip's button), voiced in a toast.
    fn toggle_pet(&mut self) {
        if let Some(p) = &mut self.pet {
            let name = p.rig.def().name.clone();
            let msg = match p.brain.toggle() {
                crate::pet::Mode::Stay => format!("{name}: 앉아! 여기서 기다려요"),
                crate::pet::Mode::Follow => format!("{name}: 따라와! 다시 따라가요"),
            };
            self.menu.toast(msg);
        }
    }

    /// Adopt an animal (Y cycles, the chip's row picks), remembered in the profile.
    fn adopt_pet(&mut self, key: &str) {
        let key = crate::pet::species_or_dog(key);
        if self.menu.profile.pet == key {
            return;
        }
        self.menu.profile.pet = key.to_owned();
        self.menu.profile.save();
        if let Some(name) = crate::pet::data().and_then(|d| d.species.get(key)).map(|s| s.name.clone()) {
            self.menu.toast(format!("{name}{} 데려왔어요!", crate::pet::object_particle(&name)));
        }
    }

    /// A tap or click on the pet chip or its row. True when it hit (the touch is used up).
    fn pet_tap(&mut self, x: f32, y: f32) -> bool {
        use crate::hud_layout::Sys;
        let (w, h) = self.hud_size;
        let touch = cfg!(target_os = "android") || self.input.touch_mode;
        let l = crate::hud_layout::layout(w, h, touch, self.menu.in_field());
        if self.emote_open {
            let (panel, items, _) = crate::hud_layout::emote_panel(w);
            if let Some(&(it, _)) = items.iter().find(|(_, r)| r.contains(x, y)) {
                self.emote(it);
                return true;
            }
            if panel.contains(x, y) {
                return true;
            }
        }
        if let Some(&(sys, _)) = l.system.iter().find(|(_, r)| r.contains(x, y)) {
            if sys != Sys::Emote {
                self.emote_open = false;
            }
            match sys {
                Sys::Emote => {
                    self.emote_open = !self.emote_open;
                    self.pet_open = false;
                }
                Sys::Pet => self.pet_open = !self.pet_open,
                Sys::Bag => self.toggle_bag(),
                Sys::Chat => {
                    self.pet_open = false;
                    self.menu.open_chat();
                }
                Sys::Menu => {
                    self.pet_open = false;
                    if self.menu.in_field() {
                        self.menu.leave_class();
                    } else {
                        self.back();
                    }
                }
            }
            return true;
        }
        if !self.pet_open || self.pet.is_none() {
            return false;
        }
        let Some(i) = l.pet_row.iter().position(|r| r.contains(x, y)) else { return false };
        if i < 5 {
            if let Some(key) = crate::pet::data().and_then(|d| d.order.get(i)).cloned() {
                self.adopt_pet(&key);
            }
        } else {
            self.toggle_pet();
        }
        self.pet_open = false;
        true
    }

    /// itemAttack.ts for the held pickaxe: advance the strike (held: the dig input, pressed: a new
    /// press commits a stroke); a new stroke whooshes. None when no pickaxe is held.
    fn step_strike(&mut self, dt: f64, held: bool, pressed: bool) -> Option<crate::held::Step> {
        let item = crate::held::item()?;
        if !self.hotbar.holding_pickaxe() {
            self.attack.reset();
            return None;
        }
        if pressed {
            self.attack.request();
        }
        let cycle = item.cycle();
        let st = self.attack.step(dt as f32, held, cycle);
        if st.to > st.from && (st.started || (st.from / cycle).floor() != (st.to / cycle).floor()) {
            self.sound.play("swing", 0.32);
        }
        if st.active || st.completed {
            begin_work(&mut self.work_wire, "interact", true);
        } else if self.work_wire.0 == "interact" {
            begin_work(&mut self.work_wire, "none", false);
        }
        Some(st)
    }

    /// The ghost of what a place would put where the crosshair is: the held block in the held
    /// piece's shape, green where it fits and red where it does not (craftGame.ts ghostOk / Bad).
    /// Meshed only when the target, block, shape or fit changes.
    fn update_ghost(&mut self, classmates: &[craftyap_core::body::Body]) {
        let want = (|| {
            if self.bag.open || self.hotbar.holding_pickaxe() || self.hotbar.holding_water() {
                return None;
            }
            let hit = self.aim.as_ref()?;
            let block = building::def(self.hotbar.key())?.id;
            let shape = building::piece_shape(self.piece, self.piece_rot, self.piece_tilt);
            let mut bodies = vec![self.player.body];
            bodies.extend_from_slice(classmates);
            bodies.extend(self.pet.as_ref().map(|p| p.body));
            let fits = building::can_place(&self.world, &self.props, hit.before, &bodies) && self.hotbar.count(self.hotbar.selected) != Some(0);
            Some((hit.before, block, shape, fits))
        })();
        if want == self.ghost_key {
            return;
        }
        let mut verts = Vec::new();
        let tables = self.ghost_tables.get_or_insert_with(crate::chunks::tables);
        let w = self.ghost_world.get_or_insert_with(World::default);
        if let Some((cell, _, _, _)) = self.ghost_key {
            w.set(cell[0], cell[1], cell[2], 0);
        }
        if let Some((cell, block, shape, fits)) = want {
            if World::in_bounds(cell[0], cell[1], cell[2]) {
                w.set_shaped(cell[0], cell[1], cell[2], block, shape);
                let m = crate::chunks::mesh_chunk(w, tables, cell[0].div_euclid(crate::chunks::CHUNK), cell[2].div_euclid(crate::chunks::CHUNK), false);
                let tint: [u8; 3] = if fits { [0x8c, 0xe8, 0x7a] } else { [0xe8, 0x69, 0x5b] };
                for mut v in m.opaque.into_iter().chain(m.clear) {
                    v.look = [tint[0], tint[1], tint[2], v.look[3]];
                    // a hair larger than the cell, so the ghost sits on neighbours without z-fighting
                    let c = glam::Vec3::new(cell[0] as f32 + 0.5, cell[1] as f32 + 0.5, cell[2] as f32 + 0.5);
                    let p = c + (glam::Vec3::from(v.pos) - c) * 1.01;
                    v.pos = p.into();
                    verts.push(v);
                }
            }
        }
        self.ghost_key = want;
        if let Some(r) = &mut self.renderer {
            r.set_ghost(&verts);
        }
    }

    fn face_play(&mut self, clip: &str, end: &str) {
        if let Some(f) = &mut self.face {
            f.play(clip, end);
        }
    }

    fn face_set(&mut self, face: &str) {
        if let Some(f) = &mut self.face {
            f.set(face);
        }
    }

    /// An emote panel choice: a gesture plays once (and goes on the wire), a posture is taken (not
    /// in the air, as adoptPosture refuses), the character is switched and remembered.
    fn emote(&mut self, item: crate::hud_layout::EmoteItem) {
        use crate::hud_layout::EmoteItem as E;
        let wire = |s: &mut Self, id: &'static str| s.emote_wire = (id, (s.emote_wire.1 + 1) % 1_000_000_000);
        match item {
            E::Wave => {
                self.posture = Posture::Stand;
                self.own_anim.restart_work("Wave");
                self.face_play("smile", "neutral");
                wire(self, "wave");
            }
            E::Cheer => {
                self.posture = Posture::Stand;
                self.own_anim.restart_work("Cheer");
                self.face_play("laugh", "neutral");
                wire(self, "cheer");
            }
            E::Smile | E::Laugh | E::Wink => {
                let (clip, id) = match item {
                    E::Smile => ("smile", "smile"),
                    E::Laugh => ("laugh", "laugh"),
                    _ => ("wink", "wink"),
                };
                self.face_play(clip, "neutral");
                wire(self, id);
            }
            E::Sit | E::Lie | E::Stand => {
                if !self.player.body.grounded {
                    self.menu.toast("땅 위에서 할 수 있어요");
                    return;
                }
                self.posture = match item {
                    E::Sit => Posture::Sit,
                    E::Lie => Posture::Lie,
                    _ => Posture::Stand,
                };
                // character.ts: sitting smiles, lying dozes off, standing is neutral
                match item {
                    E::Sit => self.face_set("smile"),
                    E::Lie => self.face_play("sleepy", "sleep"),
                    _ => self.face_set("neutral"),
                }
                wire(self, match item {
                    E::Sit => "sit",
                    E::Lie => "lie",
                    _ => "stand",
                });
            }
            E::Home | E::Tt => {
                let id = if item == E::Tt { "tt" } else { "mascot" };
                if self.menu.profile.character != id {
                    self.menu.profile.character = id.into();
                    self.menu.profile.save();
                    self.menu.toast(if item == E::Tt { "캐릭터: TT" } else { "캐릭터: HOME" });
                }
            }
        }
        self.emote_open = false;
    }

    /// F: the next construction shape (upright again), named in a toast.
    fn next_piece(&mut self) {
        self.piece = (self.piece + 1) % building::PIECES.len();
        self.piece_rot = 0;
        self.piece_tilt = 0;
        self.menu.toast(format!("모양: {}", building::PIECES[self.piece].1));
    }

    /// R turns the piece a quarter (T: `tip` tips it over); round and square pieces do not turn.
    fn turn_piece(&mut self, tip: bool) {
        if !building::PIECES[self.piece].2 {
            return;
        }
        if tip {
            self.piece_tilt = (self.piece_tilt + 1) % 4;
        } else {
            self.piece_rot = (self.piece_rot + 1) % 4;
        }
    }

    /// Open / close the bag. Open, the world's input stops (a desktop gets its mouse back); closed,
    /// play resumes where it was.
    fn toggle_bag(&mut self) {
        self.bag.toggle(self.hotbar.selected);
        self.pet_open = false;
        self.input.release_all();
        self.mouse_dig = false;
        if !self.input.touch_mode {
            self.capture(!self.bag.open);
        }
    }

    /// A tap while the bag is open (dp). Everything goes to the bag: its close, tabs and tiles, a
    /// hotbar slot (arms it), the bag button (closes); anywhere else does nothing.
    fn bag_tap(&mut self, x: f32, y: f32) {
        let (w, h) = self.hud_size;
        let touch = cfg!(target_os = "android") || self.input.touch_mode;
        if crate::hud_layout::layout(w, h, touch, self.menu.in_field()).sys(crate::hud_layout::Sys::Bag).is_some_and(|r| r.contains(x, y)) {
            self.toggle_bag();
            return;
        }
        if let Some(slot) = Painter::hotbar_rects(w, h, touch).iter().position(|r| r.contains(x, y)) {
            self.hotbar.select(slot);
            self.bag.arm(slot);
            return;
        }
        let items = self.hotbar.items();
        let shown = crate::bag::shown(&items, self.bag.tab);
        let bottom = Painter::hotbar_rects(w, h, touch).first().map_or(h - 70.0, |r| r.y - 6.0);
        let l = crate::bag::layout(w, h, crate::hud_layout::MARGIN, bottom, shown.len(), self.bag.scroll);
        if l.close.contains(x, y) {
            self.toggle_bag();
            return;
        }
        if let Some(t) = l.tabs.iter().position(|r| r.contains(x, y)) {
            self.bag.set_tab(t);
            return;
        }
        let hit = l.tiles.iter().find(|(_, r)| r.contains(x, y) && l.grid.contains(x, y)).map(|(i, _)| *i);
        if let Some(key) = hit.and_then(|i| shown.get(i)).map(|i| i.0) {
            let slot = self.bag.armed;
            if self.hotbar.assign(slot, key) {
                self.hotbar.select(slot);
                self.bag.advance(slot);
                self.remember_bar();
            }
        }
    }

    /// Keep the bar as loaded: the island's goes in its save, the field's in the profile.
    fn remember_bar(&mut self) {
        if self.hotbar.is_island() {
            self.island_dirty = true;
        } else {
            self.menu.profile.field_bar = self.hotbar.slots.iter().map(|s| s.to_string()).collect();
            self.menu.profile.save();
        }
    }

    /// Input -> player -> follow camera. Returns how visible the body is (the camera pulls in).
    fn step_player(&mut self, dt: f64) -> f64 {
        // Roblox's mobile zoom: spreading two fingers zooms in (dp of spread → metres)
        let pinch = self.input.take_pinch();
        self.follow.zoom_by(-pinch * 0.04);
        self.player.first_person = self.follow.first_person();
        let st = &self.menu.profile.settings;
        let mut intent = self.input.intent(st.sensitivity, st.invert_y);
        if self.posture != Posture::Stand {
            if intent.forward != 0.0 || intent.strafe != 0.0 || intent.jump {
                self.posture = Posture::Stand;
                if let Some(f) = &mut self.face {
                    f.set("neutral");
                }
            } else {
                // seated or lying: the body stays put (no drift, no jump)
                intent.jump = false;
            }
        }
        self.player.update(&self.world, &self.props, &intent, dt);
        let feet = self.player.drawn();
        let eye = DVec3::new(feet[0], feet[1] + EYE_HEIGHT, feet[2]);
        let visible = self.follow.update(&self.world, eye, self.player.body.y + EYE_HEIGHT, self.player.view_yaw, self.player.view_pitch, self.player.running, dt);
        self.camera.follow = Some((self.follow.eye.as_vec3(), self.follow.target.as_vec3(), self.follow.fov as f32));
        self.camera.focus = Vec3::new(feet[0] as f32, feet[1] as f32, feet[2] as f32);
        visible
    }

    /// One frame of play: input -> player -> follow camera -> the body and the overlay.
    fn play(&mut self, dt: f64) {
        self.menu.set_now(self.started.elapsed().as_secs_f64());
        if self.camera.fixed.is_some() {
            return; // a comparison shot: the camera stays pinned
        }
        // back from a field: the island again
        if self.field.take().is_some() {
            self.drawn_furniture = None;
            if let Some(r) = &mut self.renderer {
                r.set_furniture(&[]);
            }
            let island = self.island.clone();
            let ground = surface_y(&island, SPAWN.0.floor() as i32, SPAWN.1.floor() as i32) as f64 + 1.0;
            self.set_world(island, [SPAWN.0, ground, SPAWN.1], SPAWN_YAW);
        }
        self.input.build_buttons = true;
        let visible = self.step_player(dt);
        self.step_pet(dt);
        let edits = self.build_frame(dt, &[]);
        self.update_ghost(&[]);
        self.apply_island_edits(&edits);
        // the web's autosave: at most every 5 s, only when something changed
        if self.island_dirty && self.started.elapsed().as_secs_f64() - self.island_saved_at > 5.0 {
            self.save_island();
        }
        let scale = self.scale();
        let mut meshes: [Vec<CharVertex>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
        self.own_character(dt, visible, &mut meshes);
        let Some(size) = self.renderer.as_ref().and_then(|r| r.surface_size()) else { return };
        let (w, h) = (size.0 as f64 / scale, size.1 as f64 / scale);
        self.input.set_screen(w, h);
        let hud = self.play_hud(w as f32, h as f32);
        self.text.begin_frame();
        let mut p = Painter::new(size, scale).with_art(&self.art_sizes);
        draw_play_hud(&mut p, &mut self.text, &hud);
        // the island has no menu screen up, but its notices (the pet's) still show
        let mut ui = Ui { p: &mut p, t: &mut self.text, ptr: self.pointer, enabled: false, time: 0.0 };
        self.menu.draw_toast(&mut ui);
        let Some(r) = &mut self.renderer else { return };
        r.set_actor(&[]);
        if let Some((w, h, rgba)) = self.face_pending.take() {
            r.set_face_texture(w, h, &rgba);
            self.face_live = true;
        }
        upload_characters(r, &meshes);
        r.set_overlay(&p.vertices, &p.segments, &self.text.take_uploads());
    }
}


impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.display.get_or_insert_with(|| event_loop.owned_display_handle());
        if self.window.is_none() {
            // CRAFTYAP_SIZE=915x412 opens a desktop window the size of a landscape phone (in dp)
            let (ww, wh) = std::env::var("CRAFTYAP_SIZE").ok().and_then(|s| s.split_once('x').and_then(|(a, b)| Some((a.parse::<f64>().ok()?, b.parse::<f64>().ok()?)))).unwrap_or((1100.0, 700.0));
            let attrs = Window::default_attributes().with_title("CraftYap").with_inner_size(winit::dpi::LogicalSize::new(ww, wh));
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

    fn exiting(&mut self, _: &ActiveEventLoop) {
        // the window closed (desktop) or the activity is going: the last changes are kept
        self.menu.profile.save();
        if self.island_dirty {
            self.save_island();
        }
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
        self.input.release_all();
        self.pointer = Pointer::default();
        self.menu_finger = None;
        // the profile is saved on every change already; one more on the way out costs nothing
        self.menu.profile.save();
        if self.island_dirty {
            self.save_island();
        }
    }

    fn device_event(&mut self, _: &ActiveEventLoop, _: DeviceId, event: DeviceEvent) {
        // raw motion: a captured cursor does not move, so looking needs the device's own deltas
        if let DeviceEvent::MouseMotion { delta } = event {
            self.input.mouse_motion(delta.0, delta.1, Instant::now());
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                if let Some(r) = &mut self.renderer {
                    r.resize(size.width, size.height);
                }
            }
            WindowEvent::Focused(false) => {
                self.input.release_all();
                self.capture(false);
            }
            WindowEvent::CursorMoved { position, .. } => {
                let k = self.scale();
                self.pointer_move((position.x / k) as f32, (position.y / k) as f32);
            }
            WindowEvent::MouseWheel { delta, .. } if self.bag.open && !self.menu_owns_input() => {
                self.bag.scroll = (self.bag.scroll
                    - match delta {
                        winit::event::MouseScrollDelta::LineDelta(_, y) => y * 50.0,
                        winit::event::MouseScrollDelta::PixelDelta(p) => p.y as f32,
                    })
                .max(0.0);
            }
            // the wheel zooms the camera, Roblox's way (in to first person, out to 14 m); the hotbar
            // keeps its number keys
            WindowEvent::MouseWheel { delta, .. } if !self.menu_owns_input() && self.input.captured() => {
                let steps = match delta {
                    winit::event::MouseScrollDelta::LineDelta(_, y) => -y as f64,
                    winit::event::MouseScrollDelta::PixelDelta(p) => -p.y / 40.0,
                };
                self.follow.zoom_by(steps * 1.2);
            }
            WindowEvent::MouseWheel { delta, .. } if self.menu_owns_input() => {
                self.pointer.dy += match delta {
                    winit::event::MouseScrollDelta::LineDelta(_, y) => y * 40.0,
                    winit::event::MouseScrollDelta::PixelDelta(p) => (p.y / self.scale()) as f32,
                };
            }
            WindowEvent::Ime(event) => {
                if let Some(edit) = self.menu.focused_edit().filter(|_| self.in_menu) {
                    match event {
                        winit::event::Ime::Preedit(s, _) => edit.preedit = s,
                        winit::event::Ime::Commit(s) => edit.commit(&s),
                        _ => {}
                    }
                }
            }
            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } if self.menu_owns_input() || (self.menu.in_field() && !self.input.captured() && (self.menu.hud_hit(self.pointer.pos.0, self.pointer.pos.1) || state == ElementState::Released && self.pointer.down)) => {
                let (x, y) = self.pointer.pos;
                if state == ElementState::Pressed {
                    self.pointer_down(x, y);
                } else {
                    self.pointer_up(x, y);
                }
            }
            // in play with the mouse captured: left digs (held), right places
            WindowEvent::MouseInput { state, button, .. } if self.input.captured() => match button {
                MouseButton::Left => self.mouse_dig = state == ElementState::Pressed,
                MouseButton::Right if state == ElementState::Pressed => self.place_clicks += 1,
                _ => {}
            },
            WindowEvent::MouseInput { state: ElementState::Pressed, button: MouseButton::Left, .. } => {
                let (x, y) = self.pointer.pos;
                if self.bag.open && !self.menu_owns_input() {
                    self.bag_tap(x, y);
                    return;
                }
                if !self.menu_owns_input() && self.pet_tap(x, y) {
                    return;
                }
                if !self.input.touch_mode {
                    self.capture(true);
                }
            }
            // Android's Back key (winit: BrowserBack) and Escape: back a screen / out of the game
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed && matches!(event.physical_key, PhysicalKey::Code(KeyCode::BrowserBack)) => self.back(),
            WindowEvent::KeyboardInput { event, .. } if self.menu_owns_input() || self.menu.in_field() && self.menu.focus.is_some() => {
                if event.state == ElementState::Pressed {
                    let focused = self.menu.focus.is_some();
                    match event.physical_key {
                        PhysicalKey::Code(KeyCode::Escape) => self.back(),
                        PhysicalKey::Code(KeyCode::Enter | KeyCode::NumpadEnter) if focused => self.menu.submit(),
                        // Android: the IME state is the only source of text (ime::sync), or a key typed
                        // on the soft keyboard would arrive twice
                        _ if cfg!(target_os = "android") => {}
                        PhysicalKey::Code(KeyCode::Backspace) => {
                            if let Some(edit) = self.menu.focused_edit() {
                                edit.backspace();
                            }
                        }
                        // plain typing (an IME's own keys arrive as Ime events, with no text here)
                        _ => {
                            if let (Some(edit), Some(text)) = (self.menu.focused_edit(), &event.text) {
                                edit.commit(text);
                            }
                        }
                    }
                }
            }
            WindowEvent::KeyboardInput { event, .. } => {
                if let PhysicalKey::Code(code) = event.physical_key {
                    let pressed = event.state == ElementState::Pressed;
                    // 1–9, 0: the hotbar's slots (the web's keys)
                    let digits = [KeyCode::Digit1, KeyCode::Digit2, KeyCode::Digit3, KeyCode::Digit4, KeyCode::Digit5, KeyCode::Digit6, KeyCode::Digit7, KeyCode::Digit8, KeyCode::Digit9, KeyCode::Digit0];
                    if let (true, Some(slot)) = (pressed, digits.iter().position(|d| *d == code)) {
                        self.hotbar.select(slot);
                    }
                    if pressed && !self.menu_owns_input() && !self.bag.open {
                        match code {
                            KeyCode::KeyF => self.next_piece(),
                            KeyCode::KeyR if self.input.shift_held() => {
                                self.piece_rot = 0;
                                self.piece_tilt = 0;
                                self.menu.toast("기본 방향으로 맞췄어요");
                            }
                            KeyCode::KeyR => self.turn_piece(false),
                            KeyCode::KeyT => self.turn_piece(true),
                            _ => {}
                        }
                    }
                    if pressed && code == KeyCode::KeyC && !self.menu_owns_input() && !self.bag.open && !self.menu.chatting() {
                        self.emote_open = !self.emote_open;
                        self.pet_open = false;
                        if !self.input.touch_mode {
                            self.capture(!self.emote_open);
                        }
                    }
                    if pressed && code == KeyCode::KeyV && !self.menu_owns_input() {
                        self.follow.toggle_view();
                    }
                    if pressed && code == KeyCode::KeyI && !self.menu_owns_input() {
                        self.toggle_bag();
                    }
                    if pressed && code == KeyCode::Escape && self.bag.open {
                        self.toggle_bag();
                        return;
                    }
                    if pressed && code == KeyCode::KeyP {
                        self.toggle_pet();
                    }
                    if pressed && code == KeyCode::KeyY {
                        if let Some(d) = crate::pet::data() {
                            let at = d.order.iter().position(|k| *k == self.menu.profile.pet).unwrap_or(0);
                            let next = d.order[(at + 1) % d.order.len()].clone();
                            self.adopt_pet(&next);
                        }
                    }
                    if code == KeyCode::Escape && pressed {
                        if self.input.captured() {
                            self.capture(false);
                        } else {
                            self.back();
                        }
                    }
                    self.input.key(code, pressed);
                }
            }
            WindowEvent::Touch(Touch { id, phase, location, .. }) => {
                let k = self.scale();
                let (x, y) = (location.x / k, location.y / k);
                let hud = self.menu.in_field() && (self.menu_finger == Some(id) || phase == TouchPhase::Started && self.menu_finger.is_none() && self.menu.hud_hit(x as f32, y as f32));
                // a tap on a hotbar slot picks it
                if self.bag.open && !self.menu_owns_input() && !hud {
                    let (fx, fy) = (x as f32, y as f32);
                    match phase {
                        TouchPhase::Started if self.bag_finger.is_none() => self.bag_finger = Some((id, fy, false)),
                        TouchPhase::Moved => {
                            if let Some((fid, last, moved)) = self.bag_finger {
                                if fid == id {
                                    self.bag.scroll = (self.bag.scroll - (fy - last)).max(0.0);
                                    self.bag_finger = Some((id, fy, moved || (fy - last).abs() > 2.0));
                                }
                            }
                        }
                        TouchPhase::Ended | TouchPhase::Cancelled => {
                            if let Some((fid, _, moved)) = self.bag_finger {
                                if fid == id {
                                    self.bag_finger = None;
                                    if !moved && phase == TouchPhase::Ended {
                                        self.bag_tap(fx, fy);
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                    return;
                }
                if !self.menu_owns_input() && phase == TouchPhase::Started && !hud && self.pet_tap(x as f32, y as f32) {
                    return;
                }
                if !self.menu_owns_input() && phase == TouchPhase::Started && !hud {
                    let (w, h) = self.hud_size;
                    if let Some(slot) = Painter::hotbar_rects(w, h, true).iter().position(|r| r.contains(x as f32, y as f32)) {
                        self.hotbar.select(slot);
                        return;
                    }
                }
                if self.menu_owns_input() || hud {
                    // the first finger is the menu pointer; others are ignored
                    let (fx, fy) = (x as f32, y as f32);
                    match phase {
                        TouchPhase::Started if self.menu_finger.is_none() => {
                            self.menu_finger = Some(id);
                            self.pointer_down(fx, fy);
                        }
                        TouchPhase::Moved if self.menu_finger == Some(id) => self.pointer_move(fx, fy),
                        TouchPhase::Ended | TouchPhase::Cancelled if self.menu_finger == Some(id) => {
                            self.menu_finger = None;
                            self.pointer_up(fx, fy);
                        }
                        _ => {}
                    }
                    return;
                }
                match phase {
                    TouchPhase::Started => self.input.touch_start(id, x, y),
                    TouchPhase::Moved => self.input.touch_move(id, x, y),
                    TouchPhase::Ended | TouchPhase::Cancelled => self.input.touch_end(id),
                }
            }
            WindowEvent::RedrawRequested => {
                let now = Instant::now();
                let dt = self.last_frame.map_or(0.0, |t| (now - t).as_secs_f32());
                self.last_frame = Some(now);
                self.take_art();
                self.sound.volume = self.menu.profile.settings.sfx as f32;
                self.sound.frame();
                if self.menu.in_field() {
                    self.in_menu = true; // leaving the field returns to the menu
                    self.field_frame(dt as f64);
                } else if self.in_menu {
                    self.menu_frame();
                } else {
                    self.play(dt as f64);
                }
                self.update_chunks();
                // the water's clock, and the field window's origin so ripples stay put when it scrolls
                let (ox, oz) = self.field.as_ref().map_or((0, 0), |f| (f.origin_x, f.origin_z));
                let water_time = self.started.elapsed().as_secs_f32();
                let Some(r) = &mut self.renderer else { return };
                r.water_clock = [water_time, (ox % 1024) as f32, (oz % 1024) as f32];
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
                // a preset picked in the settings: applied at once, and auto never steps it down
                let chosen = Preset::named(&self.menu.profile.settings.graphics);
                if let Some(p) = chosen.filter(|p| Some(*p) != self.preset) {
                    log::info!("quality: {p:?} (chosen)");
                    self.preset = Some(p);
                    r.set_settings(p.settings());
                }
                if let (Some(preset), true, None) = (self.preset, dt > 0.0, chosen) {
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
