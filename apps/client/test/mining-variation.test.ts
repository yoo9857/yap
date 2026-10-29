import * as THREE from "three";
import {describe,it,expect,vi} from "vitest";
import {fractureGeometry,MiningFracture} from "../src/craft/miningFracture.js";
import {fractureVariant,FRACTURE_VARIANTS} from "../src/craft/fractureVariation.js";
import {miningResponse} from "../src/craft/miningResponse.js";
import {MiningEffects} from "../src/craft/miningEffects.js";
import {cutRequest,type FractureRequest,type FractureReply} from "../src/craft/fractureJobs.js";
import {blockByKey} from "../src/craft/blocks.js";
const make=()=>({geometry:new THREE.BoxGeometry(1,1,1),rotation:new THREE.Quaternion()});
const signature=(f:MiningFracture)=>f.pieces.map(p=>[p.volume,...p.center.toArray(),...Array.from(p.geometry.getAttribute("position").array).slice(0,18)]);
describe("varied but continuous mining fractures",()=>{
 it("gives neighbouring blocks diverse stable patterns, including negative coordinates",()=>{
  const seeds=new Set(Array.from({length:96},(_,i)=>fractureVariant([i-48,3,7],3,18).seed));
  expect(seeds.size).toBeGreaterThan(24);expect(seeds.size).toBeLessThanOrEqual(FRACTURE_VARIANTS);
  const cell=[-91,7,143] as const;expect(fractureVariant(cell,3,18)).toEqual(fractureVariant(cell,3,18));
  expect(new Set(Array.from({length:FRACTURE_VARIANTS},(_,salt)=>fractureVariant(cell,3,18,salt).seed)).size).toBe(FRACTURE_VARIANTS);
 });
 it("varies stone fragment count and sizes while preserving the whole source volume",()=>{
  const counts=new Set<number>(),forms=new Set<string>();
  for(let variant=0;variant<8;variant++){
   const g=new THREE.BoxGeometry(1,1,1),seed=fractureVariant([variant,1,5],3,18).seed,pieces=fractureGeometry(g,6,seed),volumes=pieces.map(p=>p.volume);
   expect(pieces.length).toBeGreaterThanOrEqual(12);expect(pieces.length).toBeLessThanOrEqual(20);
   expect(volumes.reduce((a,b)=>a+b,0)).toBeCloseTo(1,5);expect(Math.max(...volumes)/Math.min(...volumes)).toBeGreaterThan(2.5);
   counts.add(pieces.length);forms.add(JSON.stringify(volumes));pieces.forEach(p=>p.geometry.dispose());g.dispose();
  }
  expect(counts.size).toBeGreaterThan(2);expect(forms.size).toBeGreaterThan(5);
 });
 it("changes wood section widths while retaining long fibers and complementary volume",()=>{
  const forms=new Set<string>();
  for(const key of ["oak-log","oak-planks"])for(const seed of [19,2401,7193]){
   const g=new THREE.BoxGeometry(1,1,1),pieces=fractureGeometry(g,6,seed,miningResponse("wood",key));
   expect(pieces.reduce((sum,p)=>sum+p.volume,0)).toBeCloseTo(1,5);
   const lengths=pieces.map(p=>{const size=p.geometry.boundingBox!.getSize(new THREE.Vector3());return key==="oak-log"?size.y/Math.max(size.x,size.z):size.x/Math.max(size.y,size.z);});
   expect(lengths.reduce((a,b)=>a+b,0)/lengths.length).toBeGreaterThan(1.4);
   forms.add(JSON.stringify(pieces.map(p=>p.volume)));pieces.forEach(p=>p.geometry.dispose());g.dispose();
  }
  expect(forms.size).toBe(6);
 });
 it("reconstructs the same seeded mesh and never jumps when varied shards collapse",()=>{
  const ground={isBlocked:(_x:number,y:number,_z:number)=>y<0};
  for(const [family,key] of [["stone","stone"],["wood","oak-log"]])for(const seed of [19,2401]){
   const f=new MiningFracture(make(),"#999999",family!,[0,1,0],seed,key),copy=new MiningFracture(make(),"#999999",family!,[0,1,0],seed,key);
   expect(signature(f)).toEqual(signature(copy));copy.dispose();f.setProgress(.94);
   const poses=f.pieces.map(p=>({position:p.mesh.position.clone(),quaternion:p.mesh.quaternion.clone(),geometry:p.geometry}));f.breakApart();f.update(0,ground);
   f.pieces.forEach((p,i)=>{expect(p.mesh.position.distanceTo(poses[i]!.position)).toBe(0);expect(p.mesh.quaternion.angleTo(poses[i]!.quaternion)).toBeCloseTo(0,6);expect(p.geometry).toBe(poses[i]!.geometry);});f.dispose();
  }
 });
 it("retains a coordinate's pattern after cache eviction without growing the template cache",()=>{
  const fx=new MiningEffects(new THREE.Scene()),def=blockByKey("stone")!,seen=new Set<number>(),cells:[number,number,number][]=[];
  for(let x=0;cells.length<12;x++){const cell:[number,number,number]=[x,1,3],v=fractureVariant(cell,def.id,0).variant;if(seen.has(v))continue;seen.add(v);cells.push(cell);}
  const capture=()=>{const group=fx.root.children.filter(o=>o.name==="Geometric mining fracture").at(-1)!;return group.children.map(o=>{const mesh=o as THREE.Mesh;return [...mesh.position.toArray(),...Array.from(mesh.geometry.getAttribute("position").array).slice(0,24)];});};
  fx.setProgress(cells[0]!,def,0,.45,make);const first=capture();fx.clearTarget();
  for(const cell of cells.slice(1)){fx.setProgress(cell,def,0,.45,make);fx.clearTarget();}
  expect(fx.stats().templates.templates).toBeLessThanOrEqual(8);fx.setProgress(cells[0]!,def,0,.45,make);expect(capture()).toEqual(first);fx.dispose();
 });
 it("starts a worker-completed cut while paused without requiring another progress input",()=>{
  const workers:DeferredWorker[]=[];let request:FractureRequest|undefined;
  class DeferredWorker {
   onmessage:((event:MessageEvent<FractureReply>)=>void)|null=null;onerror:(()=>void)|null=null;
   constructor(){workers.push(this);}
   postMessage(value:FractureRequest):void {request=value;}
   terminate():void {}
  }
  vi.stubGlobal("Worker",DeferredWorker);
  const hidden=vi.fn(),fx=new MiningEffects(new THREE.Scene(),hidden);
  try{
   fx.setProgress([1,1,1],blockByKey("stone")!,0,.72,make);expect(fx.stats().waiting).toBe(true);expect(hidden).not.toHaveBeenCalled();
   workers[0]!.onmessage!({data:{id:request!.id,ok:true,pieces:cutRequest(request!),ms:1}} as MessageEvent<FractureReply>);
   fx.update(0,{isBlocked:()=>false});expect(fx.stats().waiting).toBe(false);expect(fx.stats().geometry!.pieces).toBeGreaterThan(0);expect(hidden).toHaveBeenLastCalledWith([1,1,1]);
  }finally{fx.dispose();vi.unstubAllGlobals();}
 });

});
