//! Metre-accurate scenery with a lazy BVH for detailed imported camera geometry.
// The walks below are written one node to a line (`…{continue;}if …`): that is their layout, not a lost `else`.
#![allow(clippy::possible_missing_else)]
use std::sync::OnceLock;
pub type V3 = [f64; 3];
#[derive(Clone, Debug)] pub struct Bounds { pub min: V3, pub max: V3 }
#[derive(Clone, Debug)] pub struct Ramp { pub bounds: Bounds, pub h0: f64, pub h1: f64 }
#[derive(Clone, Debug, Default)] pub struct StaticScene { pub boxes: Vec<Bounds>, pub ramps: Vec<Ramp>, index: OnceLock<Vec<Node>> }
#[derive(Clone, Copy, Debug)] pub struct Hit { pub dist: f64, pub point: V3, pub normal: V3 }
#[derive(Clone, Debug)] struct Node { bounds: Bounds, children: Option<(usize,usize)>, items: Vec<usize> }
const EPS: f64 = 1e-6;
impl Ramp { fn height(&self,z:f64)->f64{self.h0+(self.h1-self.h0)*(z-self.bounds.min[2])/(self.bounds.max[2]-self.bounds.min[2])} }
fn overlap(a:V3,b:V3,c:&Bounds)->bool{(0..3).all(|k|a[k]<c.max[k]-EPS&&b[k]>c.min[k]+EPS)}
fn box_ray(p:V3,d:V3,b:&Bounds,reach:f64)->Option<Hit>{
 let(mut enter,mut exit,mut normal)=(0.0f64,reach,[0.;3]);
 for k in 0..3 {if d[k].abs()<1e-12{if p[k]<b.min[k]-EPS||p[k]>b.max[k]+EPS{return None;}continue;}
  let a=(b.min[k]-p[k])/d[k];let z=(b.max[k]-p[k])/d[k];let lo=a.min(z);
  if lo>enter{enter=lo;normal=[0.;3];normal[k]=if d[k]>0.{-1.}else{1.};}exit=exit.min(a.max(z));if enter>exit+EPS{return None;}
 }Some(Hit{dist:enter,point:std::array::from_fn(|k|p[k]+d[k]*enter),normal})
}
impl StaticScene{
 pub fn new(boxes:Vec<Bounds>,ramps:Vec<Ramp>)->Self{Self{boxes,ramps,index:OnceLock::new()}}
 fn bounds(&self,i:usize)->&Bounds{if i<self.boxes.len(){&self.boxes[i]}else{&self.ramps[i-self.boxes.len()].bounds}}
 fn nodes(&self)->&[Node]{self.index.get_or_init(||{
  fn build(s:&StaticScene,mut items:Vec<usize>,nodes:&mut Vec<Node>)->usize{
   let mut b=Bounds{min:[f64::INFINITY;3],max:[f64::NEG_INFINITY;3]};
   for &i in &items{let q=s.bounds(i);for k in 0..3{b.min[k]=b.min[k].min(q.min[k]);b.max[k]=b.max[k].max(q.max[k]);}}
   let axis=(0..3).max_by(|&a,&c|(b.max[a]-b.min[a]).total_cmp(&(b.max[c]-b.min[c]))).unwrap();
   let ix=nodes.len();nodes.push(Node{bounds:b,children:None,items:Vec::new()});
   if items.len()<=8{nodes[ix].items=items;}else{items.sort_by(|&a,&b|{let a=s.bounds(a);let b=s.bounds(b);(a.min[axis]+a.max[axis]).total_cmp(&(b.min[axis]+b.max[axis]))});let right=items.split_off(items.len()/2);let a=build(s,items,nodes);let b=build(s,right,nodes);nodes[ix].children=Some((a,b));}ix
  }
  let mut nodes=Vec::new();let items=(0..self.boxes.len()+self.ramps.len()).collect::<Vec<_>>();if !items.is_empty(){build(self,items,&mut nodes);}nodes
 })}
 pub fn intersects(&self,a:V3,b:V3)->bool{
  let nodes=self.nodes();if nodes.is_empty(){return false;}let mut stack=vec![0];
  while let Some(ix)=stack.pop(){let n=&nodes[ix];if !overlap(a,b,&n.bounds){continue;}if let Some((l,r))=n.children{stack.push(l);stack.push(r);continue;}
   for &i in &n.items{let c=self.bounds(i);if !overlap(a,b,c){continue;}if i<self.boxes.len(){return true;}let r=&self.ramps[i-self.boxes.len()];if a[1]<r.height(a[2].max(c.min[2])).max(r.height(b[2].min(c.max[2])))-EPS{return true;}}
  }false
 }
 pub fn ramp_floor(&self,p:V3,half:f64)->Option<f64>{
  let mut top=f64::NEG_INFINITY;for r in &self.ramps{let b=&r.bounds;if p[0]+half<=b.min[0]||p[0]-half>=b.max[0]||p[2]+half<=b.min[2]||p[2]-half>=b.max[2]{continue;}
   let h=r.height((p[2]-half).max(b.min[2])).max(r.height((p[2]+half).min(b.max[2])));if(h-p[1]).abs()<0.65{top=top.max(h);}}
  top.is_finite().then_some(top)
 }
 pub fn raycast(&self,p:V3,d:V3,reach:f64)->Option<Hit>{
  let nodes=self.nodes();if nodes.is_empty(){return None;}let mut stack=vec![0];let mut nearest:Option<Hit>=None;
  while let Some(ix)=stack.pop(){let n=&nodes[ix];if box_ray(p,d,&n.bounds,nearest.map_or(reach,|h|h.dist)).is_none(){continue;}if let Some((l,r))=n.children{stack.push(l);stack.push(r);continue;}
   for &i in &n.items{let b=self.bounds(i);let Some(mut h)=box_ray(p,d,b,nearest.map_or(reach,|h|h.dist))else{continue;};
    if i>=self.boxes.len(){let r=&self.ramps[i-self.boxes.len()];let slope=(r.h1-r.h0)/(b.max[2]-b.min[2]);let q=p[1]-slope*p[2]-(r.h0-slope*b.min[2]);let v=d[1]-slope*d[2];
     if v.abs()<1e-12{if q>EPS{continue;}}else{let t=-q/v;if v<0.&&t>h.dist{let len=(1.+slope*slope).sqrt();h.dist=t;h.normal=[0.,1./len,-slope/len];h.point=std::array::from_fn(|k|p[k]+d[k]*t);}else if v>0.&&t<h.dist-EPS{continue;}}
     if h.dist>reach||!(0..3).all(|k|h.point[k]>=b.min[k]-EPS&&h.point[k]<=b.max[k]+EPS){continue;}
    }
    if nearest.is_none_or(|old|h.dist<old.dist){nearest=Some(h);}
   }
  }nearest
 }
}
