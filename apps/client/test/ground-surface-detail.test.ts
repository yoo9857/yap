import * as THREE from "three";
import {afterEach,describe,it,expect,vi} from "vitest";
import {createMaterialMaps,BlockMaterialLibrary} from "../src/craft/blockMaterials.js";
import {loadTexture} from "../src/render/textures.js";
import {VoxelView} from "../src/craft/voxelView.js";
import {VoxelWorld} from "../src/craft/voxelWorld.js";
import {SandSim} from "../src/craft/sandSim.js";
import {blockByKey} from "../src/craft/blocks.js";
vi.mock("../src/render/textures.js",()=>({loadTexture:vi.fn(()=>Promise.resolve(null))}));
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();});
function bytes(t:THREE.DataTexture):Uint8Array{return new Uint8Array(t.image.data.buffer,t.image.data.byteOffset,t.image.data.byteLength);}
describe("restrained ground surface detail",()=>{
 it("keeps soil variation subtle and avoids high-contrast raised circular stamps",()=>{
  const maps=createMaterialMaps("dirt"),colour=bytes(maps.map),normal=bytes(maps.normal),tones:number[]=[];let relief=0;
  for(let i=0;i<colour.length;i+=4){tones.push(colour[i]!);relief=Math.max(relief,Math.abs(normal[i]!-128),Math.abs(normal[i+1]!-128));}
  tones.sort((a,b)=>a-b);expect(tones[Math.floor(tones.length*.95)]!-tones[Math.floor(tones.length*.05)]!).toBeLessThan(22);expect(relief).toBeLessThan(9);expect(new Set(tones).size).toBeGreaterThan(9);
  [maps.map,maps.normal,maps.roughness].forEach(t=>t.dispose());
 });
 it("gives sand fine low-relief grains and a matte response distinct from soil",()=>{
  const lib=new BlockMaterialLibrary(),sand=lib.get("sand","#ecd9a0")[0]!,dirt=lib.get("dirt")[0]!;
  expect(sand.roughness).toBeGreaterThan(.96);expect(sand.clearcoat).toBe(0);expect(sand.normalScale.x).toBeLessThan(.35);expect(dirt.normalScale.x).toBeLessThan(.5);expect(sand.map).not.toBe(dirt.map);
  const pixels=bytes(sand.map as THREE.DataTexture),tones=new Set<number>();for(let i=0;i<pixels.length;i+=4)tones.add(pixels[i]!);expect(tones.size).toBeGreaterThan(4);expect(Math.max(...tones)-Math.min(...tones)).toBeLessThan(18);lib.dispose();
 });
 it("does not reload the old pebble surface in generated-asset review mode",async()=>{
  vi.stubGlobal("document",{});const lib=new BlockMaterialLibrary(true);lib.get("dirt");lib.get("grass");await Promise.resolve();
  const calls=vi.mocked(loadTexture).mock.calls.map(args=>args[0]);expect(calls).toHaveLength(3);expect(calls.every(url=>!url.includes("dirt")&&!url.includes("grass-side"))).toBe(true);lib.dispose();
 });
 it("passes the source cell to falling geometry so exposed studs survive the first falling frame",()=>{
  const world=new VoxelWorld(),scene=new THREE.Scene(),view=new VoxelView(scene,{catalogTextures:false}),sand=blockByKey("sand")!.id;
  world.setShaped(8,4,8,sand,18);world.set(8,0,8,3);const shape=vi.fn((block:number,code:number,cell:readonly [number,number,number])=>view.miningShape(code,block,cell,world));
  const sim=new SandSim(world,{scene,shape,write:(x,y,z,b,s)=>world.setShaped(x,y,z,b,s),hidden:cells=>view.setFallingHidden(cells)});sim.wakeAll();sim.update(1/60);expect(shape).toHaveBeenCalledWith(sand,18,[8,4,8]);
  const moving=scene.children.find(o=>o.name==="Falling loose sand") as THREE.Mesh;moving.geometry.computeBoundingBox();expect(moving.geometry.boundingBox!.max.y).toBeCloseTo(.54,5);sim.dispose();view.dispose();
 });
 it("restores the retained logical sand when the world window scrolls during a fall",()=>{
  const world=new VoxelWorld(),scene=new THREE.Scene(),view=new VoxelView(scene,{catalogTextures:false}),sand=blockByKey("sand")!.id;
  world.setShaped(40,2,40,sand,18);view.update(world);view.setFallingHidden([[40,2,40]]);view.update(world);
  world.set(40,2,40,0);world.setShaped(24,2,24,sand,18);view.shift(16,16);view.update(world);scene.updateMatrixWorld(true);
  const hit=new THREE.Raycaster(new THREE.Vector3(24.5,5,24.5),new THREE.Vector3(0,-1,0)).intersectObjects(scene.children).find(h=>h.object instanceof THREE.Mesh);expect(hit).toBeDefined();expect(hit!.point.y).toBeGreaterThanOrEqual(3);view.dispose();
 });

});
