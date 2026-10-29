import * as THREE from "three";
import {describe,it,expect,vi} from "vitest";
import {MiningEffects,miningCrackPixels,miningDamageStage,MINING_PARTICLE_LIMIT} from "../src/craft/miningEffects.js";
import {blockByKey} from "../src/craft/blocks.js";
import {kitSlopeShape} from "@robo/shared";
const ground={isBlocked:(_x:number,y:number,_z:number)=>y<0};
describe("mining progression and break motion",()=>{
 it("extends one crack network through all five stages without replacing prior cracks",()=>{
  expect(miningDamageStage(.02)).toBe(0);expect(miningDamageStage(.05)).toBe(1);expect(miningDamageStage(.99)).toBe(5);
  let previous=miningCrackPixels(0),count=0;
  for(let stage=1;stage<=5;stage++){const pixels=miningCrackPixels(stage);let next=0;for(let i=3;i<pixels.length;i+=4){expect(pixels[i]).toBeGreaterThanOrEqual(previous[i]!);if(pixels[i])next++;}expect(next).toBeGreaterThan(count);count=next;previous=pixels;}
 });
 it("keeps overlay geometry stable for one target and clears damage when stopped or changed",()=>{
  const scene=new THREE.Scene(),fx=new MiningEffects(scene),def=blockByKey("dirt")!,make=vi.fn(()=>({geometry:new THREE.BoxGeometry(1,1,1),rotation:new THREE.Quaternion()}));
  fx.setProgress([1,1,1],def,0,.2,make);fx.setProgress([1,1,1],def,0,.8,make);expect(make).toHaveBeenCalledTimes(1);expect(fx.stats().stage).toBe(5);
  fx.setProgress([2,1,1],def,0,.1,make);expect(make).toHaveBeenCalledTimes(2);expect(fx.stats().stage).toBe(1);
  fx.clearTarget();expect(fx.stats().stage).toBe(0);expect(fx.stats().geometry).toBeNull();fx.dispose();expect(scene.children).toHaveLength(0);
 });
 it("emits only occupied ramp fragments, caps the pool and eventually releases every particle",()=>{
  const scene=new THREE.Scene(),fx=new MiningEffects(scene),def=blockByKey("stone")!;
  fx.burst([0,1,0],def,kitSlopeShape(0,0));expect(fx.stats().active).toBeGreaterThan(8);expect(fx.stats().active).toBeLessThan(27);
  for(let i=0;i<8;i++)fx.burst([i,1,0],def,0);expect(fx.stats().active).toBe(MINING_PARTICLE_LIMIT);
  for(let i=0;i<160;i++)fx.update(1/60,ground);expect(fx.stats().active).toBe(0);fx.dispose();
 });
 it("shifts debris with the scrolling field and retains material-specific particle geometry",()=>{
  const scene=new THREE.Scene(),fx=new MiningEffects(scene);fx.burst([40,1,40],blockByKey("snow")!,0);fx.update(0,ground);
  const snow=fx.root.children.find(o=>o.name==="Mining snow debris") as THREE.InstancedMesh;expect(snow.count).toBe(27);expect(snow.geometry.type).toBe("IcosahedronGeometry");
  const before=new THREE.Matrix4(),after=new THREE.Matrix4();snow.getMatrixAt(0,before);fx.shift(32,16);fx.update(0,ground);snow.getMatrixAt(0,after);
  expect(after.elements[12]).toBeCloseTo(before.elements[12]-32);expect(after.elements[14]).toBeCloseTo(before.elements[14]-16);
  fx.reset();expect(fx.stats().active).toBe(0);fx.dispose();
 });
});

