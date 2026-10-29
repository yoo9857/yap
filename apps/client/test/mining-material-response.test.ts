import * as THREE from "three";
import {describe,it,expect} from "vitest";
import {fractureGeometry,MiningFracture} from "../src/craft/miningFracture.js";
import {miningResponse} from "../src/craft/miningResponse.js";
const make=()=>({geometry:new THREE.BoxGeometry(1,1,1),rotation:new THREE.Quaternion()});
const world={isBlocked:(_x:number,y:number,_z:number)=>y<0};
describe("material-specific physical mining response",()=>{
 it("splits logs into long vertical fibers and planks into long horizontal fibers while retaining their volume",()=>{
  for(const [key,axis] of [["oak-log","y"],["oak-planks","x"]] as const){
   const source=new THREE.BoxGeometry(1,1,1),pieces=fractureGeometry(source,1,12,miningResponse("wood",key));expect(pieces.length).toBe(8);expect(pieces.reduce((s,p)=>s+p.volume,0)).toBeCloseTo(1,5);
   const lengths=pieces.map(p=>{p.geometry.computeBoundingBox();const size=p.geometry.boundingBox!.getSize(new THREE.Vector3());return axis==="y"?size.y/Math.max(size.x,size.z):size.x/Math.max(size.y,size.z);});expect(lengths.reduce((a,b)=>a+b,0)/lengths.length).toBeGreaterThan(1.6);pieces.forEach(p=>p.geometry.dispose());source.dispose();
  }
 });
 it("dents the actual metal surface before opening seams or tearing, then bends plates outwards",()=>{
  const f=new MiningFracture(make(),"#d8dce0","metal",[0,0,0],13,"iron-block");f.setProgress(.5);expect(f.stats().pieces).toBe(6);expect(f.stats().loose).toBe(0);expect(f.stats().aperture).toBe(0);
  let dent=0;for(const p of f.pieces){const v=p.geometry.getAttribute("position"),n=p.geometry.getAttribute("normal");for(let i=0;i<v.count;i++){dent=Math.max(dent,p.rest[i*3+1]!-v.getY(i));expect(Number.isFinite(n.getX(i)+n.getY(i)+n.getZ(i))).toBe(true);}}
  expect(dent).toBeGreaterThan(.05);f.setProgress(.94);expect(f.pieces.some(p=>Math.abs(p.mesh.rotation.x)+Math.abs(p.mesh.rotation.z)>.05)).toBe(true);expect(f.stats().aperture).toBeGreaterThan(.015);expect(f.stats().loose).toBe(0);f.breakApart();expect(f.stats().loose).toBe(6);f.dispose();
 });
 it("compresses snow before crumbling and keeps its base anchored",()=>{
  const f=new MiningFracture(make(),"#ffffff","snow",[0,0,0],14);f.setProgress(.3);let low=Infinity,high=-Infinity;
  for(const p of f.pieces){const v=p.geometry.getAttribute("position");for(let i=0;i<v.count;i++){const y=v.getY(i)+p.mesh.position.y;low=Math.min(low,y);high=Math.max(high,y);}}
  expect(low).toBeCloseTo(-.5,2);expect(high).toBeLessThan(.49);expect(f.stats().loose).toBe(0);f.dispose();
 });
 it("keeps a falling rotated shard above the contact plane instead of burying its corners",()=>{
  const f=new MiningFracture(make(),"#9aa0a8","stone",[0,0,0],15);f.setProgress(.95);f.breakApart();
  for(let i=0;i<35;i++){f.update(1/60,world);for(const p of f.pieces){if(!p.mesh.visible)continue;const bounds=p.geometry.boundingBox!;for(let k=0;k<8;k++){const corner=new THREE.Vector3(k&1?bounds.max.x:bounds.min.x,k&2?bounds.max.y:bounds.min.y,k&4?bounds.max.z:bounds.min.z).multiply(p.mesh.scale).applyQuaternion(p.mesh.quaternion).add(p.mesh.position).add(f.root.position);expect(corner.y).toBeGreaterThanOrEqual(-1e-5);}}}f.dispose();
 });
});
