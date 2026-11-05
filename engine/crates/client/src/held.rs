//! The held pickaxe — the web's own item (assets/items/tools/pickaxe-basic: item.json for every
//! number, the GLB for the model), ported from heldItem.ts, toolDefinitions.ts and itemAttack.ts:
//!
//! - `Item`: item.json and the model (mesh + albedo atlas), read once;
//! - `grip`: handGrip — the hand's controller bone, the socket in the thumb/palm cleft in bind
//!   space, the tool's rotation on that bone;
//! - `Stroke`: the swing's monotone-Hermite curves (harmonic tangents, no overshoot);
//! - `HeldPose::apply`: HeldItemInstance.updatePose on a frame's local pose — the grasped arm lifted
//!   by `liftRotation`, the stroke's pitch/side/roll, walking/idle sway, turn and acceleration
//!   lag, the upper body's lean and twist, the equip ease — then the item placed on the bone;
//! - `Attack`: ItemAttack (a click commits one stroke, holding repeats, release completes it) and
//!   the mining rules (`impacts`, `work`: one blade impact per cycle, worth the swing's seconds ×
//!   the block family's efficiency).
//!
//! The pose runs in the character's model space (before it is placed in the world), so heldItem.ts's
//! "reference" rotation (the character root) is the identity here.

use crate::character::{CharVertex, Model, Trs};
use glam::{EulerRot, Mat4, Quat, Vec3};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

const ITEM_JSON: &str = include_str!("../../../../assets/items/tools/pickaxe-basic/item.json");
const ITEM_GLB: &[u8] = include_bytes!("../../../../apps/client/public/models/items/tools/pickaxe-basic/pickaxe-basic.glb");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Motion {
    pub source_arm_weight: f32,
    pub attack_arm_weight: f32,
    pub air_arm_weight: f32,
    pub walk_sway: [f32; 3],
    pub run_sway: [f32; 3],
    pub idle_sway: [f32; 3],
    pub turn_lag: f32,
    pub max_turn_lag: f32,
    pub acceleration_lag: f32,
    pub max_acceleration_lag: f32,
    pub attack_sway_weight: f32,
    pub response: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grip {
    pub scale: f32,
    pub rotation: [f32; 3],
    pub bind_offset: [f32; 3],
    pub lift_rotation: [f32; 3],
    pub equip_seconds: f32,
    /// The put-away fade (heldItem.ts release): the app hides the tool at once for now.
    #[allow(dead_code)]
    pub unequip_seconds: f32,
    pub handle_slide: f32,
    pub motion: Motion,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Swing {
    pub seconds: f32,
    pub impact_at: f32,
    pub phases: Vec<f32>,
    pub pitch: Vec<f32>,
    pub side: Vec<f32>,
    pub lean: Vec<f32>,
    pub roll: Vec<f32>,
    pub twist: Vec<f32>,
}

#[derive(Deserialize)]
pub struct Def {
    pub id: String,
    pub grip: Grip,
    pub swing: Swing,
    pub efficiency: HashMap<String, f32>,
}

pub struct Item {
    pub def: Def,
    positions: Vec<Vec3>,
    normals: Vec<Vec3>,
    uvs: Vec<[f32; 2]>,
    indices: Vec<u32>,
    /// The albedo atlas (RGBA8, sRGB).
    pub texture: (u32, u32, Vec<u8>),
    pub strokes: [Stroke; 5],
}

/// The pickaxe, read once (None only if the shipped files are broken).
pub fn item() -> Option<&'static Item> {
    static ITEM: OnceLock<Option<Item>> = OnceLock::new();
    ITEM.get_or_init(|| match load() {
        Ok(i) => Some(i),
        Err(e) => {
            log::error!("pickaxe: {e}");
            None
        }
    })
    .as_ref()
}

fn load() -> Result<Item, String> {
    let def: Def = serde_json::from_str(ITEM_JSON).map_err(|e| format!("item.json: {e}"))?;
    let (document, blob) = read_glb(ITEM_GLB)?;
    let blob = blob.as_slice();
    let mesh = document.meshes().next().ok_or("no mesh")?;
    let prim = mesh.primitives().next().ok_or("no primitive")?;
    let r = prim.reader(|_| Some(blob));
    let positions: Vec<Vec3> = r.read_positions().ok_or("no positions")?.map(Vec3::from).collect();
    let normals: Vec<Vec3> = r.read_normals().ok_or("no normals")?.map(Vec3::from).collect();
    let uvs: Vec<[f32; 2]> = r.read_tex_coords(0).ok_or("no uvs")?.into_f32().collect();
    let indices: Vec<u32> = r.read_indices().map(|i| i.into_u32().collect()).unwrap_or_else(|| (0..positions.len() as u32).collect());
    // the albedo: the material's base colour texture (the atlas, embedded)
    let tex = prim.material().pbr_metallic_roughness().base_color_texture().ok_or("no albedo")?.texture();
    let view = match tex.source().source() {
        gltf::image::Source::View { view, .. } => view,
        _ => return Err("the albedo is not embedded".into()),
    };
    let texture = crate::character::decode_png(&blob[view.offset()..view.offset() + view.length()])?;
    let s = &def.swing;
    let strokes = [Stroke::new(&s.phases, &s.pitch), Stroke::new(&s.phases, &s.side), Stroke::new(&s.phases, &s.lean), Stroke::new(&s.phases, &s.roll), Stroke::new(&s.phases, &s.twist)];
    Ok(Item { def, positions, normals, uvs, indices, texture, strokes })
}

/// A GLB's document and binary chunk. The Blender export carries empty scenes with no `nodes`
/// (valid glTF, but the gltf crate's parser requires the field): each gets an empty list first.
fn read_glb(bytes: &[u8]) -> Result<(gltf::Document, Vec<u8>), String> {
    let u32_at = |i: usize| bytes.get(i..i + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize);
    if bytes.get(0..4) != Some(b"glTF") {
        return Err("not a GLB".into());
    }
    let json_len = u32_at(12).ok_or("short GLB")?;
    let json = bytes.get(20..20 + json_len).ok_or("short GLB")?;
    let bin_at = 20 + json_len;
    let bin_len = u32_at(bin_at).ok_or("no binary chunk")?;
    let bin = bytes.get(bin_at + 8..bin_at + 8 + bin_len).ok_or("short binary chunk")?.to_vec();
    let mut root: serde_json::Value = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    if let Some(scenes) = root.get_mut("scenes").and_then(|s| s.as_array_mut()) {
        for scene in scenes {
            if let Some(o) = scene.as_object_mut() {
                o.entry("nodes").or_insert_with(|| serde_json::json!([]));
            }
        }
    }
    let root: gltf::json::Root = serde_json::from_value(root).map_err(|e| e.to_string())?;
    let document = gltf::Document::from_json(root).map_err(|e| format!("{e:?}"))?;
    Ok((document, bin))
}

// ---------------------------------------------------------------------------------------------
// The swing's curves (heldItem.ts strokeCurve)
// ---------------------------------------------------------------------------------------------

pub struct Stroke {
    keys: Vec<f32>,
    values: Vec<f32>,
    tangents: Vec<f32>,
}

impl Stroke {
    /// Shape-preserving cubic Hermite: continuous velocity through intermediate keys, harmonic
    /// tangents (no overshoot), zero slope at reversals and the rest ends.
    pub fn new(keys: &[f32], values: &[f32]) -> Stroke {
        let mut tangents = vec![0.0; keys.len()];
        for i in 1..keys.len().saturating_sub(1) {
            let (before, after) = (keys[i] - keys[i - 1], keys[i + 1] - keys[i]);
            let (a, b) = ((values[i] - values[i - 1]) / before, (values[i + 1] - values[i]) / after);
            if a * b > 0.0 {
                let (wa, wb) = (2.0 * after + before, after + 2.0 * before);
                tangents[i] = (wa + wb) / (wa / a + wb / b);
            }
        }
        Stroke { keys: keys.to_vec(), values: values.to_vec(), tangents }
    }

    pub fn at(&self, phase: f32) -> f32 {
        let (k, v, m) = (&self.keys, &self.values, &self.tangents);
        for i in 1..k.len() {
            if phase <= k[i] {
                let h = k[i] - k[i - 1];
                let t = ((phase - k[i - 1]) / h).clamp(0.0, 1.0);
                let (t2, t3) = (t * t, t * t * t);
                return (2.0 * t3 - 3.0 * t2 + 1.0) * v[i - 1] + (t3 - 2.0 * t2 + t) * h * m[i - 1] + (-2.0 * t3 + 3.0 * t2) * v[i] + (t3 - t2) * h * m[i];
            }
        }
        *v.last().unwrap_or(&0.0)
    }
}

// ---------------------------------------------------------------------------------------------
// The grip (heldItem.ts handGrip)
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct GripSocket {
    /// The node the tool hangs on (the hand's controller bone).
    pub bone: usize,
    /// The bone's parent named "torso", if any (the upper body leans and twists with the stroke).
    pub torso: Option<usize>,
    /// The socket on the bone and the tool's rotation there.
    pub point: Vec3,
    pub rotation: Quat,
    /// The bone's rest rotation (the approved Idle grasp the pose blends from).
    pub rest: Quat,
}

fn euler(v: [f32; 3]) -> Quat {
    Quat::from_euler(EulerRot::XYZ, v[0], v[1], v[2])
}

/// handGrip: find the right hand, the bone that actually moves the vertices round its palm (the
/// short mitten is weighted to the upper arm), and the socket in bind space on that bone.
pub fn grip(model: &Model, def: &Def) -> Option<GripSocket> {
    let norm = |s: &str| s.replace(['.', '_'], "").to_lowercase();
    let hand = model.joints.iter().position(|&n| norm(&model.names[n]) == "handr")?;
    let palm = model.inverse_bind[hand].inverse().w_axis.truncate();
    let mut influence: HashMap<u16, f32> = HashMap::new();
    for (p, w) in model.positions.iter().zip(&model.weights) {
        if p.distance_squared(palm) > 0.12 * 0.12 {
            continue;
        }
        for &(j, wt) in w {
            if wt > 0.0 {
                *influence.entry(j).or_insert(0.0) += wt;
            }
        }
    }
    let controller = influence.iter().max_by(|a, b| a.1.total_cmp(b.1)).map(|(&j, _)| j as usize)?;
    let inverse = model.inverse_bind.get(controller)?;
    let (_, bind_rotation, _) = inverse.inverse().to_scale_rotation_translation();
    let tool = euler(def.grip.rotation);
    let rotation = bind_rotation.inverse() * tool;
    let socket = palm + Vec3::from(def.grip.bind_offset) + tool * Vec3::new(0.0, def.grip.handle_slide * def.grip.scale, 0.0);
    let bone = model.joints[controller];
    let torso = model.parent[bone].filter(|&p| model.names[p].to_lowercase() == "torso");
    Some(GripSocket { bone, torso, point: inverse.transform_point3(socket), rotation, rest: model.rest[bone].r })
}

// ---------------------------------------------------------------------------------------------
// The pose (heldItem.ts HeldItemInstance.updatePose)
// ---------------------------------------------------------------------------------------------

/// What the pose needs from the frame: the swing phase (None: not attacking), whether holding
/// is allowed at all, the body's speed, gait phase and grounding, and its yaw (for the turn lag).
#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub dt: f32,
    pub phase: Option<f32>,
    pub allowed: bool,
    pub speed: f32,
    pub gait_phase: f32,
    pub grounded: bool,
    pub yaw: f32,
}

#[derive(Default)]
pub struct HeldPose {
    hold_age: f32,
    clock: f32,
    speed: f32,
    last_speed: f32,
    last_yaw: Option<f32>,
    turn_lag: f32,
    acceleration_lag: f32,
    lean: f32,
    twist: f32,
    swing_strength: f32,
    previous_offset: Option<Quat>,
    /// Shown (equipOpacity past half: the app draws it solid or not at all).
    pub visible: bool,
}

/// THREE.MathUtils.damp: frame-rate independent ease toward `y`.
fn damp(x: f32, y: f32, lambda: f32, dt: f32) -> f32 {
    x + (y - x) * (1.0 - (-lambda * dt).exp())
}

fn smoothstep(x: f32, a: f32, b: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// A node's model-space rotation (its parents' and its own local rotations).
fn world_rot(model: &Model, local: &[Trs], mut node: usize) -> Quat {
    let mut q = local[node].r;
    while let Some(p) = model.parent[node] {
        q = local[p].r * q;
        node = p;
    }
    q
}

impl HeldPose {
    /// updatePose on this frame's local pose (after the clips and the upper layer). Changes the
    /// controller bone and the torso in `local`; `visible` says whether the item is drawn.
    pub fn apply(&mut self, model: &Model, local: &mut [Trs], grip: &GripSocket, item: &Item, f: Frame) {
        let dt = if f.dt.is_finite() { f.dt.clamp(0.0, 0.25) } else { 0.0 };
        if dt <= 0.0 {
            return;
        }
        let g = &item.def.grip;
        let tune = &g.motion;
        self.clock += dt;
        let raw = if f.speed.is_finite() { f.speed.max(0.0) } else { 0.0 };
        self.speed = damp(self.speed, raw, tune.response, dt);
        let acceleration = ((raw - self.last_speed) / dt).clamp(-8.0, 8.0);
        self.last_speed = raw;
        self.acceleration_lag = damp(self.acceleration_lag, (acceleration * tune.acceleration_lag).clamp(-tune.max_acceleration_lag, tune.max_acceleration_lag), 10.0, dt);
        let delta = self.last_yaw.map_or(0.0, |l| (f.yaw - l).sin().atan2((f.yaw - l).cos()));
        self.last_yaw = Some(f.yaw);
        // teleports and hard facing resets must never wind up a spring
        let rate = if delta.abs() > 0.6 { 0.0 } else { delta / dt };
        self.turn_lag = damp(self.turn_lag, (-rate * tune.turn_lag).clamp(-tune.max_turn_lag, tune.max_turn_lag), 10.0, dt);
        if !f.allowed {
            *self = HeldPose { clock: self.clock, last_yaw: self.last_yaw, last_speed: self.last_speed, ..HeldPose::default() };
            return;
        }
        self.hold_age = (self.hold_age + dt).clamp(0.0, g.equip_seconds);
        let progress = (self.hold_age / g.equip_seconds).min(1.0);
        let hold_weight = smoothstep(progress, 0.0, 1.0);
        // the tool appears as the hand lifts into its grasp (opacity past half: drawn)
        self.visible = smoothstep(progress, 0.2, 0.75) >= 0.5;

        let bone = grip.bone;
        let base = local[bone].r;
        self.swing_strength = damp(self.swing_strength, if f.phase.is_some() { 1.0 } else { 0.0 }, 22.0, dt);
        let ss = self.swing_strength;
        let source = (if f.grounded { tune.source_arm_weight } else { tune.air_arm_weight }) * (1.0 - ss) + tune.attack_arm_weight * ss;
        let stance = grip.rest.slerp(base, source);
        let [lx, ly, lz] = g.lift_rotation;
        let settle = (std::f32::consts::PI * progress).sin() * 0.025;
        let gait = f.gait_phase * std::f32::consts::TAU;
        let (run, movement) = (smoothstep(self.speed, 2.9, 4.4), smoothstep(self.speed, 0.08, 2.2));
        let sway_weight = (1.0 + (tune.attack_sway_weight - 1.0) * ss) * if f.grounded { 1.0 } else { 0.35 };
        let sway = |a: usize| (tune.walk_sway[a] + (tune.run_sway[a] - tune.walk_sway[a]) * run) * movement * sway_weight;
        let c = self.clock * 1.8;
        let pitch_sway = gait.sin() * sway(0) + c.sin() * tune.idle_sway[0] * (1.0 - movement);
        let yaw_sway = (gait - 0.45).sin() * sway(1) + self.turn_lag * sway_weight + (c + 0.3).sin() * tune.idle_sway[1] * (1.0 - movement);
        let roll_sway = (gait + 0.4).sin() * sway(2) + (c + 0.6).sin() * tune.idle_sway[2] * (1.0 - movement);
        let time = f.phase.map_or(0.0, |p| p.rem_euclid(1.0));
        let [st_pitch, st_side, st_lean, st_roll, st_twist] = &item.strokes;
        let mut offset = euler([pitch_sway + self.acceleration_lag * sway_weight + st_pitch.at(time) * ss, yaw_sway + st_side.at(time) * ss, roll_sway + st_roll.at(time) * ss]);
        // on release only, the last offset decays instead of snapping to zero
        if f.phase.is_none() && ss > 0.001 {
            if let Some(prev) = self.previous_offset {
                offset = prev.slerp(offset, 1.0 - (-16.0 * dt).exp());
            }
        }
        self.previous_offset = Some(offset);
        let target_lean = st_lean.at(time) * ss * hold_weight;
        self.lean = if f.phase.is_some() { target_lean } else { damp(self.lean, 0.0, 16.0, dt) };
        let target_twist = st_twist.at(time) * ss * hold_weight;
        self.twist = if f.phase.is_some() { target_twist } else { damp(self.twist, 0.0, 16.0, dt) };
        if let Some(torso) = grip.torso {
            // a little upper-body weight forward, feet planted: about the character's right and up
            let inv = world_rot(model, local, torso).inverse();
            let (lean_axis, twist_axis) = ((inv * Vec3::X).normalize(), (inv * Vec3::Y).normalize());
            let off = Quat::from_axis_angle(lean_axis, self.lean) * Quat::from_axis_angle(twist_axis, self.twist);
            local[torso].r = (local[torso].r * off).normalize();
        }
        let rotation = euler([lx - settle, ly, lz]) * offset;
        let parent = model.parent[bone].map_or(Quat::IDENTITY, |p| world_rot(model, local, p));
        let target = parent.inverse() * (rotation * (parent * stance));
        local[bone].r = base.slerp(target, hold_weight).normalize();
    }
}

/// The item on its bone: (model-space bone matrix) × socket → world triangles, into `out`.
pub fn mesh(item: &Item, grip: &GripSocket, place: Mat4, bone_global: Mat4, out: &mut Vec<CharVertex>) {
    let m = place * bone_global * Mat4::from_scale_rotation_translation(Vec3::splat(item.def.grip.scale), grip.rotation, grip.point);
    let nm = glam::Mat3::from_mat4(m).inverse().transpose();
    out.reserve(item.indices.len());
    for &i in &item.indices {
        let i = i as usize;
        out.push(CharVertex { pos: m.transform_point3(item.positions[i]).to_array(), nrm: (nm * item.normals[i]).normalize_or_zero().to_array(), uv: item.uvs[i] });
    }
}

// ---------------------------------------------------------------------------------------------
// Striking and mining (itemAttack.ts, toolDefinitions.ts)
// ---------------------------------------------------------------------------------------------

/// One stroke's frame: the time it ran from and to, and what happened.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Step {
    pub from: f32,
    pub to: f32,
    pub active: bool,
    pub started: bool,
    pub completed: bool,
}

/// ItemAttack: one click commits one whole strike; holding repeats; release completes the current
/// stroke. (Changing equipment resets it — the caller calls `reset`.)
#[derive(Default)]
pub struct Attack {
    elapsed: f32,
    finish_at: f32,
    committed_until: f32,
    running: bool,
    requested: bool,
}

impl Attack {
    pub fn active(&self) -> bool {
        self.running
    }
    pub fn time(&self) -> f32 {
        self.elapsed
    }
    /// A press (a click / tap): commits a stroke even if released at once.
    pub fn request(&mut self) {
        self.requested = true;
    }
    pub fn reset(&mut self) {
        *self = Attack::default();
    }

    pub fn step(&mut self, dt: f32, held: bool, cycle: f32) -> Step {
        let empty = Step { from: self.elapsed, to: self.elapsed, ..Step::default() };
        if !cycle.is_finite() || cycle <= 0.0 {
            self.reset();
            return empty;
        }
        if !dt.is_finite() || dt <= 0.0 {
            return Step { active: self.running, ..empty };
        }
        let pressed = std::mem::take(&mut self.requested);
        let started = !self.running && (pressed || held);
        if started {
            self.running = true;
            self.elapsed = 0.0;
            self.finish_at = f32::INFINITY;
            self.committed_until = cycle;
        }
        if !self.running {
            return empty;
        }
        // keep at most one upcoming stroke: holding consumes the commitment
        if pressed && !started {
            self.committed_until = self.committed_until.max(((self.elapsed / cycle).floor() + 2.0) * cycle);
        }
        self.finish_at = if held { f32::INFINITY } else { self.committed_until.max(cycle).max(((self.elapsed - 1e-6) / cycle).ceil() * cycle) };
        let from = self.elapsed;
        self.elapsed = (self.elapsed + dt).min(self.finish_at);
        let completed = self.elapsed + 1e-6 >= self.finish_at;
        if completed {
            self.running = false;
        }
        Step { from, to: self.elapsed, active: self.running, started, completed }
    }
}

/// toolDefinitions.ts pickaxeFamily: the efficiency family of a block key.
pub fn family(key: &str) -> &'static str {
    let has = |s: &str| key.contains(s);
    if key.ends_with("-ore") {
        "ore"
    } else if ["planks", "log", "bookshelf", "hay"].iter().any(|s| has(s)) {
        "wood"
    } else if ["grass", "dirt", "sand", "gravel", "clay"].iter().any(|s| has(s)) {
        "ground"
    } else if has("iron-block") || has("gold-block") {
        "metal"
    } else if has("diamond-block") || has("obsidian") {
        "gem"
    } else if ["stone", "bricks", "bedrock"].iter().any(|s| has(s)) {
        "stone"
    } else {
        "other"
    }
}

impl Item {
    /// pickaxeCycle (the balanced option): one stroke's seconds.
    pub fn cycle(&self) -> f32 {
        self.def.swing.seconds
    }
    /// pickaxeImpacts: blade impacts between two swing times (a slow frame may cross two).
    pub fn impacts(&self, from: f32, to: f32) -> u32 {
        if !(from.is_finite() && to.is_finite()) || to <= from || from < 0.0 {
            return 0;
        }
        let cycle = self.cycle();
        let impact = cycle * self.def.swing.impact_at;
        let count = |t: f32| ((t - impact + 1e-6) / cycle).floor().max(-1.0) + 1.0;
        (count(to) - count(from)).max(0.0) as u32
    }
    /// pickaxeWork: mining work between two swing times — each impact is worth the swing's seconds
    /// times the block's efficiency.
    pub fn work(&self, from: f32, to: f32, key: &str) -> f64 {
        let eff = self.def.efficiency.get(family(key)).copied().unwrap_or(1.0);
        (self.impacts(from, to) as f32 * self.def.swing.seconds * eff) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::character::{model, Kind};

    #[test]
    fn the_item_reads_with_its_numbers_and_model() {
        let i = load().map_err(|e| panic!("{e}")).unwrap();
        assert!(item().is_some());
        assert_eq!(i.def.id, "pickaxe-basic");
        assert_eq!((i.def.swing.seconds, i.def.swing.impact_at), (0.72, 0.58));
        assert!(i.indices.len() > 3000 && i.indices.len().is_multiple_of(3));
        let (w, h, px) = &i.texture;
        assert!(*w >= 64 && px.len() == (*w * *h * 4) as usize);
    }

    #[test]
    fn strokes_pass_their_keys_without_overshoot() {
        let i = item().unwrap();
        let s = &i.def.swing;
        for (stroke, values) in i.strokes.iter().zip([&s.pitch, &s.side, &s.lean, &s.roll, &s.twist]) {
            for (k, v) in s.phases.iter().zip(values.iter()) {
                assert!((stroke.at(*k) - v).abs() < 1e-5);
            }
            let (lo, hi) = values.iter().fold((f32::MAX, f32::MIN), |a, v| (a.0.min(*v), a.1.max(*v)));
            for n in 0..=100 {
                let y = stroke.at(n as f32 / 100.0);
                assert!(y >= lo - 1e-4 && y <= hi + 1e-4, "monotone between keys: {y} outside {lo}..{hi}");
            }
        }
    }

    #[test]
    fn impacts_and_work_follow_tool_definitions() {
        let i = item().unwrap();
        let c = i.cycle();
        assert_eq!(i.impacts(0.0, c * 0.57), 0);
        assert_eq!(i.impacts(0.0, c * 0.59), 1, "the blade lands at 0.58 of the stroke");
        assert_eq!(i.impacts(c * 0.5, c * 2.6), 3, "a long frame crosses several");
        assert_eq!(i.impacts(1.0, 0.5), 0);
        assert!((i.work(0.0, c, "stone") - 0.72 * 1.6).abs() < 1e-5, "stone is pickaxe work ×1.6");
        assert_eq!((family("iron-ore"), family("oak-planks"), family("grass"), family("gold-block"), family("stone-bricks"), family("glass")), ("ore", "wood", "ground", "metal", "stone", "other"));
    }

    #[test]
    fn a_click_commits_one_stroke_and_holding_repeats() {
        let c = 0.72;
        let mut a = Attack::default();
        a.request();
        let mut t = 0.0;
        while a.step(1.0 / 60.0, false, c).active || t == 0.0 {
            t += 1.0 / 60.0;
            assert!(t < 2.0);
        }
        assert!((a.time() - c).abs() < 1e-3, "a click: exactly one stroke");
        let mut a = Attack::default();
        for _ in 0..(3.0 * 60.0) as usize {
            a.step(1.0 / 60.0, true, c);
        }
        assert!(a.active() && a.time() > 2.9);
        // released mid-stroke: finishes that stroke, then stops
        while a.step(1.0 / 60.0, false, c).active {}
        assert!((a.time() / c - (a.time() / c).round()).abs() < 1e-3, "stops on a stroke boundary");
    }

    #[test]
    fn both_characters_grip_it_in_the_right_hand_and_the_pose_stays_sane() {
        let i = item().unwrap();
        for kind in [Kind::Home, Kind::Tt] {
            let m = model(kind).unwrap();
            let g = grip(m, &i.def).expect("a right hand to hold it");
            assert!(m.names[g.bone].to_lowercase().contains("arm") || m.names[g.bone].to_lowercase().contains("hand"), "{}", m.names[g.bone]);
            let mut pose = HeldPose::default();
            let mut local = m.rest.clone();
            for n in 0..120 {
                local.clone_from(&m.rest);
                let phase = (n >= 30).then(|| (n - 30) as f32 / 60.0 / i.cycle());
                pose.apply(m, &mut local, &g, i, Frame { dt: 1.0 / 60.0, phase, allowed: true, speed: 0.0, gait_phase: 0.0, grounded: true, yaw: 0.0 });
                assert!(local.iter().all(|t| t.r.is_finite() && (t.r.length() - 1.0).abs() < 1e-3));
            }
            assert!(pose.visible, "equipped after the ease");
            assert!(local[g.bone].r.angle_between(m.rest[g.bone].r) > 0.05, "the stroke moves the arm");
        }
    }
}
