import * as THREE from "three";
import {describe,it,expect,vi} from "vitest";
import {VoxelWorld} from "../src/craft/voxelWorld.js";
import {VoxelView} from "../src/craft/voxelView.js";
import {blockByKey} from "../src/craft/blocks.js";
import {kitSlopeShape} from "@robo/shared";
vi.mock("../src/render/textures.js",()=>({loadTexture:()=>Promise.resolve(null)}));
const wood=blockByKey("oak-log")!.id,stone=blockByKey("stone")!.id;
function hit(scene:THREE.Scene,x:number):THREE.Intersection|undefined {scene.updateMatrixWorld(true);return new THREE.Raycaster(new THREE.Vector3(x,1.5,7),new THREE.Vector3(0,0,1)).intersectObjects(scene.children).find(hit=>hit.object instanceof THREE.Mesh);}
describe("flush material-aware block neighbours",()=>{
 it("closes the edge gap between different opaque materials, including a chunk boundary",()=>{
  for(const x of [8,15]){const scene=new THREE.Scene(),world=new VoxelWorld(),view=new VoxelView(scene,{catalogTextures:false});world.setShaped(x,1,8,wood,18);world.setShaped(x+1,1,8,stone,18);view.update(world);
   for(const dx of [-.001,0,.001]){const intersection=hit(scene,x+1+dx);expect(intersection).toBeDefined();expect(intersection!.point.z).toBeCloseTo(8.01,4);}view.dispose();}
 });
 it("restores the exposed outer bevel when its neighbour is removed",()=>{
  const scene=new THREE.Scene(),world=new VoxelWorld(),view=new VoxelView(scene,{catalogTextures:false});world.setShaped(8,1,8,wood,18);world.setShaped(9,1,8,stone,18);view.update(world);expect(hit(scene,8.999)).toBeDefined();
  world.set(9,1,8,0);view.markCellDirty(9,1,8);view.update(world);expect(hit(scene,8.999)).toBeUndefined();expect(hit(scene,8.95)).toBeDefined();view.dispose();
 });
 it("keeps the open edge beside a partial ramp instead of extending the cube into empty ramp volume",()=>{
  const scene=new THREE.Scene(),world=new VoxelWorld(),view=new VoxelView(scene,{catalogTextures:false});world.setShaped(8,1,8,wood,18);world.setShaped(9,1,8,stone,kitSlopeShape(0,0));view.update(world);expect(hit(scene,8.999)).toBeUndefined();expect(hit(scene,8.95)).toBeDefined();view.dispose();
 });
});
