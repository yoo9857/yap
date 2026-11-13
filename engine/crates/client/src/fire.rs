//! Native fire training: the same Blender campus, precise collisions and lesson data as the web.
// Dense one-line layout on purpose (`…}if …`, `x=!y`): these are not a lost `else` or a mistyped `!=`.
#![allow(clippy::possible_missing_else, clippy::suspicious_assignment_formatting)]
use crate::class::DrillState;
use crate::furniture::FurnitureVertex as Vertex;
use crate::menu::Ui;
use crate::ui::{Align,ButtonStyle,Rect};
use craftyap_core::static_scene::{Bounds,Ramp,StaticScene};
use glam::DVec3;
use serde::Deserialize;
use std::sync::{Arc,OnceLock};

#[derive(Deserialize,Clone)] pub struct Station {pub kind:String,pub cell:[f64;3],pub rot:u8,pub r#box:[f64;6]}
#[derive(Deserialize,Clone)] pub struct Fire {pub at:[f64;3],pub size:f64,pub small:bool}
#[derive(Deserialize,Clone)] pub struct Assembly {pub x:f64,pub y:f64,pub z:f64,pub r:f64}
#[derive(Deserialize,Clone)] #[serde(rename_all="camelCase")]
pub struct Scenario {
 pub signs:Vec<Sign>,pub classroom_door:[f64;3],pub edits:Vec<(i32,u8,i32,u8,u8)>,pub spawns:Vec<[f64;3]>,pub spawn_yaw:f64,pub stations:Vec<Station>,pub fires:Vec<Fire>,
 pub heat:[f64;6],pub classroom:[f64;6],pub corridor:[f64;6],pub smoke_floor:f64,pub thick_west:f64,
 pub exit_zone:[f64;6],pub retry:[f64;3],pub assembly:Assembly,pub escape_route:Vec<[f64;3]>,pub obstacles:Vec<RawBox>,
}
#[derive(Deserialize,Clone)] pub struct RawBox {pub min:[f64;3],pub max:[f64;3]}
#[derive(Deserialize)] struct RawRamp {min:[f64;3],max:[f64;3],h0:f64,h1:f64}
#[derive(Deserialize)] #[serde(rename_all="camelCase")] struct Geometry {boxes:Vec<RawBox>,camera_boxes:Vec<RawBox>,ramps:Vec<RawRamp>}
#[derive(Deserialize,Clone)] pub struct SignMount {pub kind:String,pub y:f64}
#[derive(Deserialize,Clone)] pub struct Sign {pub at:[f64;3],pub rot:u8,pub mount:SignMount}
pub fn scenario()->&'static Scenario {static DATA:OnceLock<Scenario>=OnceLock::new();DATA.get_or_init(||serde_json::from_str(include_str!("../../../assets/fire-school/scenario.json")).expect("validated fire scenario"))}
pub fn collision()->Arc<StaticScene>{
 static DATA:OnceLock<Arc<StaticScene>>=OnceLock::new();DATA.get_or_init(||{
  let raw:Geometry=serde_json::from_str(include_str!("../../../assets/fire-school/collision.json")).expect("validated fire collision");
  Arc::new(StaticScene::new(raw.boxes.iter().chain(scenario().obstacles.iter()).map(|b|Bounds{min:b.min,max:b.max}).collect(),raw.ramps.into_iter().map(|r|Ramp{bounds:Bounds{min:r.min,max:r.max},h0:r.h0,h1:r.h1}).collect()))
 }).clone()
}
pub fn camera_collision()->Arc<StaticScene>{
 static DATA:OnceLock<Arc<StaticScene>>=OnceLock::new();DATA.get_or_init(||{
  let raw:Geometry=serde_json::from_str(include_str!("../../../assets/fire-school/collision.json")).expect("camera geometry");
  Arc::new(StaticScene::new(raw.camera_boxes.iter().chain(raw.boxes.iter()).chain(scenario().obstacles.iter()).map(|b|Bounds{min:b.min,max:b.max}).collect(),raw.ramps.into_iter().map(|r|Ramp{bounds:Bounds{min:r.min,max:r.max},h0:r.h0,h1:r.h1}).collect()))
 }).clone()
}
#[allow(clippy::chunks_exact_to_as_chunks)] // 28 bytes a vertex: the file's own layout, read as it is written
fn decode(bytes:&[u8])->Vec<Vertex>{bytes.chunks_exact(28).map(|b|{let f=|k|f32::from_le_bytes(b[k..k+4].try_into().expect("vertex"));Vertex{pos:[f(0),f(4),f(8)],nrm:[f(12),f(16),f(20)],color:[b[24],b[25],b[26],b[27]]}}).collect()}
pub fn campus(origin:(i32,i32))->(Vec<Vertex>,Vec<Vertex>){
 static OPAQUE:OnceLock<Vec<Vertex>>=OnceLock::new();static GLASS:OnceLock<Vec<Vertex>>=OnceLock::new();
 let mut opaque=OPAQUE.get_or_init(||decode(include_bytes!("../../../assets/fire-school/school-opaque.bin"))).clone();
 let mut glass=GLASS.get_or_init(||decode(include_bytes!("../../../assets/fire-school/school-glass.bin"))).clone();
 for s in &scenario().stations{
  let c=[s.cell[0]+0.5,s.cell[1],s.cell[2]+0.5];let a=s.rot as f64*std::f64::consts::FRAC_PI_2;
  let (size,color,y,z)=match s.kind.as_str(){"alarm"=>([0.46,0.46,0.10],[220,42,35,255],0.5,-0.44),"phone"=>([0.36,0.52,0.10],[244,244,235,255],0.5,-0.44),"extinguisher"=>([0.28,0.64,0.28],[219,45,35,255],0.38,-0.3),"towel"=>([0.34,0.07,0.24],[127,208,242,255],-0.06,-0.08),_=>([0.92,0.36,0.08],[28,156,76,255],0.5,-0.44)};
  let point=|y:f64,z:f64|[c[0]+z*a.sin(),c[1]+y,c[2]+z*a.cos()];let turn=s.rot%2==1;
  if s.kind!="extinguisher"{cube(&mut opaque,point(y,z),if turn{[size[2],size[1],size[0]]}else{size},color);}else{cube(&mut opaque,point(0.03,-0.3),[0.44,0.06,0.36],[38,56,66,255]);}
  if s.kind=="alarm"||s.kind=="phone"{cube(&mut opaque,point(0.5,-0.36),[0.13,0.3,0.07],[35,48,57,255]);}
  if s.kind=="extinguisher"||s.kind=="towel"{
   let(py,ph,ly)=if s.kind=="extinguisher"{(0.70,1.30,1.45)}else{(0.56,1.34,1.25)};
   cube(&mut opaque,point(py,-0.485),[0.045,ph,0.045],[154,160,168,255]);cube(&mut opaque,point(ly,-0.485),[0.52,0.20,0.025],if s.kind=="towel"{[47,134,216,255]}else{[220,42,35,255]});
  }
 }
 cube(&mut opaque,[-20.2,8.68,-4.3],[0.52,0.56,0.52],[76,94,101,255]);
 cube(&mut opaque,[5.5,8.8,-2.7],[1.4,0.8,0.8],[16,153,145,255]);cube(&mut opaque,[5.5,9.28,-2.7],[1.5,0.13,0.95],[255,249,236,255]);cube(&mut opaque,[5.5,9.36,-2.7],[1.0,0.035,0.6],[69,185,226,255]);
 // Green exit signs mark the actual stair turns and the ground-floor main entrance.
 for s in &scenario().signs{
  let at=s.at;let turn=s.rot%2==1;let size=if turn{[0.08,0.36,0.92]}else{[0.92,0.36,0.08]};cube(&mut opaque,at,size,[28,156,76,255]);
  for side in [-1.,1.]{let mut face=at;face[if turn{0}else{2}]+=side*0.045;cube(&mut opaque,face,if turn{[0.01,0.09,0.65]}else{[0.65,0.09,0.01]},[255,255,245,255]);}
  let edge=at[1]+if s.mount.kind=="ceiling"{0.18}else{-0.18};let h=(s.mount.y-edge).abs();
  for d in [-0.32,0.32]{let mut p=at;p[if turn{2}else{0}]+=d;p[1]=(s.mount.y+edge)/2.;cube(&mut opaque,p,[0.045,h,0.045],[154,160,168,255]);}
  if s.mount.kind=="ceiling"{cube(&mut opaque,[at[0],s.mount.y-0.0175,at[2]],if turn{[0.16,0.035,0.82]}else{[0.82,0.035,0.16]},[154,160,168,255]);}
 }
 let a=&scenario().assembly;cube(&mut opaque,[a.x,a.y+1.6,a.z],[0.09,3.2,0.09],[245,245,235,255]);cube(&mut opaque,[a.x+0.6,a.y+2.8,a.z],[1.15,0.7,0.08],[28,156,76,255]);
 for v in opaque.iter_mut().chain(glass.iter_mut()){v.pos[0]-=origin.0 as f32;v.pos[2]-=origin.1 as f32;}
 (opaque,glass)
}
fn cube(out:&mut Vec<Vertex>,c:[f64;3],s:[f64;3],color:[u8;4]){
 let v=[[-1.,-1.,-1.],[-1.,-1.,1.],[-1.,1.,-1.],[-1.,1.,1.],[1.,-1.,-1.],[1.,-1.,1.],[1.,1.,-1.],[1.,1.,1.]];
 let faces=[([0,1,3,2],[-1.,0.,0.]),([4,6,7,5],[1.,0.,0.]),([0,4,5,1],[0.,-1.,0.]),([2,3,7,6],[0.,1.,0.]),([0,2,6,4],[0.,0.,-1.]),([1,5,7,3],[0.,0.,1.])];
 for (f,n) in faces{for j in [0,1,2,0,2,3]{let p=v[f[j]];out.push(Vertex{pos:[(c[0]+p[0]*s[0]/2.)as f32,(c[1]+p[1]*s[1]/2.)as f32,(c[2]+p[2]*s[2]/2.)as f32],nrm:n,color});}}
}
pub fn inside(b:&[f64;6],p:[f64;3])->bool{(0..3).all(|k|p[k]>=b[k]&&p[k]<b[k+3])}
pub const STEPS:[&str;9]=["경보 울리기","119 신고","소화기 배우기","작은 불 진압","젖은 수건","계단으로 대피","운동장 집결","훈련 완료","훈련 완료"];
#[derive(Clone,Copy,Debug,PartialEq)]pub enum Panel{None,Call,Pass,Result,Board}
#[derive(Clone,Debug)]pub struct Drill{pub step:usize,pub time:f64,pub alarm:bool,pub extinguisher:bool,pub trained:bool,pub charge:f64,pub fire:f64,pub towel:bool,pub air:f64,pub mistakes:u32,pub smoke_time:f64,pub smoke_in:f64}
impl Default for Drill{fn default()->Self{Self{step:0,time:0.,alarm:false,extinguisher:false,trained:false,charge:0.,fire:1.,towel:false,air:1.,mistakes:0,smoke_time:0.,smoke_in:0.}}}
impl Drill{pub fn stars(&self)->u32{if self.mistakes==0&&self.smoke_time<6.{3}else if self.mistakes<=1&&self.smoke_time<15.{2}else{1}}}
pub struct Training{
 pub drill:Drill,pub panel:Panel,pub waiting:bool,pub teacher:bool,pub solo:bool,pub aimed:Option<usize>,
 pub use_requested:bool,pub low_requested:bool,pub exit_requested:bool,pub teleport:Option<[f64;3]>,pub reset_requested:bool,
 pub command:Option<(&'static str,Option<u32>,Option<u32>)>,pub report:Option<(u32,Option<u32>,Option<u32>)>,
 class:Option<DrillState>,run:Option<u32>,dial:String,call_connected:bool,call_correct:bool,pass:u8,hold:f64,sweeps:u8,last_side:i8,
 pub hint:String,pub spraying:bool,pub player:[f64;3],clock:f64,
 powder:crate::fire_powder::Powder,lesson_powder:crate::fire_powder::Powder,
 carry_blend:f32,aim_blend:f32,carry_sway:f32,tuck:f32,
 pub hands:[Option<glam::Vec3>;2],pub nozzle:Option<(DVec3,DVec3,f64)>,gauge_checked:bool,lesson_pin:f32,lesson_squeeze:bool,lesson_ready:bool,lesson_aim:f32,lesson_sweep:f32,lesson_drag:Option<(f32,f32,f32,bool)>,lesson_help:bool,
}
impl Training{
 pub fn new(solo:bool)->Self{Self{drill:Drill::default(),panel:Panel::None,waiting:!solo,teacher:false,solo,aimed:None,use_requested:false,low_requested:false,exit_requested:false,teleport:None,reset_requested:false,command:None,report:None,class:None,run:None,dial:String::new(),call_connected:false,call_correct:false,pass:0,hold:0.,sweeps:0,last_side:0,hint:String::new(),spraying:false,player:[0.,8.4,0.],clock:0.,powder:Default::default(),lesson_powder:Default::default(),carry_blend:0.,aim_blend:0.,carry_sway:0.,tuck:0.,hands:[None,None],nozzle:None,gauge_checked:false,lesson_pin:0.,lesson_squeeze:false,lesson_ready:false,lesson_aim:0.,lesson_sweep:0.5,lesson_drag:None,lesson_help:false}}
 pub fn panel_open(&self)->bool{self.panel!=Panel::None}
 pub fn restart(&mut self){self.drill=Drill::default();self.powder=Default::default();self.carry_blend=0.;self.aim_blend=0.;self.panel=Panel::None;self.reset_requested=true;self.hint.clear();self.report=Some((0,None,None));}
 pub fn apply_class(&mut self,state:Option<&DrillState>,teacher:bool,name:&str){
  self.teacher=teacher;
  let Some(c)=state else{self.waiting=!self.solo;return};
  if self.run!=Some(c.run){let board=self.panel==Panel::Board;self.run=Some(c.run);self.restart();if board{self.panel=Panel::Board;}}
  let team=c.teams.iter().find(|(n,_)|n.trim().to_lowercase()==name.trim().to_lowercase()).map_or(0,|(_,t)|*t);
  self.waiting=if teacher{c.go.is_empty()}else{!(c.go.contains(&0)||c.go.contains(&team))};self.class=Some(c.clone());
 }
 pub fn use_station(&mut self){
  let Some(i)=self.aimed else{return};if self.waiting{self.hint="선생님의 출발 안내를 기다려요".into();return;}
  let s=&scenario().stations[i];let d=&mut self.drill;let before=d.step;
  match s.kind.as_str(){
   "alarm" if d.step==0=>{d.alarm=true;d.step=1;},
   "phone" if d.step==1=>{self.panel=Panel::Call;self.dial.clear();self.call_connected=false;self.call_correct=false;},
   "extinguisher" if d.step==2||d.step==3&&!d.extinguisher=>{if d.trained{d.extinguisher=true;d.charge=1.;d.step=3;}else{self.panel=Panel::Pass;self.pass=0;self.hold=0.;self.sweeps=0;self.last_side=0;self.gauge_checked=false;self.lesson_pin=0.;self.lesson_aim=0.;self.lesson_ready=false;self.lesson_powder=Default::default();self.lesson_drag=None;self.lesson_help=false;}},
   "towel"=>{d.towel=true;if d.step==4{d.step=5;}},
   "sign"=>{self.hint="초록 유도등을 따라 계단으로 내려가 정문으로 나가요".into();},
   _=>{self.hint="안내된 순서대로 진행해요".into();}
  }
  if d.step!=before{self.report=Some((d.step as u32,None,None));}
 }
 pub fn tick(&mut self,dt:f64,pos:[f64;3],eye_y:f64,dir:DVec3,block_dist:f64,spray:bool){
  self.clock+=dt;self.player=pos;self.spraying=false;
  let eye=DVec3::new(pos[0],eye_y,pos[2]);let mut reach=4.5f64.min(block_dist+0.12);self.aimed=None;
  for (i,s)in scenario().stations.iter().enumerate(){if let Some(h)=ray_box(eye,dir,&s.r#box,reach){reach=h;self.aimed=Some(i);}}
  if self.use_requested{self.use_requested=false;self.use_station();}
  if self.waiting||self.panel_open(){return;}
  let muzzle=self.nozzle;
  let d=&mut self.drill;let before=d.step;if d.step>=7{return;}d.time+=dt;
  if d.extinguisher&&spray{
   self.spraying=true;d.charge=(d.charge-dt/14.).max(0.);
   let f=scenario().fires.iter().find(|f|f.small).expect("small fire");
   let (from,direction,limit)=muzzle.unwrap_or((eye,dir,block_dist));
   let miss=|p:DVec3|{let v=p-from;let along=v.dot(direction);(along,(v-direction*along).length())};
   let (along,off)=miss(DVec3::from(f.at));let (high,high_off)=miss(DVec3::from(f.at)+DVec3::Y*0.9*f.size);
   if along>0.&&along<=5.&&off<=0.75&&along<=limit+0.20{d.fire-=dt/3.2;}
   else if high>0.&&high<=5.&&high_off<=0.8&&high<=limit+0.20{d.fire-=dt/3.2*0.25;self.hint="불꽃보다 불의 아래쪽을 겨냥해요".into();}
   if d.fire<=0.{d.fire=0.;d.extinguisher=false;d.smoke_in=4.;d.step=if d.towel{5}else{4};}
   if d.extinguisher&&d.charge<=0.{d.extinguisher=false;self.hint="소화기를 다시 가져와요".into();}
  }
  d.smoke_in=(d.smoke_in-dt).max(0.);let mut drain=0.;let p=[pos[0],pos[1]+0.1,pos[2]];
  if inside(&scenario().heat,p){drain=0.5;}
  else if d.step>=4&&d.step<7&&d.smoke_in<=0.&&inside(&scenario().corridor,p){
   drain=if pos[0]<scenario().thick_west{0.45}else if eye_y>=scenario().smoke_floor{if d.towel{0.07}else{0.14}}else if d.towel{0.}else{0.03};
  }
  if drain>0.{d.air-=drain*dt;d.smoke_time+=dt;if d.air<=0.{d.air=1.;d.mistakes+=1;self.teleport=Some(scenario().retry);self.hint="숨을 고르고, 수건으로 막고 낮게 이동해요".into();}}else{d.air=(d.air+0.2*dt).min(1.);}
  let out=inside(&scenario().exit_zone,pos)||(pos[2]>=scenario().exit_zone[5]&&pos[1]<scenario().exit_zone[4]&&pos[0].abs()<5.);
  if out&&d.step==5{d.step=6;}
  if d.step==6&&(pos[0]-scenario().assembly.x).hypot(pos[2]-scenario().assembly.z)<=scenario().assembly.r{d.step=7;self.panel=Panel::Result;}
  if d.step!=before{self.report=Some((d.step as u32,(d.step==7).then(||d.stars()),(d.step==7).then_some(d.time.round()as u32)));}
 }
 pub fn target(&self)->Option<[f64;3]>{
  if self.waiting||self.drill.step>=7{return None;}
  let kind=match self.drill.step{0=>"alarm",1=>"phone",2=>"extinguisher",3 if !self.drill.extinguisher=>"extinguisher",4=>"towel",_=>""};
  if self.drill.step==0&&self.player[1]>7.6&&self.player[0]>=scenario().classroom[0]&&self.player[0]<scenario().classroom[3]&&self.player[2]<scenario().classroom[5]{let mut p=scenario().classroom_door;p[1]+=1.7;return Some(p);}
  if !kind.is_empty(){return scenario().stations.iter().find(|s|s.kind==kind).map(|s|[(s.r#box[0]+s.r#box[3])/2.,s.r#box[4]+0.5,(s.r#box[2]+s.r#box[5])/2.]);}
  if self.drill.step==3{return scenario().fires.iter().find(|f|f.small).map(|f|[f.at[0],f.at[1]+1.3,f.at[2]]);}
  if self.drill.step==6{return Some([scenario().assembly.x,scenario().assembly.y+2.,scenario().assembly.z]);}
  let [x,y,z]=self.player;let r=&scenario().escape_route;
  let mut at=if y>7.6{if z>-11.05{r[0]}else{r[1]}}else if y>5.9{if z< -15.1&&x> -1.5{r[2]}else if x> -1.{r[1]}else{r[3]}}else if y>4.35{r[3]}else{r[4]};at[1]+=1.7;Some(at)
 }
 pub fn carry_pose(&mut self,dt:f32,speed:f32,pitch:f32)->crate::fire_carry::Pose{
  let carrying=self.drill.extinguisher&&!self.waiting;
  let weight=if carrying{1.}else{0.};
  self.carry_blend+=(weight-self.carry_blend)*(1.-(-13.*dt).exp());
  let aiming=if carrying&&self.spraying{1.}else{0.};
  self.aim_blend+=(aiming-self.aim_blend)*(1.-(-16.*dt).exp());
  let gait=(speed/4.6).min(1.);
  self.carry_sway+=dt*(4.+gait*7.);
  let sway=self.carry_sway.sin()*(0.003+gait*0.012)*(1.-self.aim_blend*0.65);
  crate::fire_carry::Pose{strength:self.carry_blend,aiming:self.aim_blend,pitch,sway}
 }

 pub fn props(&mut self,origin:(i32,i32),world:&craftyap_core::world::World,frame:crate::fire_carry::Frame)->Vec<Vertex>{
  use glam::{Mat4,Quat,Vec3};
  use crate::fire_extinguisher as ext;
  let offset=Vec3::new(origin.0 as f32,0.,origin.1 as f32);
  let mut out=Vec::new();self.nozzle=None;
  if self.drill.extinguisher&&!self.waiting{
   let aim_blend=self.aim_blend;
   let camera=frame.camera;
   let view=frame.view;
   let camera_right=Vec3::new(-frame.view_yaw.cos(),0.,frame.view_yaw.sin());
   let camera_up=camera_right.cross(view).normalize_or_zero();
   let reach=|at:Vec3,direction:Vec3,limit:f32| world.raycast_camera(at.x as f64,at.y as f64,at.z as f64,direction.x as f64,direction.y as f64,direction.z as f64,limit as f64).map_or(limit,|hit|hit.dist as f32);
   let from_camera=|x:f32,y:f32,z:f32|camera+camera_right*x+camera_up*y+view*z;
   let camera_reach=reach(camera,view,12.);
   let mut aim=camera+view*camera_reach;
   let forward_yaw=if frame.first{frame.view_yaw}else{frame.facing};
   let forward=if frame.first {Vec3::new(-forward_yaw.sin(),-0.9,-forward_yaw.cos())}else{Vec3::new(forward_yaw.sin(),0.,forward_yaw.cos())};
   let (right,left,rotation)=if frame.first{
    let right_probe=from_camera(0.323,-0.345*frame.view_scale,0.76)-camera;
    let left_probe=from_camera(-0.278+aim_blend*0.035,(-0.290+aim_blend*0.02)*frame.view_scale,0.80+aim_blend*0.035)+camera_right*0.075-camera_up*0.075-camera;
    let near=reach(camera,right_probe.normalize_or_zero(),right_probe.length()+0.08).min(reach(camera,left_probe.normalize_or_zero(),left_probe.length()+0.08)).min(camera_reach);
    let x=((near-0.24)/(0.82-0.24)).clamp(0.,1.);
    let tuck=1.-x*x*(3.-2.*x);
    self.tuck+=(tuck-self.tuck)*(1.-(-16.*frame.dt).exp());
    let mut right=from_camera(0.323-self.tuck*0.05,(-0.345+frame.sway-self.tuck*0.10)*frame.view_scale,0.76-self.tuck*0.34);
    let mut left=from_camera(-0.278+aim_blend*0.035,(-0.290+aim_blend*0.02+frame.sway-self.tuck*0.12)*frame.view_scale,0.80+aim_blend*0.035-self.tuck*0.34);
    if near<0.34{let adjustment=from_camera(0.,-(0.34-near)*1.45,-0.18)-camera;right+=adjustment;left+=adjustment;}
    (right,left,Quat::from_rotation_y(frame.view_yaw+std::f32::consts::PI)*Quat::from_rotation_x(frame.pitch))
   }else{
    let side=Vec3::new(-frame.facing.cos(),0.,frame.facing.sin());
    let right=self.hands[0].unwrap_or(frame.feet+side*0.61+forward*0.26+Vec3::Y*(frame.eye_height-0.60));
    let left=self.hands[1].unwrap_or(frame.feet-side*0.53+forward*0.34+Vec3::Y*(frame.eye_height-0.55));
    (right,left,Quat::from_rotation_y(frame.facing-0.55)*Quat::from_rotation_x(-0.06*aim_blend))
   };
   if (aim-left).dot(view)<0.18{aim=left+view*0.18;}
   let roll=if frame.first{frame.sway}else{-0.10+frame.sway};
   let rotation=rotation*Quat::from_rotation_z(roll);
   let grip=ext::grip()+if frame.first{Vec3::new(0.,0.030,0.068)}else{Vec3::ZERO};
   let body=Mat4::from_rotation_translation(rotation,right-rotation*grip);
   let nozzle_hand=if frame.first{left+camera_right*0.075-camera_up*0.075}else{left};
   let(tip,direction)=ext::carry(body,aim_blend,nozzle_hand,aim,forward*(if frame.first{if self.tuck>0.85{0.24}else{0.63}}else{1.}),&mut out);
   if frame.first {
    let grip=((self.carry_blend-0.18)/0.80).clamp(0.,1.);let grasp=grip*grip*(3.-2.*grip);
    crate::fire_carry::view_arm(&mut out,right,rotation*Vec3::Z,camera_right,camera_up,view,true,frame.rabbit,grasp);
    crate::fire_carry::view_arm(&mut out,left,direction,camera_right,camera_up,view,false,frame.rabbit,grasp);
   }
   let length=tip.distance(aim).min(5.);
   let barrel=tip-left;
   let barrel_clear=reach(left,barrel.normalize_or(direction),barrel.length());
   let open=if barrel_clear<barrel.length()-0.008{0.}else{reach(tip,direction,length)};
   self.nozzle=Some(((tip+offset).as_dvec3(),direction.as_dvec3(),open as f64));
  }else{
   for station in &scenario().stations{
    if station.kind!="extinguisher"{continue;}
    let yaw=station.rot as f32*std::f32::consts::FRAC_PI_2;
    let turn=Mat4::from_rotation_y(yaw);
    let at=Vec3::new(station.cell[0]as f32+0.5,station.cell[1]as f32,station.cell[2]as f32+0.5)-offset+turn.transform_vector3(Vec3::new(0.,0.06,-0.3));
    ext::mesh(Mat4::from_translation(at)*turn,0.,0.,None,&mut out);
   }
  }
  out
 }
 pub fn effects(&mut self,origin:(i32,i32),camera:DVec3,dt:f64)->Vec<Vertex>{
  let mut particles:Vec<(DVec3,f64,[u8;4])>=Vec::new();let t=self.clock;
  if !self.waiting&&self.drill.step<7{for (j,f)in scenario().fires.iter().enumerate(){let scale=if f.small{self.drill.fire}else{1.};for i in 0..9{let a=(t*0.8+i as f64/9.).fract();let p=DVec3::from(f.at)+DVec3::new((t*4.+i as f64).sin()*0.18*f.size,a*f.size*1.6,(i as f64*2.3+j as f64).sin()*0.2*f.size);particles.push((p,f.size*(0.65-a*0.35)*scale,if i%2==0{[255,188,37,230]}else{[255,83,22,220]}));}}}
  if !self.waiting&&self.drill.step>=4&&self.drill.step<7{let b=scenario().corridor;for i in 0..90{let seed=i as f64;let x=b[0]+((seed*0.618+t*0.018).fract())*(b[3]-b[0]);let z=b[2]+(seed*0.373).fract()*(b[5]-b[2]);let y=scenario().smoke_floor+0.3+(seed*0.17+t*0.05).fract()*(b[4]-scenario().smoke_floor-0.7);particles.push((DVec3::new(x,y,z),2.0,[81,91,101,65]));}}
  let spray=self.nozzle.filter(|(_,_,reach)|self.spraying&&*reach>0.055);
  self.powder.step(dt,spray);
  if !self.waiting{particles.extend(self.powder.visible());}
  if let Some(p)=self.target(){particles.push((DVec3::from(p)+DVec3::Y*(t*3.).sin()*0.1,0.45,[255,200,28,235]));}
  let offset=DVec3::new(origin.0 as f64,0.,origin.1 as f64);let mut out=Vec::new();particles.sort_by(|a,b|(b.0-offset-camera).length_squared().total_cmp(&(a.0-offset-camera).length_squared()));
  for (p,size,color)in particles{if size<=0.01{continue;}billboard(&mut out,p-offset,size,color,camera);}
  out
 }
 pub fn ui_hit(&self,x:f32,y:f32,w:f32,h:f32)->bool{self.panel_open()||Rect::new(w/2.-150.,h-98.,300.,86.).contains(x,y)||Rect::new(w-134.,if self.solo{12.}else{74.},122.,42.).contains(x,y)}
 pub fn draw(&mut self,ui:&mut Ui,dt:f64,yaw:f64){
  let(w,h)=ui.screen();let ink=[31,42,68,255];let white=[255,249,236,255];let top=if self.solo{0.}else{62.};
  if self.panel==Panel::None{
   ui.p.rect(12.,12.+top,(w-164.).min(620.),62.,14.,[24,38,74,230]);
   let title=if self.waiting{"선생님 설명을 듣고 출발을 기다려요"}else{STEPS[self.drill.step]};
   ui.text(&format!("화재 체험 · {} / 7   {}",self.drill.step.min(6)+1,title),26.,24.+top,16.,white,Align::Left);
   if let Some(at)=self.target(){let dx=at[0]-self.player[0];let dz=at[2]-self.player[2];let a=(-dx*yaw.cos()+dz*yaw.sin()).atan2(dx*yaw.sin()+dz*yaw.cos());let arrows=["↑","↗","→","↘","↓","↙","←","↖"];let i=((a/std::f64::consts::FRAC_PI_4).round()as i32).rem_euclid(8)as usize;ui.text(&format!("{} {:.0}m   {}",arrows[i],dx.hypot(dz),self.hint),26.,48.+top,12.,[255,210,28,255],Align::Left);}
   if ui.button(Rect::new(w-134.,12.+top,122.,42.),if self.solo{"나가기"}else{"진행판"},ButtonStyle::Plain,true){if self.solo{self.exit_requested=true;}else{self.panel=Panel::Board;}}
   if let Some(i)=self.aimed{let name=match scenario().stations[i].kind.as_str(){"alarm"=>"경보기 누르기","phone"=>"119 신고","extinguisher"=>"소화기 사용","towel"=>"젖은 수건","sign"=>"유도등 살펴보기",_=>"사용"};if ui.button(Rect::new(w/2.-145.,h-94.,190.,42.),&format!("E / 사용 · {name}"),ButtonStyle::Primary,true){self.use_requested=true;}}
   if ui.button(Rect::new(w/2.+52.,h-94.,94.,42.),"Z · 낮추기",ButtonStyle::Plain,true){self.low_requested=true;}
   if self.drill.step>=3&&self.drill.step<7{ui.p.rect(w/2.-146.,h-43.,292.,25.,10.,[24,38,74,220]);ui.text(&format!("숨 {:.0}%  소화기 {:.0}%  {}",self.drill.air*100.,self.drill.charge*100.,if self.drill.towel{"수건 착용"}else{""}),w/2.,h-39.,12.,white,Align::Center);}
   return;
  }
  ui.p.rect(0.,0.,w,h,0.,[10,18,35,180]);let cw=(w-32.).min(620.);let x=(w-cw)/2.;let panel=Rect::new(x,16.,cw,h-32.);ui.p.rect(panel.x,panel.y,panel.w,panel.h,18.,white);
  if ui.button(Rect::new(x+cw-60.,24.,44.,34.),"닫기",ButtonStyle::Plain,true){self.panel=Panel::None;return;}
  match self.panel{
   Panel::Call=>{
    ui.text("119 신고하기",x+24.,34.,22.,ink,Align::Left);
    if !self.call_connected{
     ui.text(&self.dial,w/2.,76.,27.,ink,Align::Center);let bw=62.;let gap=9.;let start=w/2.-(3.*bw+2.*gap)/2.;let top=112.;
     for i in 0..12{let label=if i<9{(i+1).to_string()}else{["지움","0","신고"][i-9].into()};let rect=Rect::new(start+(i%3)as f32*(bw+gap),top+(i/3)as f32*45.,bw,38.);if ui.button(rect,&label,ButtonStyle::Plain,true){if i<9&&self.dial.len()<3{self.dial.push_str(&label);}else if i==9{self.dial.clear();}else if i==10&&self.dial.len()<3{self.dial.push('0');}else if i==11{if self.dial=="119"{self.call_connected=true;}else{self.hint="불이 났을 때는 119에 신고해요".into();self.dial.clear();}}}}
     ui.text(&self.hint,w/2.,h-45.,12.,ink,Align::Center);
    }else{
     ui.text("어디에서 무슨 일이 났는지 말해요",w/2.,92.,17.,ink,Align::Center);
     if ui.button(Rect::new(x+24.,140.,cw-48.,56.),"크래프트 학교 2층 과학실에 불이 났어요",ButtonStyle::Primary,true){self.call_correct=true;}
     if ui.button(Rect::new(x+24.,208.,cw-48.,45.),"불이야! 하고 바로 끊기",ButtonStyle::Plain,true){self.hint="학교와 층, 무슨 일인지 알려요".into();}
     ui.text(&self.hint,w/2.,h-91.,12.,ink,Align::Center);
     if ui.button(Rect::new(w/2.-95.,h-70.,190.,42.),"신고 마치기",ButtonStyle::Go,self.call_correct){self.drill.step=2;self.panel=Panel::None;self.report=Some((2,None,None));}
    }
   }
   Panel::Pass=>{
    let stage=if !self.gauge_checked{0}else{self.pass+1};
    ui.text("소화기 연습",x+24.,32.,24.,ink,Align::Left);ui.text(&format!("{} / 5",stage+1),x+cw-75.,39.,16.,ink,Align::Center);
    let labels=["바늘이 초록색에 있나요?","노란 고리를 옆으로 끌어요","호스 끝을 불 아래로 끌어요","위 손잡이를 꾹 눌러요","천천히 좌우로 한 번 왕복해요"];
    ui.text(labels[stage.min(4)as usize],w/2.,86.,18.,ink,Align::Center);
    let vh=(h-290.).clamp(90.,310.);let view=Rect::new(x+22.,119.,cw-44.,vh);
    let background=if stage>=3{[36,52,69,255]}else{[230,240,232,255]};
    ui.p.rect(view.x,view.y,view.w,view.h,15.,background);
    if self.pass>0{self.lesson_pin=(self.lesson_pin+dt as f32*2.).min(1.);}if self.pass>1{self.lesson_aim=(self.lesson_aim+dt as f32*2.).min(1.);}
    if self.lesson_help{if stage==1{self.lesson_pin=(self.lesson_pin+dt as f32*0.65).min(1.);if self.lesson_pin>=1.{self.pass=1;self.lesson_help=false;}}else if stage==2{self.lesson_aim=(self.lesson_aim+dt as f32*0.65).min(1.);if self.lesson_aim>=1.{self.pass=2;self.lesson_help=false;}}}
    let(marker,fire)=crate::fire_extinguisher::preview(ui.p,view,self.lesson_pin,if self.lesson_squeeze||stage==4{1.}else{0.},self.lesson_aim,stage,ui.time,self.lesson_sweep,&mut self.lesson_powder,dt);
    if stage>=3&&self.lesson_powder.visible().next().is_some(){
     ui.p.rect(view.x+10.,view.y+9.,78.,25.,7.,[28,42,56,255]);
     ui.text("ABC 분말",view.x+49.,view.y+15.,12.,[255,243,215,255],Align::Center);
    }
    let action=Rect::new(x+28.,view.y+view.h+12.,cw-56.,54.);self.lesson_squeeze=false;
    if stage==0{if ui.button(action,"초록색이에요  ✓",ButtonStyle::Primary,true){self.gauge_checked=true;}}
    else if stage<3{
     ui.button(action,if stage==1{"고리를 잡고 옆으로  →"}else{"호스를 불 쪽으로 끌어요  →"},ButtonStyle::Primary,true);
     if ui.ptr.pressed&&(action.contains(ui.ptr.pos.0,ui.ptr.pos.1)||view.contains(ui.ptr.pos.0,ui.ptr.pos.1)){self.lesson_drag=Some((ui.ptr.pos.0,ui.ptr.pos.1,if stage==1{self.lesson_pin}else{self.lesson_aim},view.contains(ui.ptr.pos.0,ui.ptr.pos.1)));}
     if let Some((sx,sy,base,on_model))=self.lesson_drag{
      let(dx,dy)=if stage==2&&on_model{(fire[0]-marker[0],fire[1]-marker[1])}else{(90.,0.)};let value=(base+((ui.ptr.pos.0-sx)*dx+(ui.ptr.pos.1-sy)*dy)/(dx*dx+dy*dy).max(1600.)).clamp(0.,1.);
      if ui.ptr.down{if stage==1{self.lesson_pin=value;}else{self.lesson_aim=value;}}
      if ui.ptr.released{self.lesson_drag=None;if(if stage==1{self.lesson_pin}else{self.lesson_aim})>=0.72{self.pass+=1;}}
     }
    }else if stage==3{
     let ready=self.hold>=0.7;
     if self.lesson_ready{
      if ui.button(action,"좌우로 뿌려 보기 →",ButtonStyle::Go,true){self.pass=3;}
     }else{
      ui.button(action,if ready{"잘했어요. 이제 손을 떼세요"}else{"여기를 꾹 누르세요"},ButtonStyle::Primary,true);
      if ui.pressing(action)||self.lesson_help{
       self.lesson_squeeze=true;self.hold+=dt;
       if self.lesson_help&&self.hold>=1.{self.lesson_help=false;}
      }else if !ready{self.hold=0.;}
      else if !ui.ptr.down{self.lesson_ready=true;}
      ui.p.rect(action.x,action.y+action.h-7.,action.w*(self.hold as f32/0.7).min(1.),5.,2.,[36,163,105,255]);
     }
    }else{
     ui.p.rect(action.x,action.y,action.w,action.h,14.,[209,237,217,255]);ui.text("←     손으로 천천히 움직여요     →",w/2.,action.y+16.,15.,ink,Align::Center);
     if (ui.ptr.down||ui.ptr.released)&&action.contains(ui.ptr.pos.0,ui.ptr.pos.1){let x=(ui.ptr.pos.0-action.x)/action.w;self.lesson_sweep=x;let side=if x<0.35{-1}else if x>0.65{1}else{0};if side!=0&&side!=self.last_side{if self.last_side!=0{self.sweeps+=1;}self.last_side=side;}}
    }
    let help=Rect::new(w/2.-120.,action.y+61.,240.,30.);
    if stage>0&&stage<4&&!(stage==3&&self.hold>=0.7)&&ui.button(help,"어려워요 · 천천히 보여 주세요",ButtonStyle::Plain,true){self.lesson_help=true;}
    if stage==4{ui.text(if self.sweeps>=2{"잘했어요! 소화기를 들고 출발해요"}else{"양쪽을 번갈아 눌러도 돼요"},w/2.,action.y+66.,14.,ink,Align::Center);}
    if ui.button(Rect::new(w/2.-105.,h-56.,210.,40.),"소화기 들고 출발!",ButtonStyle::Go,self.pass==3&&self.sweeps>=2){self.drill.trained=true;self.drill.extinguisher=true;self.drill.charge=1.;self.drill.step=3;self.panel=Panel::None;self.report=Some((3,None,None));}
   }
   Panel::Result=>{
    ui.text("대피 훈련 완료!",w/2.,70.,28.,ink,Align::Center);ui.text(&format!("별 {}개 · {:.0}초 · 숨 고르기 {}번",self.drill.stars(),self.drill.time,self.drill.mistakes),w/2.,130.,19.,ink,Align::Center);
    ui.text("모이는 곳에 도착했어요. 다시 들어가지 않아요.",w/2.,180.,15.,ink,Align::Center);
    if ui.button(Rect::new(w/2.-100.,h-90.,200.,46.),"다시 연습하기",ButtonStyle::Go,true){self.restart();}
   }
   Panel::Board=>{
    ui.text("화재 체험 진행판",x+24.,34.,22.,ink,Align::Left);
    if self.teacher{let labels=["모두 출발","4명씩 편성","5명씩 편성","훈련 멈춤"];
     for(i,label)in labels.iter().enumerate(){if ui.button(Rect::new(x+20.+i as f32*(cw-40.)/4.,78.,(cw-48.)/4.,42.),label,ButtonStyle::Primary,true){self.command=Some(match i{0=>("start",None,None),1=>("teams",Some(4),None),2=>("teams",Some(5),None),_=>("stop",None,None)});}}
    }
    if let Some(c)=self.class.clone(){let mut teams=c.teams.iter().map(|(_,t)|*t).collect::<Vec<_>>();teams.sort();teams.dedup();let mut y=134.;for team in teams{if y>h-72.{break;}let names=c.teams.iter().filter(|(_,t)|*t==team).map(|(n,_)|n.as_str()).collect::<Vec<_>>().join(", ");ui.text(&format!("{}조 · {}",team,names),x+24.,y,14.,ink,Align::Left);if self.teacher&&ui.button(Rect::new(x+cw-120.,y-3.,96.,30.),"이 조 출발",ButtonStyle::Go,true){self.command=Some(("start",None,Some(team)));}y+=42.;}
     for report in &c.reports{if y>h-45.{break;}ui.text(&format!("{} · {}",report.name,STEPS[(report.step as usize).min(7)]),x+24.,y,12.,ink,Align::Left);y+=23.;}
    }
   }
   Panel::None=>{}
  }
 }
}
fn ray_box(eye:DVec3,dir:DVec3,b:&[f64;6],reach:f64)->Option<f64>{let mut lo=0.0f64;let mut hi=reach;for k in 0..3{let o=eye[k];let d=dir[k];if d.abs()<1e-9{if o<b[k]||o>b[k+3]{return None;}}else{let a=(b[k]-o)/d;let z=(b[k+3]-o)/d;lo=lo.max(a.min(z));hi=hi.min(a.max(z));if lo>hi{return None;}}}Some(lo)}
fn billboard(out:&mut Vec<Vertex>,p:DVec3,size:f64,color:[u8;4],camera:DVec3){let view=(camera-p).normalize_or_zero();let right=DVec3::Y.cross(view).normalize_or_zero();let up=view.cross(right);for (x,y)in [(-0.5,-0.5),(0.5,-0.5),(0.5,0.5),(-0.5,-0.5),(0.5,0.5),(-0.5,0.5)]{let at=p+(right*x+up*y)*size;out.push(Vertex{pos:at.as_vec3().to_array(),nrm:[x as f32,y as f32,0.],color});}}

#[cfg(test)]
mod campus_tests {
 use super::*;
 use craftyap_core::{body::{Body,step_body,can_occupy},world::World};
 #[allow(clippy::field_reassign_with_default)] // a default world, then the two sceneries
 fn world()->World{let mut w=World::default();w.static_scene=Some(collision());w.static_camera_scene=Some(camera_collision());w}
 #[test]fn classroom_arrivals_and_real_stair_evacuation(){
  let w=world();for p in &scenario().spawns{let mut b=Body::at(p[0],p[1],p[2]);assert!(can_occupy(&w,&b,1.8),"spawn {p:?}");for _ in 0..20{step_body(&w,&mut b,1./60.,0.,0.,false,0.,0.);}assert!((b.y-8.4).abs()<0.01);}
  let mut b=Body::at(-8.25,8.4,-8.2);
  for(x,z)in[(-6.1,-8.2),(-6.1,-4.3),(-11.8,-4.3),(-9.2,-4.3),(-14.45,-4.3),(-17.4,-4.3),(5.5,-4.3),(0.4,-4.3),(0.4,-10.2),(0.4,-16.35),(-2.4,-16.35),(-2.4,-9.8),(0.,-8.),(0.,1.),(0.,17.)]{
   for _ in 0..2400{let dx=x-b.x;let dz=z-b.z;let len=dx.hypot(dz);if len<0.065{break;}let speed=2.7f64.min(len*60.);step_body(&w,&mut b,1./60.,dx/len*speed/4.6,dz/len*speed/4.6,false,0.,0.);}
   assert!((b.x-x).hypot(b.z-z)<0.09,"blocked at {:?}, heading {x},{z}",b);
  }assert!((b.y-scenario().assembly.y).abs()<0.02);
 }
 #[test]fn native_camera_stays_clear_of_rendered_trim_and_wall_props(){
  let w=world();let scene=camera_collision();
  for p in [[-14.25,4.05,-0.55],[-19.,4.05,-1.1],[-4.4,4.05,0.8],[-13.84,8.4,-8.2],[-7.45,8.4,-6.2],[-6.1,8.4,-6.2],[0.4,8.4,-10.2],[-2.4,6.2,-16.35],[-2.4,4.,-9.8],[0.,4.05,-1.]]{
   for first in [false,true]{let mut c=crate::follow::FollowCamera::default();if first{c.toggle_view();}
    for i in 0..32{for pitch in [-1.35,-0.7,0.,0.7,1.35]{let eye=DVec3::new(p[0],p[1]+1.55,p[2]);c.update(&w,eye,eye.y,i as f64*std::f64::consts::TAU/32.,pitch,false,1./60.);
     let e=c.eye;assert!(!scene.intersects([e.x-0.219,e.y-0.219,e.z-0.219],[e.x+0.219,e.y+0.219,e.z+0.219]),"camera clips at {p:?}, first {first}, pitch {pitch}, eye {e:?}");
    }}
   }
  }
 }
 #[test]fn exit_signs_have_real_mounting_surfaces(){
  let raw:Geometry=serde_json::from_str(include_str!("../../../assets/fire-school/collision.json")).unwrap();
  let scene=StaticScene::new(raw.camera_boxes.iter().map(|b|Bounds{min:b.min,max:b.max}).collect(),Vec::new());
  for s in &scenario().signs{let up=s.mount.kind=="ceiling";let hit=scene.raycast([s.at[0],s.mount.y+if up{-0.02}else{0.02},s.at[2]],[0.,if up{1.}else{-1.},0.],0.05);assert!((hit.expect("unsupported sign").dist-0.02).abs()<0.0001);}
 }
}
