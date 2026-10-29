import * as THREE from "three";
import {describe,it,expect,vi} from "vitest";
import {VoxelWorld} from "../src/craft/voxelWorld.js";
import {VoxelView} from "../src/craft/voxelView.js";
import {blockByKey} from "../src/craft/blocks.js";
import {SandSim,isLooseSand,type SandCell} from "../src/craft/sandSim.js";
vi.mock("../src/render/textures.js",()=>({loadTexture:()=>Promise.resolve(null)}));
function materialAt(scene:THREE.Scene,y:number):string {scene.updateMatrixWorld(true);const hit=new THREE.Raycaster(new THREE.Vector3(8.5,y,7),new THREE.Vector3(0,0,1)).intersectObjects(scene.children).find(h=>h.object instanceof THREE.Mesh)!;const mesh=hit.object as THREE.Mesh;return (Array.isArray(mesh.material)?mesh.material[hit.face?.materialIndex??0]!:mesh.material).name;}
describe("terrain layers",()=>{
 it("draws buried grass as soil while retaining only the exposed top grass in both render distances",()=>{
  const world=new VoxelWorld(),scene=new THREE.Scene(),view=new VoxelView(scene,{catalogTextures:false});for(const y of [1,2,3])world.setShaped(8,y,8,1,18);view.update(world);
  expect(materialAt(scene,1.9)).toContain("dirt");expect(materialAt(scene,2.9)).toContain("dirt");expect(materialAt(scene,3.96)).toContain("grass");expect(world.get(8,1,8)).toBe(1);
  for(let i=0;i<20;i++)view.update(world,new THREE.Vector3(90,4,8));expect(materialAt(scene,1.9)).toContain("dirt");expect(materialAt(scene,2.9)).toContain("dirt");view.dispose();
 });
 it("keeps a vertical dirt join flush and restores grass when the covering block is removed",()=>{
  const world=new VoxelWorld(),scene=new THREE.Scene(),view=new VoxelView(scene,{catalogTextures:false});world.setShaped(8,1,8,1,18);world.setShaped(8,2,8,2,18);view.update(world);
  for(const y of [1.999,2,2.001]){scene.updateMatrixWorld(true);const hits=new THREE.Raycaster(new THREE.Vector3(8.5,y,7),new THREE.Vector3(0,0,1)).intersectObjects(scene.children);expect(hits[0]!.point.z).toBeCloseTo(8.01,4);}
  expect(materialAt(scene,1.96)).toContain("dirt");world.set(8,2,8,0);view.markCellDirty(8,2,8);view.update(world);expect(materialAt(scene,1.96)).toContain("grass");view.dispose();
 });
});
function setup(){const world=new VoxelWorld(),scene=new THREE.Scene(),material=new THREE.MeshStandardMaterial(),hidden:SandCell[][]=[];const sim=new SandSim(world,{scene,shape:()=>({geometry:new THREE.BoxGeometry(1,1,1),rotation:new THREE.Quaternion(),materials:[material]}),write:(x,y,z,b,s)=>{world.setShaped(x,y,z,b,s);sim.touch(x,y,z);},hidden:cells=>hidden.push([...cells])});return {world,scene,material,sim,hidden};}
const sand=blockByKey("sand")!.id,red=blockByKey("red-sand")!.id;
const count=(world:VoxelWorld)=>world.cells.reduce((sum,id)=>sum+(id===sand||id===red?1:0),0);
describe("loose sand support and falling motion",()=>{
 it("falls continuously, preserves every logical block and settles at the support without tunnelling",()=>{
  const {world,scene,material,sim}=setup();world.set(8,0,8,3);world.setShaped(8,5,8,sand,18);sim.wakeAll();sim.update(1/60);const mesh=scene.children[0] as THREE.Mesh;const first=mesh.position.y;sim.update(1/60);expect(mesh.position.y).toBeLessThan(first);expect(first-mesh.position.y).toBeLessThan(.01);
  for(let i=0;i<180;i++){sim.update(1/60);expect(count(world)).toBe(1);}expect(world.get(8,1,8)).toBe(sand);expect(world.getShape(8,1,8)).toBe(18);expect(sim.stats().falling).toBe(0);expect(scene.children).toHaveLength(0);sim.dispose();material.dispose();
 });
 it("collapses a stack after support removal and preserves sand order",()=>{
  const {world,material,sim}=setup();world.set(8,0,8,3);world.set(8,1,8,3);world.setShaped(8,2,8,sand,18);world.setShaped(8,3,8,red,18);sim.wakeAll();sim.update(.05);expect(sim.stats().falling).toBe(0);world.set(8,1,8,0);sim.touch(8,1,8);
  for(let i=0;i<160;i++){sim.update(1/60);expect(count(world)).toBe(2);}expect(world.get(8,1,8)).toBe(sand);expect(world.get(8,2,8)).toBe(red);sim.dispose();material.dispose();
 });
 it("keeps sandstone and shaped solid pieces fixed, and respects a furniture support",()=>{
  expect(isLooseSand(blockByKey("sandstone")!.id,18)).toBe(false);expect(isLooseSand(sand,19)).toBe(false);
  const {world,material,sim}=setup();world.propSolid=(x,y,z)=>x===8&&y===1&&z===8;world.set(8,4,8,sand);sim.wakeAll();for(let i=0;i<160;i++)sim.update(1/60);expect(world.get(8,2,8)).toBe(sand);sim.dispose();material.dispose();
 });
 it("clears moving visuals without losing the saved logical sand or disposing borrowed materials",()=>{
  const {world,scene,material,sim,hidden}=setup(),dispose=vi.spyOn(material,"dispose");world.set(8,0,8,3);world.set(8,5,8,sand);sim.wakeAll();for(let i=0;i<12;i++)sim.update(1/60);expect(scene.children.length).toBeGreaterThan(0);sim.clear();expect(count(world)).toBe(1);expect(hidden.at(-1)).toEqual([]);expect(dispose).not.toHaveBeenCalled();sim.wakeAll();for(let i=0;i<160;i++)sim.update(1/60);expect(world.get(8,1,8)).toBe(sand);sim.dispose();material.dispose();
 });
 it("waits above an actor and resumes when the actor leaves without requiring another edit",()=>{
  const world=new VoxelWorld(),scene=new THREE.Scene(),material=new THREE.MeshStandardMaterial();let occupied=true;
  const sim=new SandSim(world,{scene,shape:()=>({geometry:new THREE.BoxGeometry(1,1,1),rotation:new THREE.Quaternion(),materials:[material]}),write:(x,y,z,b,s)=>{world.setShaped(x,y,z,b,s);sim.touch(x,y,z);},hidden:()=>{},canEnter:()=>!occupied});world.set(8,0,8,3);world.set(8,4,8,sand);sim.wakeAll();for(let i=0;i<10;i++)sim.update(1/60);expect(scene.children).toHaveLength(0);expect(world.get(8,4,8)).toBe(sand);
  occupied=false;for(let i=0;i<160;i++)sim.update(1/60);expect(world.get(8,1,8)).toBe(sand);sim.dispose();material.dispose();
 });

});
