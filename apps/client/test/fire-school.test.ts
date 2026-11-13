import {describe,expect,it} from "vitest";
import {FIRE_CAMPUS,fireSchool,inFireZone} from "@robo/shared";
import {FieldWindow} from "../src/craft/fieldWorld.js";
import {StaticScene} from "../src/craft/staticScene.js";
import {canOccupy,stepBody,type Body} from "../src/craft/voxelBody.js";
import {CraftCamera} from "../src/craft/craftCamera.js";
import * as THREE from "three";
const school=fireSchool();
function setup(){
 const field=new FieldWindow();field.replaceAll(school.edits);
 const scene=new StaticScene([...FIRE_CAMPUS.boxes,...school.obstacles],FIRE_CAMPUS.ramps,()=>[field.absOriginX,field.absOriginZ]);
 const cameraScene=new StaticScene([...FIRE_CAMPUS.cameraBoxes,...FIRE_CAMPUS.boxes,...school.obstacles],FIRE_CAMPUS.ramps,()=>[field.absOriginX,field.absOriginZ]);
 field.world.staticScene=scene;field.world.staticCameraScene=cameraScene;return {field,scene,cameraScene};
}
function bodyAt(field:FieldWindow,p:readonly[number,number,number]):Body{const[x,z]=field.toGrid(p[0],p[2]);return{x,y:p[1],z,vx:0,vy:0,vz:0,grounded:false};}
function walk(field:FieldWindow,b:Body,x:number,z:number){
 const[gx,gz]=field.toGrid(x,z);let n=0;
 while(Math.hypot(b.x-gx,b.z-gz)>.065&&n++<2400){const dx=gx-b.x,dz=gz-b.z,len=Math.hypot(dx,dz);const speed=Math.min(2.7,len*60);stepBody(field.world,b,1/60,dx/len*speed/4.6,dz/len*speed/4.6,false);}
 expect(Math.hypot(b.x-gx,b.z-gz),`blocked at ${b.x+field.absOriginX},${b.y},${b.z+field.absOriginZ}, heading ${x},${z}`).toBeLessThan(.09);
}
describe("Blender fire school in the real voxel movement and camera",()=>{
 it("owns the ground without duplicating the previous school or furniture",()=>{
  expect(school.edits.length).toBe(78*70);expect(school.edits.every(e=>e[1]===3&&e[3]===0)).toBe(true);
  expect(school.furniture).toHaveLength(0);expect(FIRE_CAMPUS.boxes.length).toBeGreaterThan(450);expect(FIRE_CAMPUS.ramps).toHaveLength(2);
 });
 it("supports every class arrival on the actual 8.4m second-floor slab",()=>{
  const{field}=setup();expect(school.spawns.length).toBeGreaterThanOrEqual(24);
  for(const p of school.spawns){const b=bodyAt(field,p);expect(canOccupy(field.world,b,1.8),String(p)).toBe(true);for(let i=0;i<20;i++)stepBody(field.world,b,1/60,0,0,false);expect(b.y).toBeCloseTo(8.4,2);expect(b.grounded).toBe(true);expect(inFireZone(school.heat,...p)).toBe(false);}
 });
 it("walks the whole lesson and descends both stair flights without jumping",()=>{
  const{field}=setup(),b=bodyAt(field,[-8.25,8.4,-8.2]);
  for(const[x,z]of [[-6.1,-8.2],[-6.1,-4.3],[-11.8,-4.3],[-9.2,-4.3],[-14.45,-4.3],[-17.4,-4.3],[5.5,-4.3],[.4,-4.3],[.4,-10.2],[.4,-16.35],[-2.4,-16.35],[-2.4,-9.8],[0,-8],[0,1],[0,17]])walk(field,b,x!,z!);
  expect(b.y).toBeCloseTo(4.125,1);expect(Math.hypot(b.x+field.absOriginX,b.z+field.absOriginZ-17)).toBeLessThan(.09);
 });
 it("stops the use ray at a wall and keeps the near plane out of imported geometry",()=>{
  const{field,cameraScene:scene}=setup();const[gx,gz]=field.toGrid(-11.8,-8.2);const hit=field.world.raycast(gx,9.95,gz,0,0,1,6,true);expect(hit?.dist).toBeLessThan(1.6);
  const camera=new THREE.PerspectiveCamera(70,21/9,.1,300),rig=new CraftCamera(camera);
  for(const p of [[-6.1,8.4,-4.3],[.4,8.4,-10],[-2.4,6.2,-16.3],[0,4,-1]] as const){const[x,z]=field.toGrid(p[0],p[2]);for(let yaw=0;yaw<Math.PI*2;yaw+=Math.PI/8)for(const pitch of [-1.1,-.5,0,.5,1.1]){rig.update(field.world,new THREE.Vector3(x,p[1]+1.55,z),yaw,pitch,false,1/60,p[1]+1.55);const c=camera.position;expect(scene.intersects([c.x-.219,c.y-.219,c.z-.219],[c.x+.219,c.y+.219,c.z+.219]),`${p.join(",")}: ${yaw},${pitch}`).toBe(false);}}
 });
 it("keeps the screen clear while rubbing exterior brick piers, doors and classroom walls",()=>{
  const{field,cameraScene}=setup();
  const points=[[-14.25,4.05,-.55],[-19,4.05,-1.1],[-4.4,4.05,.8],[-13.84,8.4,-8.2],[-7.45,8.4,-6.2],[-6.1,8.4,-6.2],[.4,8.4,-10.2],[-2.4,6.2,-16.35],[-2.4,4,-9.8],[0,4.05,-1]] as const;
  for(const p of points){
   const b=bodyAt(field,p);expect(canOccupy(field.world,b,1.8),`body at ${p.join(",")}`).toBe(true);
   for(const aspect of [9/16,21/9])for(const first of [false,true]){
    const camera=new THREE.PerspectiveCamera(70,aspect,.1,300),rig=new CraftCamera(camera);rig.firstPerson=first;
    for(let yaw=0;yaw<Math.PI*2;yaw+=Math.PI/12)for(const pitch of [-1.35,-.7,0,.7,1.35]){
     rig.update(field.world,new THREE.Vector3(b.x,b.y+1.55,b.z),yaw,pitch,false,1/60,b.y+1.55);
     camera.updateMatrixWorld(true);
     for(const x of [-1,1])for(const y of [-1,1]){
      const q=new THREE.Vector3(x,y,-1).unproject(camera);
      expect(cameraScene.intersects([q.x-.0001,q.y-.0001,q.z-.0001],[q.x+.0001,q.y+.0001,q.z+.0001]),`${p.join(",")}, aspect ${aspect}, first ${first}, yaw ${yaw}, pitch ${pitch}`).toBe(false);
     }
    }
   }
  }
 });
 it("attaches every exit sign to a real ceiling or landing and puts wall stations against the wall",()=>{
  const scene=new StaticScene(FIRE_CAMPUS.cameraBoxes,FIRE_CAMPUS.ramps);
  for(const sign of school.signs){const[x,,z]=sign.at;const m=sign.mount;
   const hit=scene.raycast([x,m.y+(m.kind==="ceiling"?-.02:.02),z],[0,m.kind==="ceiling"?1:-1,0],.05);
   expect(hit?.dist,`unsupported sign ${sign.at.join(",")}`).toBeCloseTo(.02,4);
  }
  for(const kind of ["alarm","phone"]){const s=school.stations.find(s=>s.kind===kind)!;
   const z=s.cell[2]+.5-.49;
   const hit=scene.raycast([s.cell[0]+.5,s.cell[1]+.5,z+.01],[0,0,-1],.03);
   expect(hit?.dist,`${kind} wall gap`).toBeCloseTo(.01,4);
  }
  const a=school.assembly;expect(scene.floorBelow(a.x,a.y!,a.z)).toBeCloseTo(a.y!,4);
 });

});
