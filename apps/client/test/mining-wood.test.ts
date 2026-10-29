import * as THREE from "three";
import {describe,it,expect,vi} from "vitest";
import {MiningFracture} from "../src/craft/miningFracture.js";
const ground={isBlocked:(_x:number,y:number,_z:number)=>y<0};
const make=()=>({geometry:new THREE.BoxGeometry(1,1,1),rotation:new THREE.Quaternion()});
describe("refined wood splitting",()=>{
 it("extends the split down the grain while preserving the root and the position of the body",()=>{
  const f=new MiningFracture(make(),"#7a5230","wood",[0,0,0],0,"oak-log");f.setProgress(.16);let upper=0,lower=0;
  for(const p of f.pieces){expect(p.mesh.position.distanceTo(p.origin)).toBe(0);const v=p.geometry.getAttribute("position");for(let i=0;i<v.count;i++){const delta=Math.abs(v.getX(i)-p.rest[i*3]!)+Math.abs(v.getZ(i)-p.rest[i*3+2]!);if(delta>1e-6){if(v.getY(i)+p.origin.y>.25)upper++;if(v.getY(i)+p.origin.y<-.25)lower++;}}}
  expect(upper).toBeGreaterThan(0);expect(lower).toBe(0);f.setProgress(.6);let late=0;for(const p of f.pieces){const v=p.geometry.getAttribute("position");for(let i=0;i<v.count;i++)if(v.getY(i)+p.origin.y<-.1&&Math.abs(v.getX(i)-p.rest[i*3]!)+Math.abs(v.getZ(i)-p.rest[i*3+2]!)>1e-6)late++;}expect(late).toBeGreaterThan(0);f.dispose();
 });
 it("peels a thin real splinter before the major sections release",()=>{
  const f=new MiningFracture(make(),"#7a5230","wood",[0,0,0],0,"oak-log");f.setProgress(.72);const loose=f.pieces.filter(p=>p.loose);expect(loose).toHaveLength(1);expect(loose[0]!.volume).toBeLessThan(.07);expect(f.stats().visibleVolume).toBeGreaterThan(.9);f.dispose();
 });
 it("topples long splinters onto the contact plane before they fade, preserving the exact release pose",()=>{
  const f=new MiningFracture(make(),"#7a5230","wood",[0,0,0],0,"oak-log");f.setProgress(.95);const poses=f.pieces.map(p=>p.mesh.position.clone());f.breakApart();f.update(0,ground);f.pieces.forEach((p,i)=>expect(p.mesh.position.distanceTo(poses[i]!)).toBeCloseTo(0,10));
  for(let step=0;step<48;step++){f.update(1/60,ground);for(const p of f.pieces){if(!p.mesh.visible)continue;const bounds=p.geometry.boundingBox!;for(let c=0;c<8;c++){const v=new THREE.Vector3(c&1?bounds.max.x:bounds.min.x,c&2?bounds.max.y:bounds.min.y,c&4?bounds.max.z:bounds.min.z).multiply(p.mesh.scale).applyQuaternion(p.mesh.quaternion).add(p.mesh.position).add(f.root.position);expect(v.y).toBeGreaterThanOrEqual(-1e-5);}}}
  const tilt=f.pieces.filter(p=>p.mesh.visible).map(p=>Math.abs(new THREE.Vector3(0,1,0).applyQuaternion(p.mesh.quaternion).y));expect(tilt.reduce((a,b)=>a+b,0)/tilt.length).toBeLessThan(.55);
  for(let step=0;step<100;step++)f.update(1/60,ground);expect(f.stats().finished).toBe(true);f.dispose();
 });
 it("owns its brighter fresh fiber surface and releases only its own maps",()=>{
  const outside=new THREE.MeshStandardMaterial({color:"#7a5230"}),borrowed=new THREE.DataTexture(new Uint8Array(16).fill(255),2,2);outside.map=borrowed;const borrowedDispose=vi.spyOn(borrowed,"dispose"),f=new MiningFracture({...make(),materials:outside},"#7a5230","wood",[0,0,0],0,"oak-log"),materials=f.pieces[0]!.mesh.material as THREE.MeshStandardMaterial[],inside=materials[1]!;
  expect(inside.color.r).toBeGreaterThan(outside.color.r);expect(inside.color.g).toBeGreaterThan(outside.color.g);expect(inside.map).not.toBe(borrowed);const dispose=vi.spyOn(inside.map!,"dispose");f.dispose();expect(dispose).toHaveBeenCalledTimes(1);expect(borrowedDispose).not.toHaveBeenCalled();outside.dispose();borrowed.dispose();
 });
});

