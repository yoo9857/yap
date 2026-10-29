import * as THREE from "three";
import {LOW_ASSEMBLY_BUMP_HEIGHT} from "../src/craft/lowAssemblyBump.js";
import {describe,it,expect} from "vitest";
import {connectedNaturalWorld,naturalNeighbourMasks,type NaturalWorldCell} from "../src/craft/connectedNaturalGeometry.js";
const cell=(x:number,y:number,z:number,key:NaturalWorldCell["key"]="dirt"):NaturalWorldCell=>({x,y,z,key});
const axes:readonly (readonly [number,number,number])[]=[[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]];
describe("six-direction natural block connections",()=>{
 it("removes the internal face on every side including above and below",()=>{
  for(const [i,d] of axes.entries()){const cells=[cell(0,0,0),cell(...d)],world=connectedNaturalWorld(cells,5),mesh=new THREE.Mesh(world.geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.updateMatrixWorld(true);
   expect(naturalNeighbourMasks(cells)[0]).toBe(1<<i);
   const ray=new THREE.Raycaster(new THREE.Vector3(.5,.5,.5),new THREE.Vector3(...d));const hit=ray.intersectObject(mesh)[0]!;
   expect(hit.distance).toBeCloseTo(1.5,4);expect(world.geometry.userData.internal_faces).toBe(false);const p=world.geometry.getAttribute("position"),edges=new Map<string,number>(),vertex=(v:number)=>[p.getX(v),p.getY(v),p.getZ(v)].map(n=>Math.round(n*1e6)).join(",");
   for(let j=0;j<p.count;j+=3)for(let k=0;k<3;k++){const e=[vertex(j+k),vertex(j+(k+1)%3)].sort().join("/");edges.set(e,(edges.get(e)??0)+1);}
   expect([...edges.values()].filter(n=>n!==2)).toHaveLength(0);
   world.geometry.dispose();(mesh.material as THREE.Material).dispose();
  }
 });
 it("keeps a staircase, inside corner and mixed material stack connected",()=>{
  const cells=[cell(0,0,0,"grass"),cell(1,0,0,"grass"),cell(1,1,0,"grass"),cell(1,0,1,"dirt"),cell(0,0,1,"snow")],result=connectedNaturalWorld(cells,5);
  expect(result.slots.some(s=>s.key==="grass"&&s.face===0)).toBe(true);expect(result.slots.some(s=>s.key==="grass"&&s.face===2)).toBe(true);
  for(const attr of Object.values(result.geometry.attributes))expect([...attr.array].every(Number.isFinite)).toBe(true);
  expect(result.geometry.boundingBox!.min.y).toBeCloseTo(0);expect(result.geometry.boundingBox!.max.y).toBeCloseTo(2+LOW_ASSEMBLY_BUMP_HEIGHT);
  result.geometry.dispose();
 });
 it("does not create a middle turf band in a vertical grass column",()=>{
  const result=connectedNaturalWorld([cell(0,0,0,"grass"),cell(0,1,0,"grass"),cell(0,2,0,"grass")],5),p=result.geometry.getAttribute("position"),index=result.geometry.index!;
  for(const group of result.geometry.groups){const slot=result.slots[group.materialIndex!]!;if(slot.face!==0)continue;
   for(let i=group.start;i<group.start+group.count;i++)expect(p.getY(index.getX(i))).toBeGreaterThan(2.7);
  }
  expect(result.geometry.userData.cosmetic_bumps).toBe(1);expect(result.geometry.getAttribute("position").count).toBeLessThan(12000);result.geometry.dispose();
 });
});

