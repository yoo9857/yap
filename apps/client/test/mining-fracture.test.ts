import * as THREE from "three";
import {describe,it,expect,vi} from "vitest";
import {fractureGeometry,MiningFracture} from "../src/craft/miningFracture.js";
import {MiningEffects} from "../src/craft/miningEffects.js";
import {blockByKey} from "../src/craft/blocks.js";
import {kitRampGeometry,kitCubeGeometry,kitCellsGeometry} from "../src/craft/kitGeometry.js";
import {VoxelView} from "../src/craft/voxelView.js";
import {VoxelWorld} from "../src/craft/voxelWorld.js";
vi.mock("../src/render/textures.js",()=>({loadTexture:()=>Promise.resolve(null)}));
const ground={isBlocked:(_x:number,y:number,_z:number)=>y<0};
const make=()=>({geometry:new THREE.BoxGeometry(1,1,1),rotation:new THREE.Quaternion()});
describe("geometric mining fractures",()=>{
 it("partitions the original volume into complementary irregular closed shards with interior faces",()=>{
  const source=new THREE.BoxGeometry(1,1,1),pieces=fractureGeometry(source,6);
  expect(pieces.length).toBeGreaterThanOrEqual(12);expect(pieces.length).toBeLessThanOrEqual(20);expect(pieces.reduce((sum,p)=>sum+p.volume,0)).toBeCloseTo(1,5);
  for(const p of pieces){expect(p.geometry.groups.some(g=>g.materialIndex===6)).toBe(true);expect(p.geometry.getAttribute("uv").count).toBe(p.geometry.getAttribute("position").count);const vertices=p.geometry.getAttribute("position"),normals=p.geometry.getAttribute("normal");
   for(let i=0;i<vertices.count;i+=3){const a=new THREE.Vector3().fromBufferAttribute(vertices,i),b=new THREE.Vector3().fromBufferAttribute(vertices,i+1),c=new THREE.Vector3().fromBufferAttribute(vertices,i+2),face=b.sub(a).cross(c.sub(a));if(face.lengthSq()>1e-12)expect(face.normalize().dot(new THREE.Vector3().fromBufferAttribute(normals,i))).toBeGreaterThan(.98);}
   p.geometry.dispose();
  }source.dispose();
 });
 it("retains ramp empty space and its exact source volume instead of replacing it with cubes",()=>{
  const source=kitRampGeometry(false,0,false),pieces=fractureGeometry(source,1),positions=source.getAttribute("position");let original=0;
  for(let i=0;i<positions.count;i+=3){const a=new THREE.Vector3().fromBufferAttribute(positions,i),b=new THREE.Vector3().fromBufferAttribute(positions,i+1),c=new THREE.Vector3().fromBufferAttribute(positions,i+2);original+=a.dot(b.cross(c))/6;}
  expect(pieces.reduce((sum,p)=>sum+p.volume,0)).toBeCloseTo(Math.abs(original),5);
  for(const p of pieces){const v=p.geometry.getAttribute("position");for(let i=0;i<v.count;i++){const y=v.getY(i)+p.center.y,z=v.getZ(i)+p.center.z;expect(y).toBeLessThanOrEqual(-z+1e-5);}p.geometry.dispose();}source.dispose();
 });
 it("widens real seams continuously and removes corner volume at successive stages",()=>{
  const f=new MiningFracture(make(),"#a27d62","dirt",[0,0,0],17);
  f.setProgress(.2);const early=f.stats();f.setProgress(.5);const middle=f.stats();f.setProgress(.9);const late=f.stats();
  expect(early.loose).toBe(0);expect(middle.loose).toBe(1);expect(late.loose).toBe(2);expect(early.aperture).toBeLessThan(middle.aperture);expect(middle.aperture).toBeLessThan(late.aperture);expect(early.visibleVolume).toBeGreaterThan(middle.visibleVolume);expect(middle.visibleVolume).toBeGreaterThan(late.visibleVolume);
  expect(late.aperture).toBeLessThan(.025);f.dispose();
 });
 it("continues the same shard geometry and poses into collapse without a teleport or initial explosion",()=>{
  const f=new MiningFracture(make(),"#a27d62","dirt",[0,2,0],19);f.setProgress(.94);f.update(.07,ground);
  const poses=f.pieces.map(p=>({position:p.mesh.position.clone(),rotation:p.mesh.quaternion.clone(),geometry:p.geometry}));f.breakApart();f.update(0,ground);
  f.pieces.forEach((p,i)=>{expect(p.mesh.position.distanceTo(poses[i]!.position)).toBe(0);expect(p.mesh.quaternion.angleTo(poses[i]!.rotation)).toBeCloseTo(0,6);expect(p.geometry).toBe(poses[i]!.geometry);});
  const heights=f.pieces.map(p=>p.mesh.position.y);for(let i=0;i<8;i++)f.update(.02,ground);expect(f.pieces.some((p,i)=>p.mesh.position.y<heights[i]!-.01)).toBe(true);
  for(let i=0;i<80;i++)f.update(.02,ground);expect(f.stats().finished).toBe(true);f.dispose();
 });
 it("restores the intact renderer on cancel and bounds retained fracture meshes",()=>{
  const scene=new THREE.Scene(),hidden=vi.fn(),fx=new MiningEffects(scene,hidden),def=blockByKey("dirt")!;
  fx.setProgress([1,1,1],def,0,.6,make);expect(hidden).toHaveBeenLastCalledWith([1,1,1]);fx.clearTarget();expect(hidden).toHaveBeenLastCalledWith(null);
  for(let i=0;i<10;i++){fx.setProgress([i,1,1],def,0,.85,make);fx.burst([i,1,1],def,0);}expect(fx.stats().fractures).toBeLessThanOrEqual(4);
  for(let i=0;i<100;i++)fx.update(.02,ground);expect(fx.stats().fractures).toBe(0);fx.dispose();
 });
 it("never disposes exterior materials owned by the terrain",()=>{
  const material=new THREE.MeshStandardMaterial(),dispose=vi.spyOn(material,"dispose"),model={...make(),materials:material},f=new MiningFracture(model,"#a27d62","dirt",[0,0,0],9);f.dispose();expect(dispose).not.toHaveBeenCalled();material.dispose();
 });
 it("masks a merged construction block immediately, restores it on cancel and leaves world collision intact",()=>{
  const scene=new THREE.Scene(),view=new VoxelView(scene),world=new VoxelWorld(),def=blockByKey("dirt")!,cell=[16,1,16] as const;
  world.setShaped(...cell,def.id,18);const shape=view.miningShape(18,def.id,cell,world);expect(shape.geometry.getAttribute("position").count).toBeGreaterThan(0);shape.geometry.dispose();view.update(world);const count=()=>scene.children.filter(o=>o instanceof THREE.InstancedMesh&&o.count>0).length;const intact=count();expect(intact).toBeGreaterThan(0);
  view.setMiningHidden(cell);view.update(world);expect(count()).toBeLessThan(intact);expect(world.get(...cell)).toBe(def.id);expect(world.isBlocked(...cell)).toBe(true);
  view.setMiningHidden(null);view.update(world);expect(count()).toBe(intact);view.dispose();
 });
 it("retains a moulded construction shell's volume through cutting",()=>{
  const source=kitCubeGeometry(),p=source.getAttribute("position"),index=source.index;let volume=0;
  for(let i=0;i<(index?.count??p.count);i+=3){const ids=[0,1,2].map(j=>index?index.getX(i+j):i+j),a=new THREE.Vector3().fromBufferAttribute(p,ids[0]!),b=new THREE.Vector3().fromBufferAttribute(p,ids[1]!),c=new THREE.Vector3().fromBufferAttribute(p,ids[2]!);volume+=a.dot(b.cross(c))/6;}
  const pieces=fractureGeometry(source,1);expect(pieces.reduce((s,p)=>s+p.volume,0)).toBeCloseTo(Math.abs(volume),5);pieces.forEach(p=>p.geometry.dispose());source.dispose();
 });
 it("preserves the closed top pad and body outlines without bridging their surrounding air",()=>{
  const source=kitCellsGeometry([[0,0,0]]);source.translate(-.5,-.5,-.5);const pieces=fractureGeometry(source,1),material=new THREE.MeshBasicMaterial({side:THREE.DoubleSide}),original=new THREE.Mesh(source,material),shards=pieces.map(p=>{const m=new THREE.Mesh(p.geometry,[material,material]);m.position.copy(p.center);m.updateMatrixWorld(true);return m;});original.updateMatrixWorld(true);const ray=new THREE.Raycaster();
  for(const axis of ["x","y","z"] as const)for(let a=0;a<9;a++)for(let b=0;b<9;b++){
   const origin=new THREE.Vector3((a+.37)/9-.5,2,(b+.63)/9-.5),direction=new THREE.Vector3(0,-1,0);if(axis==="x"){origin.set(2,(a+.37)/9-.5,(b+.63)/9-.5);direction.set(-1,0,0);}if(axis==="z"){origin.set((a+.37)/9-.5,(b+.63)/9-.5,2);direction.set(0,0,-1);}ray.set(origin,direction);
   const expected=ray.intersectObject(original)[0]?.distance,actual=ray.intersectObjects(shards)[0]?.distance;if(expected===undefined)expect(actual).toBeUndefined();else expect(actual).toBeCloseTo(expected,4);
  }
  pieces.forEach(p=>p.geometry.dispose());source.dispose();material.dispose();
 });

 it("grows localized seams without translating or inflating the intact body",()=>{
  const f=new MiningFracture(make(),"#9aa0a8","stone",[0,0,0],0);f.setProgress(.12);
  const countLower=()=>f.pieces.filter(p=>!p.loose).reduce((sum,p)=>{const v=p.geometry.getAttribute("position");for(let i=0;i<v.count;i++)if(p.rest[i*3+1]!+p.origin.y<-.15&&Math.abs(v.getX(i)-p.rest[i*3]!)>1e-5)sum++;return sum;},0);
  const early=countLower();f.setProgress(.75);expect(countLower()).toBeGreaterThan(early);
  for(const p of f.pieces){if(p.loose)continue;expect(p.mesh.position.distanceTo(p.origin)).toBe(0);const v=p.geometry.getAttribute("position");for(let i=0;i<v.count;i++){expect(Math.abs(v.getX(i)+p.origin.x)).toBeLessThanOrEqual(.50001);expect(Math.abs(v.getZ(i)+p.origin.z)).toBeLessThanOrEqual(.50001);}}
  f.dispose();
 });

});
