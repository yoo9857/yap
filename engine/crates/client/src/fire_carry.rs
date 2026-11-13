#![allow(clippy::too_many_arguments)]
//! The handheld pose and the two arms shown when the follow camera reaches eye level.
use crate::{character::Trs, furniture::FurnitureVertex as Vertex};
use glam::{Mat3, Mat4, Quat, Vec3};

#[derive(Clone, Copy)]
pub(crate) struct Socket {
    pub bone: usize,
    pub cap: Vec3,
    pub palm: Vec3,
}

#[derive(Clone, Copy)]
pub(crate) struct Pose {
    pub strength: f32,
    pub aiming: f32,
    pub pitch: f32,
    pub sway: f32,
}

pub(crate) struct Frame {
    pub camera: Vec3,
    pub view: Vec3,
    pub feet: Vec3,
    pub facing: f32,
    pub view_yaw: f32,
    pub pitch: f32,
    pub dt: f32,
    pub first: bool,
    pub rabbit: bool,
    pub sway: f32,
    pub eye_height: f32,
    pub view_scale: f32,
}

impl Pose {
    pub fn apply(self, arm: &mut Trs, parent: Mat4, socket: Socket, right: bool) {
        let cap_parent = arm.t + arm.r * (arm.s * socket.cap);
        let palm_parent = arm.t + arm.r * (arm.s * socket.palm);
        let mut target = parent.transform_point3(cap_parent);
        if right {
            target.x = -0.61;
            target.y += -0.16 + 0.10 * self.aiming + self.sway;
            target.z += 0.29 + 0.05 * self.aiming;
        } else {
            target.x = 0.55 - 0.07 * self.aiming;
            target.y += -0.08 + 0.16 * self.aiming + self.pitch.clamp(-0.8, 0.8) * 0.15 + self.sway;
            target.z += 0.34 + 0.07 * self.aiming;
        }
        let wanted = (parent.inverse().transform_point3(target) - cap_parent).normalize_or_zero();
        let current = (palm_parent - cap_parent).normalize_or_zero();
        let turn = Quat::from_rotation_arc(current, wanted);
        arm.r = (Quat::IDENTITY.slerp(turn, self.strength) * arm.r).normalize();
        arm.t = cap_parent - arm.r * (arm.s * socket.cap);
    }
}

/// Indexed source vertices are exported once from the same Blender mesh as the web.
struct HandVertex { poses:[(Vec3,Vec3);3], reach:f32, bend:f32 }
fn hand_surface(right:bool) -> &'static [HandVertex] {
    static MODEL: std::sync::OnceLock<[Vec<HandVertex>;2]> = std::sync::OnceLock::new();
    let surfaces=MODEL.get_or_init(|| {
        let make=|right:bool| {
            let raw:[&[u8];3]=if right {
                [include_bytes!("../../../assets/character-grip/model-right-open.bin"),include_bytes!("../../../assets/character-grip/model-right-half.bin"),include_bytes!("../../../assets/character-grip/model-right.bin")]
            }else{
                [include_bytes!("../../../assets/character-grip/model-open.bin"),include_bytes!("../../../assets/character-grip/model-half.bin"),include_bytes!("../../../assets/character-grip/model.bin")]
            };
            (0..raw[0].len()/24).map(|vertex| {
                    let poses=raw.map(|bytes| {
                        let b=&bytes[vertex*24..vertex*24+24];
                        let f=|i| f32::from_le_bytes(b[i..i+4].try_into().expect("hand float"));
                        (Vec3::new(f(0),f(4),f(8)),Vec3::new(f(12),f(16),f(20)))
                    });
                    let distance=(-poses[0].0.x-0.015).max(0.);
                    let bend=1.-(-distance/0.018).exp();
                    HandVertex { poses,reach:distance-0.018*bend,bend }
                }).collect()
        };
        [make(false),make(true)]
    });
    &surfaces[usize::from(right)]
}

pub(crate) fn view_arm(
    out: &mut Vec<Vertex>,
    hand: Vec3,
    axis: Vec3,
    camera_right: Vec3,
    camera_up: Vec3,
    view: Vec3,
    right: bool,
    rabbit: bool,
    grasp: f32,
) {
    let side=if right {1.}else{-1.};
    let wrist=if right {
        camera_right*0.40-camera_up*0.72-view*0.58
    }else{
        camera_right*(side*0.25)-camera_up*0.91-view*0.39
    }.normalize_or_zero();
    let open=-wrist;
    let opening=(open-axis*open.dot(axis))
        .normalize_or((camera_right-axis*camera_right.dot(axis)).normalize_or_zero());
    let across=axis.cross(opening).normalize_or_zero();
    let basis=Mat3::from_cols(opening,across,axis);
    let delta=basis.transpose()*wrist+Vec3::X;
    let color=if rabbit {[185,164,235,255]}else{[255,209,47,255]};
    let amount=grasp.clamp(0.,1.)*2.;
    let segment=(amount.floor()as usize).min(1);let mix=amount-segment as f32;
    out.extend(hand_surface(right).iter().map(|v| {
        let p=v.poses[segment].0.lerp(v.poses[segment+1].0,mix);
        let n=v.poses[segment].1.lerp(v.poses[segment+1].1,mix);
        let normal=Vec3::new(
            (n.x+v.bend*(delta.y*n.y+delta.z*n.z))/(1.-v.bend*delta.x),n.y,n.z
        ).normalize_or_zero();
        Vertex {
            pos:(hand+basis*(p+delta*v.reach)).to_array(),
            nrm:(basis*normal).to_array(),
            color,
        }
    }));
}
