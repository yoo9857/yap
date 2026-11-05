//! The player characters: the web's own HOME and TT models (`apps/client/public/models/characters`,
//! the SAME GLB files, compiled in), animated like `player/homeRig.ts`.
//!
//! - One skinned mesh per model (HOME 17 bones, TT 21) and its painted-face texture.
//! - Clips are sampled on the CPU and cross-faded (three's AnimationMixer weights): Idle with the
//!   IdleShift / IdleLook variations, Walk and Run blended by speed with a shared gait phase
//!   (motionPolicy.ts gaitBlend / gaitCadence, so feet never slide), Jump / Fall / Land, Sit, Lie,
//!   Crawl. Fade times are the web's (.25 idle, .14 moves, .06 landing).
//! - Skinning is on the CPU too: ~2.4k triangles per character, cheaper than a skinning pipeline
//!   and identical on every GPU the app runs on (GLES 3 included).
//!
//! Everything here is plain data + math (no GPU), so it is unit-tested against the shipped files.

use glam::{Mat4, Quat, Vec3};
use std::collections::HashMap;
use std::sync::OnceLock;

const HOME_GLB: &[u8] = include_bytes!("../../../../apps/client/public/models/characters/HOME/HOME.glb");
const TT_GLB: &[u8] = include_bytes!("../../../../apps/client/public/models/characters/TT/TT.glb");

/// motionPolicy.ts WALK_GAIT / RUN_GAIT (m/s).
const WALK_GAIT: f32 = 2.9;
const RUN_GAIT: f32 = 3.5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Home,
    Tt,
}

impl Kind {
    /// The wire's `character` ("mascot" / "tt"; absent = the plain mascot = HOME).
    pub fn from_wire(s: Option<&str>) -> Kind {
        if s == Some("tt") { Kind::Tt } else { Kind::Home }
    }
}

/// One drawn vertex of a character, in world space (CPU-skinned).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, bytemuck::Pod, bytemuck::Zeroable)]
pub struct CharVertex {
    pub pos: [f32; 3],
    pub nrm: [f32; 3],
    pub uv: [f32; 2],
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Trs {
    pub(crate) t: Vec3,
    pub(crate) r: Quat,
    pub(crate) s: Vec3,
}

impl Trs {
    fn matrix(&self) -> Mat4 {
        Mat4::from_scale_rotation_translation(self.s, self.r, self.t)
    }
}

#[derive(Clone, Debug)]
enum Values {
    T(Vec<Vec3>),
    R(Vec<Quat>),
    S(Vec<Vec3>),
}

#[derive(Clone, Debug)]
struct Channel {
    node: usize,
    times: Vec<f32>,
    values: Values,
    step: bool,
}

#[derive(Clone, Debug)]
pub struct Clip {
    pub duration: f32,
    channels: Vec<Channel>,
}

pub struct Model {
    pub(crate) rest: Vec<Trs>,
    pub(crate) parent: Vec<Option<usize>>,
    /// Node names (handGrip finds the right hand, the held item's torso by name).
    pub(crate) names: Vec<String>,
    /// Nodes ordered parents first.
    order: Vec<usize>,
    pub(crate) joints: Vec<usize>,
    pub(crate) inverse_bind: Vec<Mat4>,
    pub(crate) positions: Vec<Vec3>,
    normals: Vec<Vec3>,
    uvs: Vec<[f32; 2]>,
    pub(crate) weights: Vec<[(u16, f32); 4]>,
    pub indices: Vec<u32>,
    /// Standing height in its rest pose (m): where name tags go.
    pub height: f32,
    pub clips: HashMap<String, Clip>,
    /// The painted face (RGBA8, sRGB).
    pub texture: (u32, u32, Vec<u8>),
    /// homeRig.ts upperClips: the nodes the upper-body layer drives (torso, upper_arm, forearm,
    /// hand), and each node's reference pose for the additive layer (Idle at 0; CrawlIdle at 0 for
    /// CrawlReach — makeClipAdditive's reference frame).
    upper: Vec<bool>,
    reference: HashMap<&'static str, Vec<RefPose>>,
}

/// A held item for `Model::skin_held`: its pose state, grip, data, this frame's inputs and where
/// its triangles go.
pub struct Hold<'a> {
    pub pose: &'a mut crate::held::HeldPose,
    pub grip: &'a crate::held::GripSocket,
    pub item: &'a crate::held::Item,
    pub frame: crate::held::Frame,
    pub out: &'a mut Vec<CharVertex>,
}

/// A node's additive reference: its translation and rotation in the reference clip at 0, if keyed.
type RefPose = (Option<Vec3>, Option<Quat>);

/// The upper-body clips (homeRig.ts upperClips) and the clip each is made additive against.
pub const UPPER_CLIPS: [(&str, &str); 6] = [("Wave", "Idle"), ("Cheer", "Idle"), ("Interact", "Idle"), ("Place", "Idle"), ("Hit", "Idle"), ("CrawlReach", "CrawlIdle")];

fn load(kind: Kind) -> Result<Model, String> {
    let bytes = match kind {
        Kind::Home => HOME_GLB,
        Kind::Tt => TT_GLB,
    };
    let g = gltf::Gltf::from_slice(bytes).map_err(|e| e.to_string())?;
    let blob = g.blob.as_deref().ok_or("no binary chunk")?;
    let doc = &g.document;
    let nodes: Vec<_> = doc.nodes().collect();
    let mut parent = vec![None; nodes.len()];
    for n in &nodes {
        for c in n.children() {
            parent[c.index()] = Some(n.index());
        }
    }
    let rest: Vec<Trs> = nodes
        .iter()
        .map(|n| {
            let (t, r, s) = n.transform().decomposed();
            Trs { t: Vec3::from(t), r: Quat::from_array(r), s: Vec3::from(s) }
        })
        .collect();
    // parents first: a node's place in the order is its depth, then its index
    let depth = |mut i: usize| {
        let mut d = 0;
        while let Some(p) = parent[i] {
            d += 1;
            i = p;
        }
        d
    };
    let mut order: Vec<usize> = (0..nodes.len()).collect();
    order.sort_by_key(|&i| (depth(i), i));
    let skin = doc.skins().next().ok_or("no skin")?;
    let joints: Vec<usize> = skin.joints().map(|j| j.index()).collect();
    let reader = skin.reader(|_| Some(blob));
    let inverse_bind: Vec<Mat4> = reader.read_inverse_bind_matrices().ok_or("no inverse bind matrices")?.map(|m| Mat4::from_cols_array_2d(&m)).collect();
    let mesh = doc.meshes().next().ok_or("no mesh")?;
    let prim = mesh.primitives().next().ok_or("no primitive")?;
    let r = prim.reader(|_| Some(blob));
    let positions: Vec<Vec3> = r.read_positions().ok_or("no positions")?.map(Vec3::from).collect();
    let normals: Vec<Vec3> = r.read_normals().ok_or("no normals")?.map(Vec3::from).collect();
    let uvs: Vec<[f32; 2]> = r.read_tex_coords(0).ok_or("no uvs")?.into_f32().collect();
    let js: Vec<[u16; 4]> = r.read_joints(0).ok_or("no joints")?.into_u16().collect();
    let ws: Vec<[f32; 4]> = r.read_weights(0).ok_or("no weights")?.into_f32().collect();
    let weights = js.iter().zip(&ws).map(|(j, w)| {
        let sum = (w[0] + w[1] + w[2] + w[3]).max(1e-6);
        [(j[0], w[0] / sum), (j[1], w[1] / sum), (j[2], w[2] / sum), (j[3], w[3] / sum)]
    }).collect();
    let indices: Vec<u32> = match r.read_indices() {
        Some(i) => i.into_u32().collect(),
        None => (0..positions.len() as u32).collect(),
    };
    let mut clips = HashMap::new();
    for a in doc.animations() {
        let name = a.name().unwrap_or("").trim_start_matches("HOME_").trim_start_matches("TT_").to_owned();
        let mut channels = Vec::new();
        let mut duration = 0.0f32;
        for ch in a.channels() {
            let cr = ch.reader(|_| Some(blob));
            let times: Vec<f32> = match cr.read_inputs() {
                Some(t) => t.collect(),
                None => continue,
            };
            duration = duration.max(times.last().copied().unwrap_or(0.0));
            let values = match cr.read_outputs() {
                Some(gltf::animation::util::ReadOutputs::Translations(v)) => Values::T(v.map(Vec3::from).collect()),
                Some(gltf::animation::util::ReadOutputs::Rotations(v)) => Values::R(v.into_f32().map(Quat::from_array).collect()),
                Some(gltf::animation::util::ReadOutputs::Scales(v)) => Values::S(v.map(Vec3::from).collect()),
                _ => continue,
            };
            let step = ch.sampler().interpolation() == gltf::animation::Interpolation::Step;
            channels.push(Channel { node: ch.target().node().index(), times, values, step });
        }
        clips.insert(name, Clip { duration, channels });
    }
    // the face picture, embedded as a PNG
    let image = doc.images().next().ok_or("no image")?;
    let view = match image.source() {
        gltf::image::Source::View { view, .. } => view,
        _ => return Err("the face picture is not embedded".into()),
    };
    let png_bytes = &blob[view.offset()..view.offset() + view.length()];
    let texture = decode_png(png_bytes)?;
    let upper: Vec<bool> = nodes
        .iter()
        .map(|n| ["torso", "upper_arm", "forearm", "hand"].iter().any(|p| n.name().unwrap_or("").starts_with(p)))
        .collect();
    let mut reference = HashMap::new();
    for (_, of) in UPPER_CLIPS {
        if reference.contains_key(of) {
            continue;
        }
        let mut pose = vec![(None, None); nodes.len()];
        if let Some(c) = clips.get(of) {
            for ch in &c.channels {
                let (node, t, r, _) = sample(ch, 0.0);
                if t.is_some() {
                    pose[node].0 = t;
                }
                if r.is_some() {
                    pose[node].1 = r;
                }
            }
        }
        reference.insert(of, pose);
    }
    let names: Vec<String> = nodes.iter().map(|n| n.name().unwrap_or("").to_owned()).collect();
    let mut model = Model { rest, parent, names, order, joints, inverse_bind, positions, normals, uvs, weights, indices, clips, texture, height: 0.0, upper, reference };
    let mut out = Vec::new();
    model.skin(&[("Idle", 0.0, 1.0)], Vec3::ZERO, 0.0, &mut out);
    model.height = out.iter().map(|v| v.pos[1]).fold(0.0, f32::max);
    Ok(model)
}

pub(crate) fn decode_png(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let mut d = png::Decoder::new(std::io::Cursor::new(bytes));
    d.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut r = d.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; r.output_buffer_size()];
    let info = r.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let px = &buf[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => px.to_vec(),
        png::ColorType::Rgb => px.chunks(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => px.chunks(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Grayscale => px.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err("indexed png after EXPAND".into()),
    };
    Ok((info.width, info.height, rgba))
}

/// The two models, read once (on first use; the app warms them on a thread at start).
pub fn model(kind: Kind) -> Option<&'static Model> {
    static HOME: OnceLock<Option<Model>> = OnceLock::new();
    static TT: OnceLock<Option<Model>> = OnceLock::new();
    let cell = match kind {
        Kind::Home => &HOME,
        Kind::Tt => &TT,
    };
    cell.get_or_init(|| match load(kind) {
        Ok(m) => Some(m),
        Err(e) => {
            log::error!("character {kind:?}: {e} (the code mascot stands in)");
            None
        }
    })
    .as_ref()
}

fn sample(ch: &Channel, t: f32) -> (usize, Option<Vec3>, Option<Quat>, Option<Vec3>) {
    let n = ch.times.len();
    let (i, k) = if n == 0 || t <= ch.times[0] {
        (0, 0.0)
    } else if t >= ch.times[n - 1] {
        (n - 1, 0.0)
    } else {
        let i = ch.times.partition_point(|&x| x <= t) - 1;
        let k = if ch.step { 0.0 } else { (t - ch.times[i]) / (ch.times[i + 1] - ch.times[i]).max(1e-6) };
        (i, k)
    };
    let j = (i + 1).min(n.saturating_sub(1));
    match &ch.values {
        Values::T(v) => (ch.node, Some(v[i].lerp(v[j], k)), None, None),
        Values::R(v) => (ch.node, None, Some(v[i].slerp(v[j], k)), None),
        Values::S(v) => (ch.node, None, None, Some(v[i].lerp(v[j], k))),
    }
}

impl Model {
    /// The skinned mesh for a pose: `entries` = (clip, time, weight), placed at `at` facing `yaw`.
    pub fn skin(&self, entries: &[(&str, f32, f32)], at: Vec3, yaw: f32, out: &mut Vec<CharVertex>) {
        self.skin_layered(entries, &[], at, yaw, out);
    }

    /// `skin` plus homeRig.ts's additive upper-body layer: `upper` = (clip, time, weight) of
    /// UPPER_CLIPS, applied on the torso and arms only as three's additive blend does
    /// (rotation: base · slerp(I, ref⁻¹ · q, w); translation: base + w · (p − ref)).
    pub fn skin_layered(&self, entries: &[(&str, f32, f32)], upper: &[(&str, f32, f32)], at: Vec3, yaw: f32, out: &mut Vec<CharVertex>) {
        self.skin_held(entries, upper, None, at, yaw, out);
    }

    /// `skin_layered` with a held item: its pose (heldItem.ts updatePose) runs on the frame's local
    /// pose before the world matrices, and the item's triangles go into the hold's `out`.
    pub fn skin_held(&self, entries: &[(&str, f32, f32)], upper: &[(&str, f32, f32)], held: Option<Hold<'_>>, at: Vec3, yaw: f32, out: &mut Vec<CharVertex>) {
        let n = self.rest.len();
        // blend: weighted sums per node, the rest pose filling whatever weight is missing
        let mut acc_t = vec![Vec3::ZERO; n];
        let mut acc_s = vec![Vec3::ZERO; n];
        let mut acc_r = vec![[0.0f32; 4]; n];
        let mut wt = vec![0.0f32; n];
        let mut wr = vec![0.0f32; n];
        let mut ws = vec![0.0f32; n];
        for &(name, time, w) in entries {
            let Some(clip) = self.clips.get(name) else { continue };
            if w <= 0.0 {
                continue;
            }
            for ch in &clip.channels {
                let (node, t, r, s) = sample(ch, time);
                if let Some(t) = t {
                    acc_t[node] += t * w;
                    wt[node] += w;
                }
                if let Some(s) = s {
                    acc_s[node] += s * w;
                    ws[node] += w;
                }
                if let Some(mut q) = r {
                    // the same hemisphere as what is accumulated, or the blend takes the long way
                    let a = acc_r[node];
                    if a[0] * q.x + a[1] * q.y + a[2] * q.z + a[3] * q.w < 0.0 {
                        q = -q;
                    }
                    acc_r[node] = [a[0] + q.x * w, a[1] + q.y * w, a[2] + q.z * w, a[3] + q.w * w];
                    wr[node] += w;
                }
            }
        }
        let mut local = self.rest.clone();
        for i in 0..n {
            let rest = self.rest[i];
            if wt[i] > 0.0 {
                local[i].t = acc_t[i] + rest.t * (1.0 - wt[i]).max(0.0);
                if wt[i] > 1.0 {
                    local[i].t = acc_t[i] / wt[i];
                }
            }
            if ws[i] > 0.0 {
                local[i].s = if ws[i] >= 1.0 { acc_s[i] / ws[i] } else { acc_s[i] + rest.s * (1.0 - ws[i]) };
            }
            if wr[i] > 0.0 {
                let mut a = acc_r[i];
                if wr[i] < 1.0 {
                    let mut q = rest.r;
                    if a[0] * q.x + a[1] * q.y + a[2] * q.z + a[3] * q.w < 0.0 {
                        q = -q;
                    }
                    let k = 1.0 - wr[i];
                    a = [a[0] + q.x * k, a[1] + q.y * k, a[2] + q.z * k, a[3] + q.w * k];
                }
                let q = Quat::from_array(a);
                local[i].r = if q.length_squared() > 1e-12 { q.normalize() } else { rest.r };
            }
        }
        for &(name, time, w) in upper {
            let (Some(clip), Some(of)) = (self.clips.get(name), UPPER_CLIPS.iter().find(|c| c.0 == name).map(|c| c.1)) else { continue };
            let Some(reference) = self.reference.get(of) else { continue };
            if w <= 1e-4 {
                continue;
            }
            for ch in &clip.channels {
                let (node, t, r, _) = sample(ch, time);
                if !self.upper[node] {
                    continue;
                }
                let (rt, rr) = reference[node];
                if let (Some(t), Some(rt)) = (t, rt) {
                    local[node].t += (t - rt) * w;
                }
                if let (Some(q), Some(rq)) = (r, rr) {
                    let delta = (rq.inverse() * q).normalize();
                    local[node].r = (local[node].r * Quat::IDENTITY.slerp(delta, w)).normalize();
                }
            }
        }
        let mut held = held;
        if let Some(h) = held.as_mut() {
            h.pose.apply(self, &mut local, h.grip, h.item, h.frame);
        }
        let mut global = vec![Mat4::IDENTITY; n];
        for &i in &self.order {
            let m = local[i].matrix();
            global[i] = match self.parent[i] {
                Some(p) => global[p] * m,
                None => m,
            };
        }
        let place = Mat4::from_translation(at) * Mat4::from_rotation_y(yaw);
        if let Some(h) = held {
            if h.pose.visible {
                crate::held::mesh(h.item, h.grip, place, global[h.grip.bone], h.out);
            }
        }
        let joint: Vec<Mat4> = self.joints.iter().zip(&self.inverse_bind).map(|(&j, ib)| place * global[j] * *ib).collect();
        out.reserve(self.indices.len());
        // skin each vertex once, then emit the triangles (the pipeline draws a plain list)
        let skinned: Vec<(Vec3, Vec3)> = (0..self.positions.len())
            .map(|v| {
                let mut m = Mat4::ZERO;
                for &(j, w) in &self.weights[v] {
                    if w > 0.0 {
                        if let Some(jm) = joint.get(j as usize) {
                            m += *jm * w;
                        }
                    }
                }
                (m.transform_point3(self.positions[v]), m.transform_vector3(self.normals[v]).normalize_or_zero())
            })
            .collect();
        for &i in &self.indices {
            let (p, nrm) = skinned[i as usize];
            out.push(CharVertex { pos: p.to_array(), nrm: nrm.to_array(), uv: self.uvs[i as usize] });
        }
    }
}

/// gaitBlend: 0 walk … 1 run, smoothstepped between the two gait speeds.
pub fn gait_blend(speed: f32) -> f32 {
    let t = ((speed - WALK_GAIT) / (RUN_GAIT - WALK_GAIT)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// gaitCadence: gait cycles per second, so the feet keep pace with the ground.
pub fn gait_cadence(speed: f32, blend: f32) -> f32 {
    speed.max(0.0) / ((0.42 / 0.64) * (1.0 - blend) + (0.50 / 0.42) * blend)
}

/// What a character is doing, as the animator needs it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Motion {
    pub speed: f32,
    pub grounded: bool,
    pub vy: f32,
    /// The wire's posture: sit / lie / crawl (else standing).
    pub posture: Posture,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Posture {
    #[default]
    Stand,
    Sit,
    Lie,
    Crawl,
}

/// One character's animation state (homeRig.ts's motion selection and fades, reduced).
pub struct Animator {
    /// clip → (weight, time, target weight, fade seconds)
    active: Vec<(&'static str, f32, f32, f32, f32)>,
    phase: f32,
    idle: &'static str,
    idle_left: f32,
    land: f32,
    was_air: bool,
    seed: u32,
    /// A foot planted (Walk/Run gait phase crossed 0 or 0.5), or the body landed, since last asked.
    step: bool,
    /// The upper-body layer (homeRig.ts work overlay): the wanted clip and whether it loops, its
    /// age, and every layer clip still fading: (clip, weight, time).
    work: Option<(&'static str, bool)>,
    work_age: f32,
    upper: Vec<(&'static str, f32, f32)>,
    /// The hand met the block (Interact at half its loop) since last asked: a dig tap.
    tap: bool,
    /// The last action heard from the wire (a classmate's): action, seq, loop.
    wire_action: Option<(String, u32, bool)>,
    wire_emote: Option<(String, u32)>,
}

const LOOPS: &[&str] = &["Idle", "IdleShift", "IdleLook", "Walk", "Run", "Jump", "Fall", "Sit", "Lie", "CrawlIdle", "Crawl"];

impl Animator {
    pub fn new(seed: u32) -> Self {
        Animator { active: Vec::new(), phase: 0.0, idle: "Idle", idle_left: 5.0 + (seed % 4) as f32, land: 0.0, was_air: false, seed, step: false, work: None, work_age: 0.0, upper: Vec::new(), tap: false, wire_action: None, wire_emote: None }
    }

    fn rand(&mut self) -> f32 {
        self.seed = self.seed.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.seed >> 8) as f32 / (1 << 24) as f32
    }

    /// What the hands are doing (homeRig.ts beginWork): Some(("Interact", true)) while digging,
    /// Some(("Place", false)) for a placed block (a new one restarts it), None: nothing.
    pub fn set_work(&mut self, work: Option<(&'static str, bool)>) {
        if work != self.work {
            self.work = work;
            self.work_age = 0.0;
        }
    }

    /// A classmate's hands from the wire (homeRig.ts performAction): a new action, sequence or
    /// loop flag starts it over; interact / place / hit are the Interact / Place / Hit clips.
    pub fn perform(&mut self, action: &str, seq: u32, looped: bool) {
        if self.wire_action.as_ref().is_some_and(|w| w.0 == action && w.1 == seq && w.2 == looped) {
            return;
        }
        self.wire_action = Some((action.to_owned(), seq, looped));
        let clip = match action {
            "interact" => Some("Interact"),
            "place" => Some("Place"),
            "hit" => Some("Hit"),
            _ => None,
        };
        self.work = clip.map(|c| (c, looped));
        self.work_age = 0.0;
    }

    /// A classmate's emote from the wire (emote, emoteSeq): a new sequence plays its gesture clip
    /// (wave / cheer) once on the upper body.
    pub fn emote(&mut self, id: &str, seq: u32) {
        if self.wire_emote.as_ref().is_some_and(|w| w.0 == id && w.1 == seq) {
            return;
        }
        let first = self.wire_emote.is_none();
        self.wire_emote = Some((id.to_owned(), seq));
        let clip = match id {
            "wave" => Some("Wave"),
            "cheer" => Some("Cheer"),
            _ => None,
        };
        // the first snapshot only learns the state (an old wave is not replayed on joining)
        if let (Some(c), false) = (clip, first) {
            self.restart_work(c);
        }
    }

    /// Play a one-shot layer clip again from its start (each placed block).
    pub fn restart_work(&mut self, clip: &'static str) {
        self.work = Some((clip, false));
        self.work_age = 0.0;
    }

    /// The wanted hands' clip (None: nothing).
    pub fn work(&self) -> Option<(&'static str, bool)> {
        self.work
    }

    /// A dig tap to play (the Interact hand meeting the block; taken once).
    pub fn take_tap(&mut self) -> bool {
        std::mem::take(&mut self.tap)
    }

    /// The upper-body layer this frame: (clip, time, weight), for `Model::skin_layered`.
    pub fn upper(&self) -> Vec<(&'static str, f32, f32)> {
        self.upper.iter().map(|&(c, w, t)| (c, t, w)).collect()
    }

    /// Advance the upper-body layer (call after `update`): the wanted clip eases in at the web's
    /// rate (damp 24), others ease out; a one-shot clip ends when it has played through. Only
    /// standing on the ground, as homeRig.ts gates it.
    pub fn update_upper(&mut self, model: &Model, m: Motion, dt: f32) {
        let dt = if dt.is_finite() { dt.clamp(0.0, 0.25) } else { 0.0 };
        let standing = m.posture == Posture::Stand && m.grounded;
        let before = self.work_age;
        self.work_age += dt;
        let target = match self.work {
            Some((clip, looped)) if standing => {
                let d = model.clips.get(clip).map_or(0.0, |c| c.duration);
                if d > 0.0 && (looped || self.work_age < d) {
                    if clip == "Interact" && d > 0.0 {
                        // the hand meets the block at half of each loop (measured from the hand bone)
                        let (a, b) = ((before / d - 0.5).floor(), (self.work_age / d - 0.5).floor());
                        if b > a {
                            self.tap = true;
                        }
                    }
                    Some((clip, if looped { self.work_age % d } else { self.work_age.min(d) }))
                } else {
                    None
                }
            }
            _ => None,
        };
        if let Some((clip, _)) = target {
            if !self.upper.iter().any(|u| u.0 == clip) {
                self.upper.push((clip, 0.0, 0.0));
            }
        }
        let k = 1.0 - (-24.0 * dt).exp();
        for u in &mut self.upper {
            match target {
                Some((clip, t)) if clip == u.0 => {
                    u.1 += (1.0 - u.1) * k;
                    u.2 = t;
                }
                _ => u.1 += (0.0 - u.1) * k,
            }
        }
        self.upper.retain(|u| u.1 > 0.002 || target.is_some_and(|t| t.0 == u.0));
        if target.is_none() && self.work.is_some_and(|w| !w.1) {
            self.work = None; // a one-shot that has played through
        }
    }

    /// The Walk/Run gait phase (0..1), for the held item's sway.
    pub fn gait_phase(&self) -> f32 {
        self.phase
    }

    /// A footstep to play (taken once).
    pub fn take_step(&mut self) -> bool {
        std::mem::take(&mut self.step)
    }

    /// Advance by `dt` and return the clips to sample: (name, time, weight).
    pub fn update(&mut self, model: &Model, m: Motion, dt: f32) -> Vec<(&'static str, f32, f32)> {
        let dt = if dt.is_finite() { dt.clamp(0.0, 0.25) } else { 0.0 };
        let air = !m.grounded;
        if self.was_air && !air {
            self.land = 0.18;
            self.step = true; // the touch-down sounds like a step
        }
        self.was_air = air;
        self.land = (self.land - dt).max(0.0);
        let moving = m.speed > 0.1;
        let (targets, fade): (Vec<(&'static str, f32)>, f32) = match m.posture {
            Posture::Sit => (vec![("Sit", 1.0)], 0.14),
            Posture::Lie => (vec![("Lie", 1.0)], 0.14),
            Posture::Crawl => (vec![(if moving { "Crawl" } else { "CrawlIdle" }, 1.0)], 0.14),
            Posture::Stand if air => (vec![(if m.vy < 0.0 { "Fall" } else { "Jump" }, 1.0)], 0.14),
            Posture::Stand if self.land > 0.0 => (vec![("Land", 1.0)], 0.06),
            Posture::Stand if moving => {
                let b = gait_blend(m.speed);
                let before = self.phase;
                self.phase = (self.phase + dt * gait_cadence(m.speed, b)) % 1.0;
                // feet plant at gait phase 0 and 0.5 (measured from the clips' foot bones)
                if self.phase < before || (before < 0.5 && self.phase >= 0.5) {
                    self.step = true;
                }
                (vec![("Walk", 1.0 - b), ("Run", b)], 0.14)
            }
            Posture::Stand => {
                self.idle_left -= dt;
                if self.idle_left <= 0.0 {
                    self.idle = if self.idle == "Idle" { if self.rand() < 0.5 { "IdleShift" } else { "IdleLook" } } else { "Idle" };
                    self.idle_left = if self.idle == "Idle" { 5.0 + self.rand() * 4.0 } else { model.clips.get(self.idle).map_or(3.6, |c| c.duration) };
                }
                (vec![(self.idle, 1.0)], 0.25)
            }
        };
        if !(m.posture == Posture::Stand && !air && self.land <= 0.0 && !moving) {
            self.idle = "Idle";
            self.idle_left = 4.5;
        }
        // targets: present clips get their goal, others fade to 0
        for e in &mut self.active {
            e.2 = targets.iter().find(|t| t.0 == e.0).map_or(0.0, |t| t.1);
            e.3 = fade;
        }
        // the very first pose is shown at once (a classmate appearing must not fade in from nothing)
        let first = self.active.is_empty();
        for (name, w) in &targets {
            if !self.active.iter().any(|e| e.0 == *name) {
                // a new clip starts at its beginning (a fresh jump, a new idle variation)
                self.active.push((name, if first { *w } else { 0.0 }, *w, fade, 0.0));
            }
        }
        for e in &mut self.active {
            let rate = if e.3 > 0.0 { dt / e.3 } else { 1.0 };
            e.1 = if e.1 < e.2 { (e.1 + rate).min(e.2) } else { (e.1 - rate).max(e.2) };
            let duration = model.clips.get(e.0).map_or(1.0, |c| c.duration.max(1e-3));
            e.4 = if e.0 == "Walk" || e.0 == "Run" {
                self.phase * duration
            } else if LOOPS.contains(&e.0) {
                (e.4 + dt) % duration
            } else {
                (e.4 + dt).min(duration)
            };
        }
        self.active.retain(|e| e.1 > 1e-3 || e.2 > 0.0);
        self.active.iter().map(|e| (e.0, e.4, e.1)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_models_read_with_every_clip_the_game_uses() {
        for kind in [Kind::Home, Kind::Tt] {
            let m = model(kind).expect("shipped GLB reads");
            for clip in ["Idle", "IdleShift", "IdleLook", "Walk", "Run", "Jump", "Fall", "Land", "Sit", "Lie", "CrawlIdle", "Crawl"] {
                assert!(m.clips.get(clip).is_some_and(|c| c.duration > 0.0), "{kind:?} lacks {clip}");
            }
            assert!(m.indices.len() >= 3 * 2000 && m.indices.len().is_multiple_of(3));
            assert_eq!(m.joints.len(), m.inverse_bind.len());
            let (w, h, px) = &m.texture;
            assert!(*w >= 64 && *h >= 64 && px.len() == (*w * *h * 4) as usize);
        }
    }

    #[test]
    fn the_dig_layer_moves_only_the_arms_and_taps_once_a_loop() {
        let m = model(Kind::Home).unwrap();
        let mut a = Animator::new(3);
        let stand = Motion { speed: 0.0, grounded: true, vy: 0.0, posture: Posture::Stand };
        a.set_work(Some(("Interact", true)));
        let d = m.clips["Interact"].duration;
        let mut taps = 0;
        let steps = (3.0 * d / (1.0 / 60.0)).round() as usize;
        for _ in 0..steps {
            let _ = a.update(m, stand, 1.0 / 60.0);
            a.update_upper(m, stand, 1.0 / 60.0);
            taps += a.take_tap() as usize;
        }
        assert_eq!(taps, 3, "one tap per loop of the hand");
        let upper = a.upper();
        assert!(upper.iter().any(|u| u.0 == "Interact" && u.2 > 0.95), "{upper:?}");
        // the pose with the layer differs only above the hips: feet stay where Idle puts them
        let (mut plain, mut dig) = (Vec::new(), Vec::new());
        m.skin(&[("Idle", 0.0, 1.0)], Vec3::ZERO, 0.0, &mut plain);
        // mid-stroke (the hand at the block), at full weight
        m.skin_layered(&[("Idle", 0.0, 1.0)], &[("Interact", d * 0.5, 1.0)], Vec3::ZERO, 0.0, &mut dig);
        let low = |v: &[CharVertex]| v.iter().map(|x| x.pos[1]).fold(f32::MAX, f32::min);
        assert!((low(&plain) - low(&dig)).abs() < 1e-3, "feet planted");
        let moved = plain.iter().zip(&dig).filter(|(p, q)| (Vec3::from(p.pos) - Vec3::from(q.pos)).length() > 0.02).count();
        assert!(moved > 50, "the arms move ({moved} vertices)");
        // stopping eases the layer out
        a.set_work(None);
        for _ in 0..30 {
            a.update_upper(m, stand, 1.0 / 60.0);
        }
        assert!(a.upper().is_empty());
    }

    #[test]
    fn a_classmates_action_from_the_wire_plays_like_perform_action() {
        let m = model(Kind::Home).unwrap();
        let stand = Motion { speed: 0.0, grounded: true, vy: 0.0, posture: Posture::Stand };
        let mut a = Animator::new(5);
        let run = |a: &mut Animator, n: usize| {
            for _ in 0..n {
                a.update_upper(m, stand, 1.0 / 60.0);
            }
        };
        a.perform("interact", 1, true);
        run(&mut a, 20);
        assert!(a.upper().iter().any(|u| u.0 == "Interact" && u.2 > 0.9));
        // the same message again (every snapshot repeats it) does not restart the stroke
        let before = a.upper()[0].1;
        a.perform("interact", 1, true);
        run(&mut a, 1);
        assert!(a.upper()[0].1 > before, "kept going");
        // a place (new seq) is the Place one-shot, played through and then gone
        a.perform("place", 2, false);
        run(&mut a, 20);
        assert!(a.upper().iter().any(|u| u.0 == "Place" && u.2 > 0.9));
        run(&mut a, (m.clips["Place"].duration * 60.0) as usize + 40);
        assert!(a.upper().is_empty(), "{:?}", a.upper());
        // none (or anything unknown) is nothing
        a.perform("dance", 3, false);
        run(&mut a, 5);
        assert!(a.upper().is_empty());
    }

    #[test]
    fn rest_pose_stands_on_its_feet_facing_forward() {
        let m = model(Kind::Home).unwrap();
        let mut out = Vec::new();
        m.skin(&[("Idle", 0.0, 1.0)], Vec3::new(10.0, 4.0, -3.0), 0.0, &mut out);
        let lo = out.iter().map(|v| v.pos[1]).fold(f32::MAX, f32::min);
        let hi = out.iter().map(|v| v.pos[1]).fold(f32::MIN, f32::max);
        assert!((lo - 4.0).abs() < 0.08, "feet at the placement height: {lo}");
        assert!(hi - lo > 0.6 && hi - lo < 2.5, "a believable height: {}", hi - lo);
        let cx = out.iter().map(|v| v.pos[0]).sum::<f32>() / out.len() as f32;
        assert!((cx - 10.0).abs() < 0.2);
        assert!(out.iter().all(|v| v.pos.iter().chain(&v.nrm).all(|c| c.is_finite())));
    }

    #[test]
    fn walking_moves_the_legs_and_turning_turns_the_body() {
        let m = model(Kind::Home).unwrap();
        let (mut a, mut b, mut c) = (Vec::new(), Vec::new(), Vec::new());
        m.skin(&[("Walk", 0.0, 1.0)], Vec3::ZERO, 0.0, &mut a);
        let half = m.clips["Walk"].duration / 2.0;
        m.skin(&[("Walk", half, 1.0)], Vec3::ZERO, 0.0, &mut b);
        let moved = a.iter().zip(&b).map(|(p, q)| (Vec3::from(p.pos) - Vec3::from(q.pos)).length()).fold(0.0, f32::max);
        assert!(moved > 0.05, "half a stride apart: {moved}");
        m.skin(&[("Walk", 0.0, 1.0)], Vec3::ZERO, std::f32::consts::PI, &mut c);
        let (az, cz) = (a.iter().map(|v| v.pos[2]).sum::<f32>(), c.iter().map(|v| v.pos[2]).sum::<f32>());
        assert!((az + cz).abs() < 0.05 * a.len() as f32, "a half turn mirrors z");
    }

    #[test]
    fn the_animator_fades_and_picks_like_the_web() {
        let m = model(Kind::Home).unwrap();
        let mut an = Animator::new(1);
        let stand = Motion { speed: 0.0, grounded: true, vy: 0.0, posture: Posture::Stand };
        let e = an.update(m, stand, 0.016);
        assert_eq!(e[0].0, "Idle");
        // start running: Run fades in over .14 s while Idle fades out
        let run = Motion { speed: 5.2, ..stand };
        let mid = an.update(m, run, 0.07);
        let w = |e: &[(&str, f32, f32)], n: &str| e.iter().find(|x| x.0 == n).map_or(0.0, |x| x.2);
        assert!(w(&mid, "Run") > 0.3 && w(&mid, "Run") < 0.7 && w(&mid, "Idle") > 0.3);
        let mut e = mid;
        for _ in 0..20 {
            e = an.update(m, run, 0.016);
        }
        assert!(w(&e, "Run") > 0.99 && w(&e, "Idle") == 0.0);
        // airborne going up, then landing
        let e = an.update(m, Motion { grounded: false, vy: 3.0, ..run }, 0.2);
        assert!(w(&e, "Jump") > 0.9);
        let mut e = an.update(m, stand, 0.016);
        assert!(e.iter().any(|x| x.0 == "Land"));
        for _ in 0..60 {
            e = an.update(m, stand, 0.016);
        }
        assert!(w(&e, "Idle") > 0.99, "{e:?}");
        // running plants a foot twice a gait cycle
        let mut steps = 0;
        for _ in 0..120 {
            an.update(m, run, 1.0 / 60.0);
            steps += an.take_step() as u32;
        }
        let expect = 2.0 * gait_cadence(5.2, 1.0) * 2.0;
        assert!((steps as f32 - expect).abs() <= 1.5, "{steps} steps in 2 s, expected ~{expect}");
        assert!(gait_blend(2.0) == 0.0 && gait_blend(4.0) == 1.0 && gait_cadence(2.7, 0.0) > 0.0);
        // garbage time never breaks it
        let e = an.update(m, stand, f32::NAN);
        assert!(e.iter().all(|x| x.1.is_finite() && x.2.is_finite()));
    }
}
