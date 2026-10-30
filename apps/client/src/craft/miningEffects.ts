import * as THREE from "three";
import type {BlockDef} from "./blocks.js";
import {surfaceStyle} from "./blockMaterials.js";
import {shapeIntersectsBox,raycastBlockShape} from "@robo/shared";
import type {VoxelWorld} from "./voxelWorld.js";
import {MiningFracture,fractureInterior,piecesFromTemplate,type DamageShape} from "./miningFracture.js";
import {FractureTemplates} from "./fractureJobs.js";
import {fractureVariant} from "./fractureVariation.js";
export const MINING_STAGES=5,MINING_PARTICLE_LIMIT=96;
export function miningDamageStage(progress:number):number {return !Number.isFinite(progress)||progress<=.04?0:Math.min(MINING_STAGES,1+Math.floor(Math.max(0,progress)*MINING_STAGES));}
const random=(seed:number):(()=>number)=>()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return (seed>>>0)/4294967296;};
/** Successive stages retain the same impact and extend its cracks; they never swap to unrelated patterns. */
export function miningCrackPixels(stage:number,size=128):Uint8Array {
 const pixels=new Uint8Array(size*size*4);if(stage<=0)return pixels;
 const rng=random(7249),strength=Math.min(1,stage/MINING_STAGES);
 const dot=(x:number,y:number,width:number,alpha:number)=>{for(let dy=-width;dy<=width;dy++)for(let dx=-width;dx<=width;dx++){const px=Math.round(x)+dx,py=Math.round(y)+dy;if(px<0||py<0||px>=size||py>=size||dx*dx+dy*dy>width*width+1)continue;const i=(py*size+px)*4;pixels[i]=255;pixels[i+1]=255;pixels[i+2]=255;pixels[i+3]=Math.max(pixels[i+3]!,alpha);}};
 const line=(ax:number,ay:number,bx:number,by:number,width:number,alpha:number)=>{const count=Math.max(1,Math.ceil(Math.hypot(bx-ax,by-ay)*1.5));for(let i=0;i<=count;i++){const t=i/count;dot(ax+(bx-ax)*t,ay+(by-ay)*t,width,alpha);}};
 for(let branch=0;branch<11;branch++){
  const angle=branch*Math.PI*2/11+(rng()-.5)*.27,length=size*(.39+rng()*.2),steps=10;let x=size*.48,y=size*.51;
  for(let i=1;i<=steps;i++){
   const wobble=(rng()-.5)*size*.055,nx=size*.48+Math.cos(angle)*length*i/steps-Math.sin(angle)*wobble,ny=size*.51+Math.sin(angle)*length*i/steps+Math.cos(angle)*wobble;
   if(i/steps<=strength+.035)line(x,y,nx,ny,stage>=4?2:1,stage>=4?220:170);
   if(i>2&&i<8){const a=angle+(branch%2?1:-1)*.7,sideLength=size*.1*(.5+rng());if(i/steps<strength-.16)line(nx,ny,nx+Math.cos(a)*sideLength,ny+Math.sin(a)*sideLength,0,155);}
   x=nx;y=ny;
  }
 }return pixels;
}
type ParticleKind="chunk"|"snow"|"gem"|"wood"|"metal";
interface Debris {active:boolean;kind:ParticleKind;x:number;y:number;z:number;vx:number;vy:number;vz:number;rx:number;ry:number;rz:number;spin:number;size:number;age:number;life:number;gravity:number;colour:THREE.Color;bounce:number}
export class MiningEffects {
 readonly root=new THREE.Group();
 private readonly fractures=new Set<MiningFracture>();
 private current:MiningFracture|undefined;
 /** The target whose cut is still in the worker: the block stays drawn whole until its shards exist. */
 private waiting:{template:string;cell:[number,number,number];def:BlockDef;family:string;seed:number;materials:THREE.Material[]}|null=null;
 private progress=0;
 private readonly templates=new FractureTemplates();
 /** One cut-surface material per (block, exterior): never disposed mid-session, so its shader program is never rebuilt. */
 private readonly interiors=new Map<string,{material:THREE.MeshStandardMaterial;textures:THREE.Texture[]}>();
 private readonly fallbacks=new Map<string,THREE.MeshStandardMaterial>();
 private warm:THREE.Group|null=null;
 private readonly pool:Debris[]=[];
 private readonly meshes=new Map<ParticleKind,THREE.InstancedMesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>>();
 private readonly matrix=new THREE.Matrix4();private readonly quat=new THREE.Quaternion();private readonly euler=new THREE.Euler();private readonly position=new THREE.Vector3();private readonly scale=new THREE.Vector3();
 private variationSalt=0;
 private targetKey="";private stage=0;private cursor=0;private disposed=false;
 constructor(private readonly scene:THREE.Scene,private readonly onTarget:(cell:readonly [number,number,number]|null)=>void=()=>{}){
  this.root.name="CraftYap mining visual effects";scene.add(this.root);
  for(const kind of ["chunk","snow","gem","wood","metal"] as const){
   const geometry=kind==="wood"?new THREE.BoxGeometry(.2,1,.2):kind==="metal"?new THREE.BoxGeometry(1,.08,.7):kind==="snow"?new THREE.IcosahedronGeometry(.5,1):kind==="gem"?new THREE.OctahedronGeometry(.6,0):new THREE.BoxGeometry(1,1,1);
   const material=new THREE.MeshStandardMaterial({roughness:kind==="metal"?.32:kind==="gem"?.27:.93,metalness:kind==="metal"?.8:kind==="gem"?.1:0,vertexColors:false});
   const mesh=new THREE.InstancedMesh(geometry,material,MINING_PARTICLE_LIMIT);mesh.name="Mining "+kind+" debris";mesh.count=0;mesh.frustumCulled=false;mesh.castShadow=false;this.meshes.set(kind,mesh);this.root.add(mesh);
  }
  for(let i=0;i<MINING_PARTICLE_LIMIT;i++)this.pool.push({active:false,kind:"chunk",x:0,y:0,z:0,vx:0,vy:0,vz:0,rx:0,ry:0,rz:0,spin:0,size:0,age:0,life:1,gravity:12,colour:new THREE.Color(),bounce:0});
 }
 /** One fractured copy per target. Exterior materials are borrowed; source geometry ownership transfers. */
 setProgress(cell:readonly [number,number,number],def:BlockDef,shape:number,progress:number,makeShape:()=>DamageShape):void {
  if(this.disposed)return;const nextStage=miningDamageStage(progress),key=cell.join(",")+"|"+def.id+"|"+shape;
  if(!nextStage){this.clearTarget();return;}
  this.progress=progress;
  if(key!==this.targetKey){this.clearTarget();this.targetKey=key;this.prepare(cell,def,shape,makeShape());}
  if(!this.current&&this.waiting)this.start();
  this.current?.setProgress(progress);
  if(nextStage!==this.stage){this.stage=nextStage;this.chips(cell,def,shape,nextStage);}
 }
 /** Prepare geometry during the wind-up without showing cracks or hiding the intact block. */
 primeTarget(cell:readonly [number,number,number],def:BlockDef,shape:number,makeShape:()=>DamageShape):void {
  if(this.disposed)return;const waiting=this.waiting;this.prepare(cell,def,shape,makeShape());this.waiting=waiting;
 }
 /** Review-only salt changes the next cut; gameplay keeps the stable coordinate-based pattern. */
 setVariation(salt:number):void {if(this.variationSalt===(salt|0))return;this.clearTarget();this.variationSalt=salt|0;}
 /** Thirty-two seeded topologies per shape, still held in the same bounded worker cache. */
 private prepare(cell:readonly [number,number,number],def:BlockDef,shape:number,model:DamageShape):void {
  const family=surfaceStyle(def.key).family,{variant,seed}=fractureVariant(cell,def.id,shape,this.variationSalt);
  const materials=model.materials?(Array.isArray(model.materials)?model.materials:[model.materials]):[this.fallback(def.color)];
  const template=def.id+"|"+shape+"|"+model.geometry.getAttribute("position").count+"|"+materials.length+"|"+variant;
  if(this.templates.get(template))model.geometry.dispose();
  else{model.geometry.applyQuaternion(model.rotation);this.templates.request(template,model.geometry,materials.length,seed,family,def.key);}
  this.waiting={template,cell:[cell[0],cell[1],cell[2]],def,family,seed,materials};
 }
 private start():void {
  const w=this.waiting!,template=this.templates.get(w.template);if(!template)return;
  this.waiting=null;if(!template.length)return; // the cut failed: chips and the final burst still play
  const fracture=new MiningFracture({pieces:piecesFromTemplate(template),materials:w.materials,interior:this.interior(w.family,w.def,w.materials)},w.def.color,w.family,w.cell,w.seed,w.def.key);
  this.current=fracture;this.fractures.add(fracture);this.root.add(fracture.root);this.onTarget(w.cell);
  // Bound retained geometry even when a fast tool breaks several cells in one frame.
  while(this.fractures.size>4){const oldest=this.fractures.values().next().value!;oldest.dispose();this.fractures.delete(oldest);}
  fracture.setProgress(this.progress);
 }
 private interior(family:string,def:BlockDef,exterior:readonly THREE.Material[]):THREE.Material {
  const key=def.id+"|"+exterior.map(m=>m.uuid).join(",");let entry=this.interiors.get(key);
  if(!entry)this.interiors.set(key,entry=fractureInterior(family,def.color,exterior));return entry.material;
 }
 private fallback(colour:string):THREE.MeshStandardMaterial {let m=this.fallbacks.get(colour);if(!m)this.fallbacks.set(colour,m=new THREE.MeshStandardMaterial({color:colour,roughness:.85}));return m;}
 /**
  * Behind the loading screen: put one hidden-to-the-eye mesh per block exterior and cut-surface
  * material in the scene so the boot warm-up compiles their programs (and shadow variants).
  * Otherwise the first dig of each block family paid a shader compile mid-game.
  */
 prewarm(blocks:readonly {def:BlockDef;materials:THREE.Material[]}[]):void {
  this.endWarm();const group=new THREE.Group(),geometry=new THREE.BoxGeometry(.001,.001,.001);group.name="Mining warm-up";
  for(const {def,materials} of blocks){if(!materials.length)continue;const family=surfaceStyle(def.key).family;
   for(const material of [...materials,this.interior(family,def,materials)]){const mesh=new THREE.Mesh(geometry,material);mesh.frustumCulled=false;mesh.castShadow=true;group.add(mesh);}}
  this.warm=group;this.root.add(group);
 }
 endWarm():void {if(!this.warm)return;this.warm.removeFromParent();(this.warm.children[0] as THREE.Mesh|undefined)?.geometry.dispose();this.warm=null;}
 clearTarget():void {
  this.waiting=null;
  if(this.current){this.current.cancel();this.current=undefined;}
  if(this.targetKey)this.onTarget(null);this.targetKey="";this.stage=0;
 }
 private allocate():Debris {const p=this.pool[this.cursor++%this.pool.length]!;p.active=true;p.age=0;p.bounce=0;return p;}
 private chips(cell:readonly [number,number,number],def:BlockDef,shape:number,stage:number):void {
  const family=surfaceStyle(def.key).family;if(stage<2||family==="metal"&&stage<5||family==="wood"&&stage<3)return;this.spawn(cell,def,shape,family==="wood"||family==="metal"?1:stage===MINING_STAGES?5:2,false,stage*913);
 }
 burst(cell:readonly [number,number,number],def:BlockDef,shape:number,makeShape?:()=>DamageShape):void {
  if(this.disposed)return;
  const key=cell.join(",")+"|"+def.id+"|"+shape;
  if(this.targetKey!==key&&makeShape)this.setProgress(cell,def,shape,.99,makeShape);
  if(this.targetKey===key&&this.current){this.current.breakApart();this.current=undefined;this.onTarget(null);this.targetKey="";this.stage=0;}
  else{this.clearTarget();this.spawn(cell,def,shape,27,true,131);}
 }
 private spawn(cell:readonly [number,number,number],def:BlockDef,shape:number,count:number,breaking:boolean,salt:number):void {
  const family=surfaceStyle(def.key).family,rng=random((cell[0]*73856093^cell[1]*19349663^cell[2]*83492791^salt)|0),kind:ParticleKind=family==="wood"?"wood":family==="metal"?"metal":family==="snow"?"snow":family==="gem"||family==="ore"?"gem":"chunk";
  for(let i=0;i<count;i++){
   const grid=breaking?[(i%3+.5)/3,(Math.floor(i/9)+.5)/3,(Math.floor(i/3)%3+.5)/3]:[rng(),.5+rng()*.5,rng()];
   if(!breaking){const hit=raycastBlockShape(shape,[grid[0]!,2,grid[2]!],[0,-1,0],3);if(!hit)continue;grid[1]=2-hit.distance+.015;}
   const size=breaking?.15+rng()*.11:.026+rng()*.028;
   if(!shapeIntersectsBox(shape,{min:[grid[0]!-.025,grid[1]!-.025,grid[2]!-.025],max:[grid[0]!+.025,grid[1]!+.025,grid[2]!+.025]}))continue;
   const p=this.allocate();p.kind=kind;p.x=cell[0]+grid[0]!;p.y=cell[1]+grid[1]!;p.z=cell[2]+grid[2]!;const speed=breaking?.5:.6;
   p.vx=(grid[0]!-.5)*speed+(rng()-.5)*.7;p.vy=(breaking?-.05:.2)+rng()*(breaking?.18:.35);p.vz=(grid[2]!-.5)*speed+(rng()-.5)*.7;
   p.rx=rng()*3;p.ry=rng()*3;p.rz=rng()*3;p.spin=(rng()-.5)*7;p.size=size;p.life=breaking?(kind==="snow"?.95:.78)+rng()*.22:.28+rng()*.18;p.gravity=kind==="snow"?5.5:12;p.colour.set(family==="grass"&&grid[1]!<.77?"#946841":family==="ore"&&rng()>.3?"#8a919a":def.color).multiplyScalar(.82+rng()*.22);
  }
 }
 update(dt:number,world:Pick<VoxelWorld,"isBlocked">):void {
  if(this.disposed)return;if(!this.current&&this.waiting)this.start();const step=Math.max(0,Math.min(.05,dt)),counts:Record<ParticleKind,number>={chunk:0,snow:0,gem:0,wood:0,metal:0};
  for(const fracture of this.fractures){fracture.update(step,world);if(fracture.stats().finished){fracture.dispose();this.fractures.delete(fracture);}}
  for(const p of this.pool){if(!p.active)continue;p.age+=step;if(p.age>=p.life){p.active=false;continue;}
   p.vy-=p.gravity*step;p.x+=p.vx*step;p.y+=p.vy*step;p.z+=p.vz*step;p.rx+=p.spin*step;p.ry+=p.spin*.7*step;p.rz+=p.spin*.4*step;
   const y=Math.floor(p.y-p.size*.35);if(p.vy<0&&world.isBlocked(Math.floor(p.x),y,Math.floor(p.z))&&!world.isBlocked(Math.floor(p.x),y+1,Math.floor(p.z))){p.y=y+1+p.size*.35;p.vy=-p.vy*.22;p.vx*=.55;p.vz*=.55;p.bounce++;}
   const fade=1-Math.pow(p.age/p.life,2),size=p.size*fade,mesh=this.meshes.get(p.kind)!;this.position.set(p.x,p.y,p.z);this.euler.set(p.rx,p.ry,p.rz);this.quat.setFromEuler(this.euler);this.scale.set(size,size,size);this.matrix.compose(this.position,this.quat,this.scale);
   const index=counts[p.kind]++;mesh.setMatrixAt(index,this.matrix);mesh.setColorAt(index,p.colour);
  }
  for(const [kind,mesh] of this.meshes){mesh.count=counts[kind];mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;}
 }
 shift(dx:number,dz:number):void {this.clearTarget();for(const p of this.pool){p.x-=dx;p.z-=dz;}for(const fracture of this.fractures){fracture.root.position.x-=dx;fracture.root.position.z-=dz;}}
 stats():{stage:number;active:number;capacity:number;target:string;fractures:number;waiting:boolean;interiors:number;templates:ReturnType<FractureTemplates["stats"]>;geometry:ReturnType<MiningFracture["stats"]>|null}{let active=0;for(const p of this.pool)if(p.active)active++;return {stage:this.stage,active,capacity:this.pool.length,target:this.targetKey,fractures:this.fractures.size,waiting:!!this.waiting,interiors:this.interiors.size,templates:this.templates.stats(),geometry:this.current?.stats()??null};}
 reset():void {this.clearTarget();for(const fracture of this.fractures)fracture.dispose();this.fractures.clear();for(const p of this.pool)p.active=false;for(const mesh of this.meshes.values())mesh.count=0;}
 dispose():void {if(this.disposed)return;this.reset();this.disposed=true;this.endWarm();this.templates.dispose();for(const {material,textures} of this.interiors.values()){material.dispose();for(const t of textures)t.dispose();}this.interiors.clear();for(const m of this.fallbacks.values())m.dispose();this.fallbacks.clear();this.scene.remove(this.root);for(const mesh of this.meshes.values()){mesh.geometry.dispose();mesh.material.dispose();mesh.dispose();}this.pool.length=0;}

}

