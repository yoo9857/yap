//! The pet that tags along on the island and in the field ??the web's, three parts of it:
//!
//! - **the brain** = `player/pet.ts`, line for line (bands with hysteresis, hop at a step before
//!   walking into it, blocked ??slide along ??flip sides ??give up and ask for a recall, stay is
//!   absolute), pure and unit-tested with the web's own cases;
//! - **the creature** = `player/creatureRig.ts`: its scene tree comes from the web's own code
//!   (`pnpm engine:pets` ??`engine/assets/pets`, every part's shape and colour, every node's rest
//!   pose and the role `update()` animates it as) and [`Rig::update`] is a port of
//!   `CreatureRig.update` ??the trot in diagonal pairs, the eased sit and airborne blend, ears that
//!   lag, the trunk's travelling wave, blinks and the squash spring. Posed on the CPU (??6??k
//!   vertices) and drawn with the furniture pipeline (vertex colours, roughness 0.68, shadows);
//! - **the companion** = `craft/petCompanion.ts`: a core `Body` with the species' own footprint and
//!   hop, stepped at 60 Hz through the same sweep as the player (so it cannot pass anything the
//!   player cannot), the step probe ahead, recall beside the owner at the owner's level, drawn
//!   between ticks with an eased turn.
//!
//! The visuals are temporary on the web too (modelled pets will replace creatureRig.ts); a new rig
//! arrives here by re-running the exporter, the brain and the glue stay.

use crate::furniture::FurnitureVertex;
use craftyap_core::body::{can_occupy, step_body, unstick, Body, BodyWorld, BODY_HEIGHT};
use glam::{EulerRot, Mat3, Mat4, Quat, Vec3};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

// ---------------------------------------------------------------------------------------------
// The brain (pet.ts)
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Anim {
    Idle,
    Walk,
    Run,
    Jump,
    Fall,
    Sit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Follow,
    Stay,
}

/// Start moving beyond this, stop once inside CHASE_OUT.
pub const CHASE_IN: f64 = 2.6;
pub const CHASE_OUT: f64 = 1.5;
/// Break into a run beyond this, drop back to a walk inside SPRINT_OUT.
pub const SPRINT_IN: f64 = 6.5;
pub const SPRINT_OUT: f64 = 4.0;
/// Wish magnitudes ??step_body multiplies these by MOVE_SPEED.
pub const WALK_GAIN: f64 = 0.52;
pub const RUN_GAIN: f64 = 1.08;
/// Lost for good: reappear instead of jogging forever.
pub const TELEPORT_DIST: f64 = 28.0;
/// Owner this far above: the pet is down a hole or off the edge.
pub const TELEPORT_DROP: f64 = 14.0;
const STUCK_TIME: f64 = 0.25;
const SIDESTEP_AFTER: f64 = 0.5;
const SIDESTEP_FLIP: f64 = 1.8;
const LOST_TIME: f64 = 6.0;
const STUCK_SPEED: f64 = 0.55;
const GAIN_MARGIN: f64 = 0.35;
const OWNER_RAN_OFF: f64 = 4.0;
const HOP_COOLDOWN: f64 = 0.4;
const STEP_UP: f64 = 0.9;

/// Carried between ticks (pet.ts PetBrain).
#[derive(Clone, Debug)]
pub struct Brain {
    pub mode: Mode,
    pub chasing: bool,
    pub sprinting: bool,
    /// Seconds of near-zero displacement while wanting to move (drives hop, then sidestep).
    pub blocked: f64,
    /// Seconds since the last real gain on the owner (drives the give-up recall).
    pub no_gain: f64,
    pub best_dist: f64,
    pub hop_cooldown: f64,
    pub side_sign: f64,
    pub last_x: f64,
    pub last_z: f64,
    pub yaw: f64,
    pub anim: Anim,
}

impl Default for Brain {
    fn default() -> Self {
        Brain { mode: Mode::Follow, chasing: false, sprinting: false, blocked: 0.0, no_gain: 0.0, best_dist: f64::INFINITY, hop_cooldown: 0.0, side_sign: 1.0, last_x: 0.0, last_z: 0.0, yaw: 0.0, anim: Anim::Idle }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Command {
    pub wish_x: f64,
    pub wish_z: f64,
    pub jump: bool,
    pub teleport: bool,
    pub anim: Anim,
    pub yaw: f64,
}

impl Brain {
    /// Sit ??follow; returns the new mode.
    pub fn toggle(&mut self) -> Mode {
        self.mode = if self.mode == Mode::Follow { Mode::Stay } else { Mode::Follow };
        if self.mode == Mode::Stay {
            self.chasing = false;
            self.sprinting = false;
            self.reset_progress();
        }
        self.mode
    }

    fn reset_progress(&mut self) {
        self.blocked = 0.0;
        self.no_gain = 0.0;
        self.best_dist = f64::INFINITY;
    }

    fn command(&mut self, wish_x: f64, wish_z: f64, jump: bool, teleport: bool, anim: Anim) -> Command {
        self.anim = anim;
        Command { wish_x, wish_z, jump, teleport, anim, yaw: self.yaw }
    }

    /// pet.ts `thinkPet`. `pos` is the pet's feet, `owner` the owner's; `step_ahead` = the caller's
    /// probe (a one-block step right ahead with clear air above it).
    pub fn think(&mut self, pos: (f64, f64, f64), grounded: bool, owner: (f64, f64, f64), dt: f64, step_ahead: bool) -> Command {
        let (dx, dz) = (owner.0 - pos.0, owner.2 - pos.2);
        let dist = dx.hypot(dz);
        self.hop_cooldown = (self.hop_cooldown - dt).max(0.0);
        let moved = (pos.0 - self.last_x).hypot(pos.2 - self.last_z);
        self.last_x = pos.0;
        self.last_z = pos.2;

        if self.mode == Mode::Stay {
            self.reset_progress();
            return self.command(0.0, 0.0, false, false, if grounded { Anim::Sit } else { Anim::Fall });
        }
        if dist > TELEPORT_DIST || owner.1 - pos.1 > TELEPORT_DROP {
            self.chasing = false;
            self.sprinting = false;
            self.reset_progress();
            return self.command(0.0, 0.0, false, true, Anim::Idle);
        }
        self.chasing = if self.chasing { dist > CHASE_OUT } else { dist >= CHASE_IN };
        self.sprinting = if self.sprinting { dist > SPRINT_OUT } else { dist >= SPRINT_IN };
        if !self.chasing {
            self.reset_progress();
            if dist > 0.05 {
                self.yaw = dx.atan2(dz);
            }
            return self.command(0.0, 0.0, false, false, if grounded { Anim::Idle } else { Anim::Fall });
        }
        if moved < STUCK_SPEED * dt {
            self.blocked += dt;
        } else {
            self.blocked = 0.0;
        }
        if dist > self.best_dist + OWNER_RAN_OFF {
            self.reset_progress();
            self.best_dist = dist;
        } else if dist < self.best_dist - GAIN_MARGIN {
            self.best_dist = dist;
            self.no_gain = 0.0;
        } else {
            self.no_gain += dt;
        }
        if self.no_gain >= LOST_TIME {
            self.reset_progress();
            return self.command(0.0, 0.0, false, true, Anim::Idle);
        }
        let gain = if self.sprinting { RUN_GAIN } else { WALK_GAIN };
        let inv = 1.0 / if dist == 0.0 { 1.0 } else { dist };
        let (mut ux, mut uz) = (dx * inv, dz * inv);
        if self.blocked >= SIDESTEP_AFTER {
            let slot = ((self.blocked - SIDESTEP_AFTER) / SIDESTEP_FLIP).floor() as i64;
            self.side_sign = if slot % 2 == 0 { 1.0 } else { -1.0 };
            let (sx, sz) = (-uz * self.side_sign, ux * self.side_sign);
            let (bx, bz) = (ux * 0.45 + sx, uz * 0.45 + sz);
            let blen = bx.hypot(bz);
            let blen = if blen == 0.0 { 1.0 } else { blen };
            ux = bx / blen;
            uz = bz / blen;
        }
        self.yaw = ux.atan2(uz);
        let wants_step_up = owner.1 - pos.1 > STEP_UP && dist < CHASE_IN * 2.0;
        let jump = grounded && self.hop_cooldown <= 0.0 && (step_ahead || self.blocked >= STUCK_TIME || wants_step_up);
        if jump {
            self.hop_cooldown = HOP_COOLDOWN;
        }
        let anim = if !grounded {
            Anim::Jump
        } else if self.sprinting {
            Anim::Run
        } else {
            Anim::Walk
        };
        self.command(ux * gain, uz * gain, jump, false, anim)
    }
}

// ---------------------------------------------------------------------------------------------
// The species and their scene trees (engine/assets/pets, generated from creatureRig.ts)
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Geometry {
    vertex_start: usize,
    vertex_count: usize,
    index_start: usize,
    index_count: usize,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Skeleton {
    pub chest_y: f32,
    pub shoulder_y: f32,
    pub sit_hip_y: f32,
    pub sit_lean: f32,
    pub bob: f32,
    pub stride: f32,
    pub cadence: f32,
}

#[derive(Deserialize)]
struct NodeDef {
    parent: i32,
    position: [f32; 3],
    rotation: [f32; 3],
    scale: [f32; 3],
    role: Option<String>,
    geometry: Option<usize>,
    color: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeciesDef {
    pub body_width: f64,
    pub body_height: f64,
    pub jump_speed: f64,
    pub pace: f64,
    pub name: String,
    /// One line of character for the adoption card (creatureRig.ts SPECIES.trait).
    #[serde(rename = "trait")]
    pub trait_line: String,
    pub skeleton: Skeleton,
    pub tail_amp: f32,
    pub tail_pitch: f32,
    nodes: Vec<NodeDef>,
}

#[derive(Deserialize)]
struct PetFile {
    species: Vec<String>,
    geometries: Vec<Geometry>,
    pets: HashMap<String, SpeciesDef>,
}

pub struct PetData {
    /// The adoption order (creatureRig.ts PET_SPECIES).
    pub order: Vec<String>,
    pub species: HashMap<String, SpeciesDef>,
    geometries: Vec<Geometry>,
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
}

/// The exported pets, parsed once (None only if the generated files are broken).
pub fn data() -> Option<&'static PetData> {
    static DATA: OnceLock<Option<PetData>> = OnceLock::new();
    DATA.get_or_init(|| {
        let file: PetFile = match serde_json::from_str(include_str!("../../../assets/pets/pets.json")) {
            Ok(f) => f,
            Err(e) => {
                log::error!("pets: pets.json does not parse ({e})");
                return None;
            }
        };
        let bin: &[u8] = include_bytes!("../../../assets/pets/pets.bin");
        let verts: usize = file.geometries.iter().map(|g| g.vertex_count).sum();
        let idx: usize = file.geometries.iter().map(|g| g.index_count).sum();
        if bin.len() != verts * 24 + idx * 4 {
            log::error!("pets: pets.bin does not match pets.json");
            return None;
        }
        let f32s = |at: usize, n: usize| -> Vec<f32> { (0..n).map(|i| f32::from_le_bytes(bin[at + i * 4..at + i * 4 + 4].try_into().unwrap())).collect() };
        let positions = f32s(0, verts * 3);
        let normals = f32s(verts * 12, verts * 3);
        let indices = (0..idx).map(|i| u32::from_le_bytes(bin[verts * 24 + i * 4..verts * 24 + i * 4 + 4].try_into().unwrap())).collect();
        Some(PetData { order: file.species, species: file.pets, geometries: file.geometries, positions, normals, indices })
    })
    .as_ref()
}

/// A species key the app knows, else the dog (a save from a newer app, a hand-edited file).
pub fn species_or_dog(key: &str) -> &'static str {
    data().and_then(|d| d.order.iter().find(|k| k.as_str() == key)).map_or("dog", |k| k.as_str())
}

/// 을 after a final consonant, 를 after a vowel (시바견을, 판다를).
pub fn object_particle(word: &str) -> &'static str {
    match word.chars().last() {
        Some(c @ '가'..='힣') if !(c as u32 - 0xac00).is_multiple_of(28) => "을",
        _ => "를",
    }
}

// ---------------------------------------------------------------------------------------------
// The rig (CreatureRig.update)
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Pose {
    pos: Vec3,
    rot: Vec3,
    scale: Vec3,
}

pub struct Rig {
    pub species: &'static str,
    def: &'static SpeciesDef,
    pose: Vec<Pose>,
    toy: usize,
    spine: usize,
    head: usize,
    tail: usize,
    legs: [usize; 4],
    ears: Vec<usize>,
    /// Trunk links and their rest pitch (the wave is added to it, never written over it).
    chain: Vec<(usize, f32)>,
    eyes: Vec<usize>,
    phase: f32,
    blink_t: f32,
    blink: f32,
    sit: f32,
    air: f32,
    last_air: f32,
    squash: f32,
    squash_vel: f32,
    seed: u32,
}

const SQUASH_STIFF: f32 = 190.0;
const SQUASH_DAMP: f32 = 15.0;

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

impl Rig {
    pub fn new(species: &str, seed: u32) -> Option<Rig> {
        let d = data()?;
        let key = species_or_dog(species);
        let def = d.species.get(key)?;
        let pose = def.nodes.iter().map(|n| Pose { pos: n.position.into(), rot: n.rotation.into(), scale: n.scale.into() }).collect();
        let find = |role: &str| def.nodes.iter().position(|n| n.role.as_deref() == Some(role));
        let many = |prefix: &str| -> Vec<usize> { (0..).map_while(|i| find(&format!("{prefix}{i}"))).collect() };
        let legs = [find("leg0")?, find("leg1")?, find("leg2")?, find("leg3")?];
        let chain = many("chain").into_iter().map(|i| (i, def.nodes[i].rotation[0])).collect();
        let mut r = Rig { species: key, def, pose, toy: find("toy")?, spine: find("spine")?, head: find("head")?, tail: find("tail")?, legs, ears: many("ear"), chain, eyes: many("eye"), phase: 0.0, blink_t: 0.0, blink: 0.0, sit: 0.0, air: 0.0, last_air: 1.0, squash: 0.0, squash_vel: 0.0, seed: seed | 1 };
        // a litter doesn't march in step
        r.phase = r.rand() * std::f32::consts::TAU;
        r.blink_t = 1.5 + r.rand() * 3.0;
        Some(r)
    }

    fn rand(&mut self) -> f32 {
        self.seed = self.seed.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.seed >> 8) as f32 / (1 << 24) as f32
    }

    pub fn def(&self) -> &'static SpeciesDef {
        self.def
    }

    /// The squash spring's kick (hops, landings, a "hello" on adoption).
    pub fn pop(&mut self, impulse: f32) {
        self.squash_vel += impulse;
    }

    fn step_squash(&mut self, dt: f32) {
        let h = dt.min(1.0 / 30.0);
        self.squash_vel += (-SQUASH_STIFF * self.squash - SQUASH_DAMP * self.squash_vel) * h;
        self.squash = (self.squash + self.squash_vel * h).clamp(-0.35, 0.45);
        let sy = 1.0 + self.squash;
        let sxz = 1.0 / sy.sqrt();
        self.pose[self.toy].scale = Vec3::new(sxz, sy, sxz);
    }

    /// creatureRig.ts `update(anim, speed, dt)`, number for number.
    pub fn update(&mut self, anim: Anim, speed: f32, dt: f32) {
        let sk = self.def.skeleton;
        let (tail_amp0, tail_pitch) = (self.def.tail_amp, self.def.tail_pitch);
        let moving = matches!(anim, Anim::Walk | Anim::Run);
        let cadence = if moving { (speed * sk.cadence).clamp(4.0, 18.0) } else { 3.0 };
        self.phase += dt * cadence;
        self.sit += (if anim == Anim::Sit { 1.0 } else { 0.0 } - self.sit) * (dt * 7.0).min(1.0);

        self.blink_t -= dt;
        if self.blink_t <= 0.0 {
            self.blink = 1.0;
            if self.blink_t <= -0.1 {
                self.blink = 0.0;
                self.blink_t = 1.5 + self.rand() * 3.5;
            }
        }
        for &e in &self.eyes {
            self.pose[e].scale.y = 1.0 - self.blink * 0.8;
        }

        let airborne = matches!(anim, Anim::Jump | Anim::Fall);
        self.air += (if airborne { 1.0 } else { 0.0 } - self.air) * (dt * 11.0).min(1.0);

        let (mut swing, mut bob_y, mut lean, mut head_pitch);
        let (mut tail_rate, mut tail_amp);
        if moving {
            swing = self.phase.sin();
            bob_y = self.phase.sin().abs() * sk.bob;
            lean = if anim == Anim::Run { 0.1 } else { 0.04 };
            head_pitch = 0.0;
            tail_rate = if anim == Anim::Run { 13.0 } else { 8.0 };
            tail_amp = tail_amp0 * if anim == Anim::Run { 1.5 } else { 1.0 };
        } else {
            swing = 0.0;
            lean = 0.0;
            bob_y = (self.phase * 0.6).sin() * 0.012;
            head_pitch = (self.phase * 0.23).sin() * 0.07;
            tail_rate = if anim == Anim::Sit { 5.0 } else { 3.2 };
            tail_amp = tail_amp0 * if anim == Anim::Sit { 0.9 } else { 0.6 };
        }
        if self.air > 0.001 {
            if airborne {
                self.last_air = if anim == Anim::Jump { 1.0 } else { -1.0 };
            }
            let up = self.last_air > 0.0;
            let t = self.air;
            swing = lerp(swing, if up { -0.34 } else { 0.26 }, t);
            bob_y = lerp(bob_y, 0.0, t);
            lean = lerp(lean, if up { -0.06 } else { 0.08 }, t);
            head_pitch = lerp(head_pitch, if up { -0.22 } else { 0.18 }, t);
            tail_rate = lerp(tail_rate, 6.0, t);
            tail_amp = lerp(tail_amp, tail_amp0, t);
        }

        // diagonal pairs: FL + BR against FR + BL (the trot)
        let [fl, fr, bl, br] = self.legs;
        let a = swing * (if moving { sk.stride } else { 0.0 }).max(self.air);
        self.pose[fl].rot.x = a;
        self.pose[br].rot.x = a;
        self.pose[fr].rot.x = -a;
        self.pose[bl].rot.x = -a;
        self.pose[bl].pos.y = sk.shoulder_y;
        self.pose[br].pos.y = sk.shoulder_y;
        if self.sit > 0.01 {
            let t = self.sit;
            for back in [bl, br] {
                self.pose[back].rot.x = lerp(self.pose[back].rot.x, -1.25, t);
                self.pose[back].pos.y = lerp(sk.shoulder_y, sk.sit_hip_y, t);
            }
            self.pose[fl].rot.x = lerp(self.pose[fl].rot.x, 0.0, t);
            self.pose[fr].rot.x = lerp(self.pose[fr].rot.x, 0.0, t);
            lean = lerp(lean, sk.sit_lean, t);
            bob_y = lerp(bob_y, -0.06, t);
            head_pitch = lerp(head_pitch, 0.12, t);
        }

        let spine = &mut self.pose[self.spine];
        spine.pos.y = sk.chest_y + bob_y;
        spine.rot.x = lean;
        spine.rot.z = if moving { self.phase.sin() * 0.035 } else { 0.0 };
        let head = &mut self.pose[self.head];
        head.rot.x = head_pitch;
        head.rot.z = if moving { 0.0 } else { (self.phase * 0.31).sin() * 0.09 };

        let flop = if moving { (self.phase - 0.9).sin() * 0.22 } else { (self.phase * 0.5).sin() * 0.05 };
        for (i, &e) in self.ears.iter().enumerate() {
            let sx = if i == 0 { -1.0 } else { 1.0 };
            self.pose[e].rot.x = flop;
            self.pose[e].rot.z = sx * flop * 0.4;
        }
        let drive = if moving { 1.0 } else { 0.45 };
        for (i, &(seg, rest)) in self.chain.iter().enumerate() {
            let lag = i as f32 * 0.7;
            self.pose[seg].rot.x = rest + (self.phase * 1.6 - lag).sin() * 0.14 * drive;
            self.pose[seg].rot.y = (self.phase * 0.9 - lag).sin() * 0.1 * drive;
        }
        let tail = &mut self.pose[self.tail];
        tail.rot.y = (self.phase * tail_rate).sin() * tail_amp;
        tail.rot.x = tail_pitch + if anim == Anim::Fall { 0.5 } else { 0.0 };

        self.step_squash(dt);
    }

    /// The posed pet, feet at `at`, turned `yaw` about +y, as world-space vertex-coloured triangles.
    pub fn mesh(&self, at: Vec3, yaw: f32, out: &mut Vec<FurnitureVertex>) {
        let Some(d) = data() else { return };
        let mut world: Vec<Mat4> = Vec::with_capacity(self.pose.len());
        for (i, (n, p)) in self.def.nodes.iter().zip(&self.pose).enumerate() {
            let local = Mat4::from_scale_rotation_translation(p.scale, Quat::from_euler(EulerRot::XYZ, p.rot.x, p.rot.y, p.rot.z), p.pos);
            let parent = if n.parent < 0 {
                // the root: the caller's position and yaw
                Mat4::from_rotation_translation(Quat::from_rotation_y(yaw), at)
            } else {
                world[n.parent as usize]
            };
            world.push(if i == 0 && n.parent < 0 { parent } else { parent * local });
            let (Some(g), Some(color)) = (n.geometry, n.color.as_deref()) else { continue };
            let Some(geo) = d.geometries.get(g) else { continue };
            let m = world[i];
            let nm = Mat3::from_mat4(m).inverse().transpose();
            let hex = u32::from_str_radix(color.trim_start_matches('#'), 16).unwrap_or(0xff00ff);
            let rgba = [(hex >> 16) as u8, (hex >> 8) as u8, hex as u8, 255];
            for k in 0..geo.index_count {
                let v = geo.vertex_start + d.indices[geo.index_start + k] as usize;
                let pos = m.transform_point3(Vec3::from_slice(&d.positions[v * 3..v * 3 + 3]));
                let nrm = (nm * Vec3::from_slice(&d.normals[v * 3..v * 3 + 3])).normalize_or_zero();
                out.push(FurnitureVertex { pos: pos.into(), nrm: nrm.into(), color: rgba });
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The companion (petCompanion.ts)
// ---------------------------------------------------------------------------------------------

/// Where a recalled pet lands, nearest-to-behind first (never in the owner's face).
const RECALL_SPOTS: [(f64, f64); 8] = [(1.2, 1.2), (-1.2, 1.2), (1.2, -1.2), (-1.2, -1.2), (1.2, 0.0), (-1.2, 0.0), (0.0, 1.2), (0.0, -1.2)];
const TICK: f64 = 1.0 / 60.0;

pub struct Companion {
    pub body: Body,
    pub brain: Brain,
    pub rig: Rig,
    prev: Vec3,
    acc: f64,
    was_grounded: bool,
    /// The drawn turn, eased toward the brain's bearing.
    pub draw_yaw: f32,
}

impl Companion {
    pub fn new<W: BodyWorld + ?Sized>(world: &W, spawn: (f64, f64, f64), species: &str, seed: u32) -> Option<Companion> {
        let rig = Rig::new(species, seed)?;
        let def = rig.def();
        let mut body = Body::at(spawn.0, spawn.1, spawn.2);
        body.w = Some(def.body_width);
        body.h = Some(def.body_height);
        body.jump_speed = Some(def.jump_speed);
        unstick(world, &mut body);
        let prev = Vec3::new(body.x as f32, body.y as f32, body.z as f32);
        Some(Companion { body, brain: Brain { last_x: spawn.0, last_z: spawn.2, ..Brain::default() }, rig, prev, acc: 0.0, was_grounded: true, draw_yaw: 0.0 })
    }

    /// Adopt another animal: the brain, place and mode carry over, only the collider and the model
    /// change (a taller animal is lifted clear of a ceiling).
    pub fn adopt<W: BodyWorld + ?Sized>(&mut self, world: &W, species: &str) {
        if species_or_dog(species) == self.rig.species {
            return;
        }
        let Some(rig) = Rig::new(species, self.rig.seed.wrapping_add(7)) else { return };
        self.rig = rig;
        let def = self.rig.def();
        self.body.w = Some(def.body_width);
        self.body.h = Some(def.body_height);
        self.body.jump_speed = Some(def.jump_speed);
        unstick(world, &mut self.body);
        self.rig.pop(3.0);
    }

    /// A one-block step right ahead on the way to the owner, with the animal's headroom clear.
    fn sense_ahead<W: BodyWorld + ?Sized>(&self, world: &W, owner: (f64, f64, f64)) -> bool {
        let b = &self.body;
        if !b.grounded {
            return false;
        }
        let (dx, dz) = (owner.0 - b.x, owner.2 - b.z);
        let len = dx.hypot(dz);
        if len < 0.4 {
            return false;
        }
        let reach = b.w.unwrap_or(0.5) / 2.0 + 0.25;
        let (px, pz) = ((b.x + dx / len * reach).floor() as i32, (b.z + dz / len * reach).floor() as i32);
        let foot = (b.y + 0.1).floor() as i32;
        let headroom = b.h.unwrap_or(1.0).ceil() as i32;
        if (1..=headroom).any(|i| world.is_blocked(px, foot + i, pz)) {
            return false;
        }
        world.is_blocked(px, foot, pz)
    }

    /// One fixed tick (petCompanion.ts `fixedUpdate`).
    fn tick<W: BodyWorld + ?Sized>(&mut self, world: &W, owner: (f64, f64, f64)) {
        self.prev = Vec3::new(self.body.x as f32, self.body.y as f32, self.body.z as f32);
        let step = self.sense_ahead(world, owner);
        let cmd = self.brain.think((self.body.x, self.body.y, self.body.z), self.body.grounded, owner, TICK, step);
        if cmd.teleport {
            self.recall(world, owner);
            return;
        }
        let pace = self.rig.def().pace;
        step_body(world, &mut self.body, TICK, cmd.wish_x * pace, cmd.wish_z * pace, cmd.jump, 0.0, 0.0);
        if cmd.jump {
            self.rig.pop(1.5);
        } else if self.body.grounded && !self.was_grounded {
            self.rig.pop(2.4);
        }
        self.was_grounded = self.body.grounded;
        if self.body.y < -12.0 {
            self.recall(world, owner);
        }
    }

    /// Put the pet beside its owner at once, at the owner's level (never on the roof above).
    pub fn recall<W: BodyWorld + ?Sized>(&mut self, world: &W, owner: (f64, f64, f64)) {
        let b = &mut self.body;
        let h = b.h.unwrap_or(BODY_HEIGHT);
        let mut placed = false;
        for (dx, dz) in RECALL_SPOTS {
            b.x = owner.0 + dx;
            b.z = owner.2 + dz;
            b.y = owner.1;
            if can_occupy(world, b, h) {
                placed = true;
                break;
            }
        }
        if !placed {
            (b.x, b.y, b.z) = owner;
        }
        (b.vx, b.vy, b.vz) = (0.0, 0.0, 0.0);
        b.grounded = false;
        unstick(world, b);
        // a recall is a cut, and a fresh start for the brain
        self.prev = Vec3::new(b.x as f32, b.y as f32, b.z as f32);
        self.brain.blocked = 0.0;
        self.brain.no_gain = 0.0;
        self.brain.best_dist = f64::INFINITY;
        self.brain.last_x = b.x;
        self.brain.last_z = b.z;
    }

    /// The field window scrolled: move with it.
    pub fn shift(&mut self, dx: f64, dz: f64) {
        self.body.x -= dx;
        self.body.z -= dz;
        self.prev -= Vec3::new(dx as f32, 0.0, dz as f32);
        self.brain.last_x -= dx;
        self.brain.last_z -= dz;
    }

    /// A frame: as many fixed ticks as the time allows, then the drawn pose (between the last two
    /// ticks, the turn eased), into `out`.
    pub fn frame<W: BodyWorld + ?Sized>(&mut self, world: &W, owner: (f64, f64, f64), dt: f64, out: &mut Vec<FurnitureVertex>) {
        let dt = if dt.is_finite() { dt.clamp(0.0, 0.25) } else { 0.0 };
        // a block written into the pet (ours, a classmate's, a reset): lifted clear, as craftGame.ts does
        if !can_occupy(world, &self.body, self.body.h.unwrap_or(BODY_HEIGHT)) {
            unstick(world, &mut self.body);
            self.prev = Vec3::new(self.body.x as f32, self.body.y as f32, self.body.z as f32);
        }
        self.acc += dt;
        while self.acc >= TICK {
            self.acc -= TICK;
            self.tick(world, owner);
        }
        let alpha = (self.acc / TICK) as f32;
        let at = self.prev.lerp(Vec3::new(self.body.x as f32, self.body.y as f32, self.body.z as f32), alpha);
        let mut delta = self.brain.yaw as f32 - self.draw_yaw;
        while delta > std::f32::consts::PI {
            delta -= std::f32::consts::TAU;
        }
        while delta < -std::f32::consts::PI {
            delta += std::f32::consts::TAU;
        }
        self.draw_yaw += delta * (dt as f32 * 9.0).min(1.0);
        let speed = self.body.vx.hypot(self.body.vz) as f32;
        self.rig.update(self.brain.anim, speed, dt as f32);
        self.rig.mesh(at, self.draw_yaw, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f64 = 1.0 / 60.0;

    fn think(b: &mut Brain, pos: (f64, f64, f64), owner: (f64, f64, f64)) -> Command {
        b.think(pos, true, owner, DT, false)
    }

    #[test]
    fn holds_still_at_heel_and_faces_the_owner() {
        let mut b = Brain::default();
        let c = think(&mut b, (0.0, 0.0, 0.0), (1.0, 0.0, 0.0));
        assert_eq!((c.wish_x, c.wish_z, c.anim), (0.0, 0.0, Anim::Idle));
        assert!((c.yaw - std::f64::consts::FRAC_PI_2).abs() < 1e-9, "faces +x");
    }

    #[test]
    fn walks_then_runs_with_hysteresis() {
        let mut b = Brain::default();
        let c = think(&mut b, (0.0, 0.0, 0.0), (0.0, 0.0, 3.0));
        assert_eq!(c.anim, Anim::Walk);
        assert!((c.wish_z - WALK_GAIN).abs() < 1e-9);
        // inside CHASE_IN but past CHASE_OUT: still chasing
        b.last_z = 1.0; // it moved
        assert_eq!(think(&mut b, (0.0, 0.0, 1.0), (0.0, 0.0, 3.0)).anim, Anim::Walk);
        assert_eq!(think(&mut b, (0.0, 0.0, 1.9), (0.0, 0.0, 3.0)).anim, Anim::Idle, "inside CHASE_OUT: stop");
        let mut b = Brain::default();
        let c = think(&mut b, (0.0, 0.0, 0.0), (0.0, 0.0, 7.0));
        assert_eq!(c.anim, Anim::Run);
        assert!((c.wish_z - RUN_GAIN).abs() < 1e-9);
        assert_eq!(think(&mut b, (0.0, 0.0, 2.0), (0.0, 0.0, 7.0)).anim, Anim::Run, "between SPRINT_OUT and SPRINT_IN: still running");
    }

    #[test]
    fn hops_when_stuck_with_a_cooldown_never_in_the_air() {
        let mut b = Brain::default();
        let mut hopped = None;
        for i in 0..40 {
            if think(&mut b, (0.0, 0.0, 0.0), (0.0, 0.0, 5.0)).jump {
                hopped = Some(i);
                break;
            }
        }
        let first = hopped.expect("hops once blocked long enough");
        assert!(first as f64 * DT >= 0.2);
        assert!(!think(&mut b, (0.0, 0.0, 0.0), (0.0, 0.0, 5.0)).jump, "cooldown");
        let mut b = Brain::default();
        for _ in 0..60 {
            assert!(!b.think((0.0, 0.0, 0.0), false, (0.0, 0.0, 5.0), DT, true).jump);
        }
        // a step ahead: hop at once
        let mut b = Brain::default();
        assert!(b.think((0.0, 0.0, 0.0), true, (0.0, 0.0, 5.0), DT, true).jump);
        // the owner a step up close by: hop at once
        let mut b = Brain::default();
        assert!(think(&mut b, (0.0, 0.0, 0.0), (0.0, 1.0, 3.0)).jump);
    }

    #[test]
    fn teleports_only_when_truly_lost() {
        let mut b = Brain::default();
        assert!(!think(&mut b, (0.0, 0.0, 0.0), (0.0, 0.0, 20.0)).teleport);
        assert!(think(&mut b, (0.0, 0.0, 0.0), (0.0, 0.0, 30.0)).teleport);
        let mut b = Brain::default();
        assert!(think(&mut b, (0.0, 0.0, 0.0), (0.0, 15.0, 3.0)).teleport, "owner far overhead");
    }

    #[test]
    fn stay_means_stay() {
        let mut b = Brain::default();
        assert_eq!(b.toggle(), Mode::Stay);
        let c = think(&mut b, (0.0, 0.0, 0.0), (0.0, 0.0, 25.0));
        assert_eq!((c.wish_x, c.wish_z, c.jump, c.teleport, c.anim), (0.0, 0.0, false, false, Anim::Sit));
        assert_eq!(b.toggle(), Mode::Follow);
    }

    #[test]
    fn slides_sideways_then_flips_then_gives_up() {
        let mut b = Brain::default();
        let mut sides = Vec::new();
        let mut gave_up = false;
        for _ in 0..(8.0 / DT) as usize {
            let c = think(&mut b, (0.0, 0.0, 0.0), (0.0, 0.0, 5.0));
            if c.teleport {
                gave_up = true;
                break;
            }
            if b.blocked >= SIDESTEP_AFTER {
                assert!(c.wish_x.abs() > c.wish_z.abs(), "mostly sideways");
                sides.push(c.wish_x.signum());
            }
        }
        assert!(sides.contains(&1.0) == sides.contains(&-1.0) || sides.len() < 120, "tries both sides");
        assert!(sides.windows(2).any(|w| w[0] != w[1]), "flips sides");
        assert!(gave_up, "asks for a recall after LOST_TIME");
    }

    #[test]
    fn the_owner_walking_away_is_not_a_failure() {
        let mut b = Brain::default();
        let mut z = 0.0;
        // the pet keeps pace but the owner pulls ahead: never a recall within 10 s
        for i in 0..600 {
            z += 0.03;
            let owner = 5.0 + i as f64 * 0.12;
            assert!(!think(&mut b, (0.0, 0.0, z), (0.0, 0.0, owner)).teleport || owner - z > TELEPORT_DIST);
        }
    }

    #[test]
    fn every_species_loads_with_the_web_numbers_and_a_hop_over_a_block() {
        let d = data().expect("pets.json + pets.bin parse");
        assert_eq!(d.order, ["dog", "cat", "elephant", "giraffe", "panda"]);
        for key in &d.order {
            let s = &d.species[key];
            assert!(s.jump_speed * s.jump_speed / (2.0 * 24.0) > 1.0, "{key} clears a full block");
            let mut rig = Rig::new(key, 1).unwrap();
            for anim in [Anim::Idle, Anim::Walk, Anim::Run, Anim::Jump, Anim::Fall, Anim::Sit] {
                for _ in 0..30 {
                    rig.update(anim, 3.0, 1.0 / 60.0);
                }
            }
            let mut out = Vec::new();
            rig.mesh(Vec3::ZERO, 0.0, &mut out);
            assert!(out.len() > 1000 && out.len() % 3 == 0, "{key}: {}", out.len());
            assert!(out.iter().all(|v| v.pos.iter().chain(&v.nrm).all(|x| x.is_finite())));
        }
        assert_eq!(species_or_dog("dragon"), "dog");
        assert_eq!((object_particle("시바견"), object_particle("판다"), object_particle("아기 기린")), ("을", "를", "을"));
    }

    #[test]
    fn a_standing_pet_has_its_paws_on_the_ground() {
        // creatureRig's contract: feet at the origin, so the lowest point of an idle pet is ~0
        for key in &data().unwrap().order {
            let mut rig = Rig::new(key, 3).unwrap();
            rig.update(Anim::Idle, 0.0, 1.0 / 60.0);
            let mut out = Vec::new();
            rig.mesh(Vec3::ZERO, 0.0, &mut out);
            let low = out.iter().map(|v| v.pos[1]).fold(f32::MAX, f32::min);
            assert!(low.abs() < 0.03, "{key}: lowest point {low}");
        }
    }

    #[test]
    fn a_block_written_into_the_pet_lifts_it_clear() {
        let mut w = craftyap_core::world::generate_field();
        let y = craftyap_core::world::FIELD_TOP as f64;
        let mut c = Companion::new(&w, (40.5, y, 40.5), "dog", 5).unwrap();
        let feet = c.body.y.floor() as i32;
        w.set(40, feet, 40, 1);
        let mut out = Vec::new();
        c.frame(&w, (41.5, y, 40.5), 1.0 / 60.0, &mut out);
        assert!(can_occupy(&w, &c.body, c.body.h.unwrap()), "not left embedded");
    }

    #[test]
    fn the_companion_follows_its_owner_across_flat_ground() {
        let w = craftyap_core::world::generate_field();
        let y = craftyap_core::world::FIELD_TOP as f64;
        let mut c = Companion::new(&w, (40.0, y, 40.0), "dog", 9).unwrap();
        let mut out = Vec::new();
        for _ in 0..360 {
            out.clear();
            c.frame(&w, (52.0, y, 40.0), 1.0 / 60.0, &mut out);
        }
        let d = (c.body.x - 52.0).hypot(c.body.z - 40.0);
        assert!(d < CHASE_IN, "caught up to heel: {d}");
        assert!(!out.is_empty());
    }
}
