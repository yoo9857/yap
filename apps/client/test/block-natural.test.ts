import * as THREE from "three";
import {LOW_ASSEMBLY_BUMP_HEIGHT} from "../src/craft/lowAssemblyBump.js";
import {describe,it,expect} from "vitest";
import {naturalCellsGeometry,type NaturalBlockKey} from "../src/craft/naturalBlockGeometry.js";
import {BlockKitModels,PIECES} from "../src/craft/blockKitModels.js";
const keys:NaturalBlockKey[]=["snow","grass","dirt","diamond-block"];
function ray(g:THREE.BufferGeometry,x:number,z:number):number|undefined{const m=new THREE.Mesh(g,new THREE.MeshBasicMaterial());m.updateMatrixWorld(true);const hit=new THREE.Raycaster(new THREE.Vector3(x,3,z),new THREE.Vector3(0,-1,0)).intersectObject(m)[0];(m.material as THREE.Material).dispose();return hit?.point.y;}
describe("natural block silhouettes",()=>{
 it("has an upright flat stacking surface inside the cell with only a low cosmetic bump",()=>{
  for(const key of keys){const g=naturalCellsGeometry([[0,0,0]],key);expect(ray(g,.5,.5)).toBeCloseTo(1,5);expect(ray(g,.25,.25)).toBeCloseTo(1+LOW_ASSEMBLY_BUMP_HEIGHT,5);
   expect(g.boundingBox!.min.y).toBeCloseTo(0);expect(g.boundingBox!.max.y).toBeCloseTo(1+LOW_ASSEMBLY_BUMP_HEIGHT);
   expect(g.boundingBox!.min.x).toBeGreaterThanOrEqual(0);expect(g.boundingBox!.max.x).toBeLessThanOrEqual(1);
   for(const attr of Object.values(g.attributes))expect([...attr.array].every(Number.isFinite)).toBe(true);
   const p=g.getAttribute("position"),counts=new Map<string,number>();const id=(i:number)=>[p.getX(i),p.getY(i),p.getZ(i)].map(n=>Math.round(n*1e6)).join(",");
   for(let i=0;i<p.count;i+=3)for(let j=0;j<3;j++){const edge=[id(i+j),id(i+(j+1)%3)].sort().join("/");counts.set(edge,(counts.get(edge)??0)+1);}
   expect([...counts.values()].every(n=>n===2)).toBe(true);g.dispose();
  }
 });
 it("gives grass a real uneven turf edge and keeps a courtyard open",()=>{
  const cells=[[0,0,0],[1,0,0],[2,0,0],[0,0,1],[2,0,1],[0,0,2],[1,0,2],[2,0,2]] as const;
  const g=naturalCellsGeometry(cells,"grass");expect(ray(g,1.5,1.5)).toBeUndefined();expect(ray(g,.25,.25)).toBeCloseTo(1+LOW_ASSEMBLY_BUMP_HEIGHT);
  expect(g.groups.map(group=>group.materialIndex)).toEqual([0,2]);const p=g.getAttribute("position"),heights=new Set<number>();
  for(let i=0;i<p.count;i++)if(p.getY(i)>.72&&p.getY(i)<.87)heights.add(Math.round(p.getY(i)*1000));
  expect(heights.size).toBeGreaterThan(4);g.dispose();
 });
 it("uses material-specific contours, restrained deterministic variants and a consistent kit comparison",()=>{
  const snow=naturalCellsGeometry([[0,0,0]],"snow"),dirt=naturalCellsGeometry([[0,0,0]],"dirt"),other=naturalCellsGeometry([[0,0,0]],"dirt",1);
  expect(snow.getAttribute("position").array).not.toEqual(dirt.getAttribute("position").array);expect(dirt.getAttribute("position").array).not.toEqual(other.getAttribute("position").array);
  const natural=new BlockKitModels("nature"),kit=new BlockKitModels("kit");
  for(const key of keys){const n=natural.build(PIECES[0]!,0,0,key),k=kit.build(PIECES[0]!,0,0,key);expect(new THREE.Box3().setFromObject(n).max.y).toBeCloseTo(1+LOW_ASSEMBLY_BUMP_HEIGHT);expect(new THREE.Box3().setFromObject(k).max.y).toBeCloseTo(1+LOW_ASSEMBLY_BUMP_HEIGHT);}
  snow.dispose();dirt.dispose();other.dispose();natural.dispose();kit.dispose();
 });
});

