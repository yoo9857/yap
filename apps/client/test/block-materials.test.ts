import * as THREE from "three";
import {describe,it,expect,vi} from "vitest";
import {surfaceStyle,BlockMaterialLibrary,createMaterialMaps,materialFaceGroups} from "../src/craft/blockMaterials.js";
import {kitFootprintGeometry} from "../src/craft/kitGeometry.js";
import {BlockKitModels,PIECES} from "../src/craft/blockKitModels.js";
import {VoxelView} from "../src/craft/voxelView.js";
import {VoxelWorld} from "../src/craft/voxelWorld.js";
vi.mock("../src/render/textures.js",()=>({loadTexture:()=>Promise.resolve(null)}));
describe("playable block materials",()=>{
 it("gives snow, soil, grass and gems distinct colour, relief and reflection",()=>{
  const lib=new BlockMaterialLibrary(),snow=lib.get("snow")[0]!,grass=lib.get("grass"),dirt=lib.get("dirt")[0]!,gem=lib.get("diamond-block")[0]!;
  expect(grass).toHaveLength(3);expect(new Set([snow.map,grass[0]!.map,grass[1]!.map,dirt.map,gem.map]).size).toBe(5);
  expect(snow.roughness).toBeGreaterThan(.9);expect(dirt.roughness).toBeGreaterThan(.9);expect(gem.roughness).toBeLessThan(.3);
  expect(gem.clearcoat).toBeGreaterThan(.7);expect(dirt.normalScale.x).toBeGreaterThan(gem.normalScale.x);
  expect(grass[0]!.normalMap).not.toBe(grass[1]!.normalMap);
  const g=materialFaceGroups(kitFootprintGeometry([[0,0]])),n=g.getAttribute("normal"),idx=g.index!;
  expect(g.groups).toHaveLength(3);for(const group of g.groups)for(let i=group.start;i<group.start+group.count;i+=3){
   const y=(n.getY(idx.getX(i))+n.getY(idx.getX(i+1))+n.getY(idx.getX(i+2)))/3;
   if(group.materialIndex===0)expect(y).toBeGreaterThan(.52);if(group.materialIndex===2)expect(y).toBeLessThan(-.52);
  }
  g.dispose();lib.dispose();
 });
 it("covers catalog material families without treating them as the same coating",()=>{
  expect(["snow","grass","dirt","diamond-block","ruby-ore","oak-log","red-wool","sand","gold-block","ice","stone"].map(k=>surfaceStyle(k).family)).toEqual(["snow","grass","dirt","gem","ore","wood","wool","sand","metal","glass","stone"]);
  const snow=createMaterialMaps("snow",32),dirt=createMaterialMaps("dirt",32);
  expect(snow.map.colorSpace).toBe(THREE.SRGBColorSpace);expect(dirt.normal.colorSpace).toBe(THREE.NoColorSpace);
  expect([...new Uint8Array(snow.map.image.data.buffer)]).not.toEqual([...new Uint8Array(dirt.map.image.data.buffer)]);
  for(const maps of [snow,dirt])for(const t of [maps.map,maps.normal,maps.roughness])t.dispose();
 });
 it("uses separate grass faces in both actual near and far game geometry",()=>{
  const world=new VoxelWorld();world.setShaped(8,2,8,1,18);const scene=new THREE.Scene(),view=new VoxelView(scene);view.update(world);
  const near=scene.children.find(o=>o instanceof THREE.InstancedMesh&&Array.isArray(o.material)) as THREE.InstancedMesh<THREE.BufferGeometry,THREE.Material[]>|undefined;
  expect(near).toBeDefined();expect(near!.material).toHaveLength(3);expect(near!.geometry.groups).toHaveLength(3);
  for(let i=0;i<15;i++)view.update(world,new THREE.Vector3(90,4,8));
  const far=scene.children.find(o=>o instanceof THREE.Mesh&&!(o instanceof THREE.InstancedMesh)&&Array.isArray(o.material)) as THREE.Mesh<THREE.BufferGeometry,THREE.Material[]>|undefined;
  expect(far).toBeDefined();expect(new Set(far!.geometry.groups.map(g=>g.materialIndex)).size).toBe(3);
  const keys=far!.geometry.groups.map(g=>(far!.material[g.materialIndex!] as THREE.MeshPhysicalMaterial).name);
  expect(keys.some(k=>k.includes("grass-side"))).toBe(true);view.dispose();
 });
 it("can export the same construction geometry with each gameplay material",()=>{
  const lib=new BlockKitModels(),piece=PIECES[0]!;
  for(const key of ["snow","grass","dirt","diamond-block"]){const group=lib.build(piece,0,0,key);expect(group.userData.surface).toBe(key);const mesh=group.children[0] as THREE.Mesh;expect(Array.isArray(mesh.material)).toBe(key==="grass");}
  lib.dispose();
 });
});

