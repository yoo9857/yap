import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {FireExtinguisher} from '../src/craft/fire/fireExtinguisher.js';
import {FireLighting} from '../src/craft/fire/fireLighting.js';
import {fireLightVisible} from '../src/craft/fire/fireLightVisibility.js';
import {FIRE_CAMPUS,fireSchool} from '@robo/shared';
import {StaticScene} from '../src/craft/staticScene.js';

async function model(){
 const raw=readFileSync(new URL('../public/models/items/fire/extinguisher/extinguisher.glb',import.meta.url));
 const gltf=await new GLTFLoader().parseAsync(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength),'');
 vi.spyOn(GLTFLoader.prototype,'loadAsync').mockResolvedValue(gltf);
 const m=new FireExtinguisher();await m.ready;return m;
}
describe('the shipped articulated extinguisher',()=>{
 it('keeps the lever locked with the pin in and moves the actual parts after removal',async()=>{
  const m=await model();try{const lever=m.root.getObjectByName('Lever')!,pin=m.root.getObjectByName('SafetyPin')!;
   const rest=lever.quaternion.clone(),start=pin.position.clone();m.pose(0,1);expect(lever.quaternion.angleTo(rest)).toBeLessThan(1e-6);
   const ring=new THREE.Vector3();expect(m.partPosition('pin',ring)).toBe(true);
   expect(ring.x).toBeCloseTo(.0584,4);expect(ring.y).toBeCloseTo(.508,4);expect(ring.z).toBeCloseTo(.028,4);
   m.pose(.5,1);expect(pin.visible).toBe(true);expect(pin.position.x-start.x).toBeCloseTo(.085);expect(lever.quaternion.angleTo(rest)).toBeLessThan(1e-6);
   m.pose(1,1);expect(pin.visible).toBe(false);expect(lever.quaternion.angleTo(rest)).toBeCloseTo(.2);
  }finally{m.dispose();vi.restoreAllMocks();}
 });
 it('uses narrow formed handles and an actual metre-scale grip',async()=>{
  const m=await model();try{const upper=m.root.getObjectByName('Formed_upper_operating_lever')!;
   const size=new THREE.Box3().setFromObject(upper).getSize(new THREE.Vector3());expect(size.x).toBeLessThan(.05);expect(size.y).toBeLessThan(.025);
   expect(m.grip.y).toBeCloseTo(.4784,4);expect(m.grip.z).toBeCloseTo(.044,4);
  }finally{m.dispose();vi.restoreAllMocks();}
 });
 it('emits from the real nozzle after the bottle and left hand move independently',async()=>{
  const m=await model();try{m.root.position.set(12,2,-7);m.root.rotation.y=.7;
   const hand=new THREE.Vector3(11.7,3.1,-6.8),aim=new THREE.Vector3(10,2.3,-2);
   m.pose(1,1,hand,aim);const tip=new THREE.Vector3(),dir=new THREE.Vector3();expect(m.nozzleRay(tip,dir)).toBe(true);
   expect(dir.distanceTo(aim.clone().sub(hand).normalize())).toBeLessThan(1e-5);expect(tip.distanceTo(hand)).toBeCloseTo(.1224,4);
   expect(tip.clone().sub(hand).cross(dir).length()).toBeLessThan(1e-5);
  }finally{m.dispose();vi.restoreAllMocks();}
 });
});
describe('the flexible hose coupling',()=>{
 it('keeps its end ring centred on the inlet when the nozzle bends in every direction',async()=>{
  const m=await model();try{
   m.root.position.set(4,2,-6);m.root.rotation.y=.7;const hand=new THREE.Vector3(4.3,3.1,-5.6);
   for(const direction of [new THREE.Vector3(1,0,0),new THREE.Vector3(-1,0,0),new THREE.Vector3(0,1,0),new THREE.Vector3(0,-1,0),new THREE.Vector3(0,0,1)]){
    m.pose(1,1,hand,hand.clone().add(direction));m.root.updateWorldMatrix(true,true);
    const tube=m.root.getObjectByName('Flexible_extinguisher_hose') as THREE.Mesh<THREE.BufferGeometry>;
    const vertices=tube.geometry.getAttribute('position'),centre=new THREE.Vector3();
    const sides=tube.userData.sides as number;
    for(let i=vertices.count-sides;i<vertices.count;i++)centre.add(new THREE.Vector3().fromBufferAttribute(vertices,i));centre.divideScalar(sides).applyMatrix4(tube.matrixWorld);
    const start=new THREE.Vector3();for(let i=0;i<sides;i++)start.add(new THREE.Vector3().fromBufferAttribute(vertices,i));start.divideScalar(sides).applyMatrix4(tube.matrixWorld);
    const anchor=m.root.getObjectByName('Hose_Anchor')!.getWorldPosition(new THREE.Vector3());
    expect(start.distanceTo(anchor)).toBeLessThan(1e-5);
    const startNormal=new THREE.Vector3().fromBufferAttribute(tube.geometry.getAttribute('normal'),0).transformDirection(tube.matrixWorld);
    const axis=m.root.getObjectByName('Hose_Lead')!.getWorldPosition(new THREE.Vector3()).sub(anchor).normalize();
    expect(Math.abs(startNormal.dot(axis))).toBeLessThan(1e-5);
    const socket=m.root.getObjectByName('Nozzle_Hose_Socket')!.getWorldPosition(new THREE.Vector3());
    expect(centre.distanceTo(socket)).toBeLessThan(1e-5);
   }
  }finally{m.dispose();vi.restoreAllMocks();}
 });
 it('can show a withdrawn pin resting on the lesson tray',async()=>{
  const m=await model();try{m.showRemovedPin=true;m.pose(1,0);const pin=m.root.getObjectByName('SafetyPin')!;expect(pin.visible).toBe(true);
   const tray=new THREE.Vector3(.10,.0058,.13);m.displayRemovedPin(tray,1);expect(pin.getWorldPosition(new THREE.Vector3()).distanceTo(tray)).toBeLessThan(1e-5);
  }finally{m.dispose();vi.restoreAllMocks();}
 });
});
describe('classroom fire lighting',()=>{
 it('allows direct glow through the real science door while blocking partitions and the lower floor',()=>{
  const school=fireSchool(),door=school.fireDoor;const x=(door[0]+door[3])/2,y=door[1]+1.5,z=(door[2]+door[5])/2;
  const from=[x,y,z-1] as const,to=[x,y,z+1] as const;
  expect(fireLightVisible(school,from,to)).toBe(true);
  const scene=new StaticScene(FIRE_CAMPUS.boxes,FIRE_CAMPUS.ramps);expect(scene.raycast(from,[0,0,1],2)).toBeNull();
  expect(fireLightVisible(school,from,[x+4,y,z+1])).toBe(false);
  expect(fireLightVisible(school,from,[x,y-4.4,z-1])).toBe(false);
  expect(fireLightVisible(school,from,[-8,y,-12])).toBe(false);
 });
 it('caches static shadow maps, invalidates after scrolling, and suppresses unshadowed spill on low quality',()=>{
  const root=new THREE.Group(),light=new THREE.PointLight(0xff8a22,40,24);root.add(light);const lighting=new FireLighting(root,fireSchool());
  lighting.update(0,0,true);expect(light.castShadow).toBe(true);expect(light.shadow.autoUpdate).toBe(false);expect(light.shadow.needsUpdate).toBe(true);
  light.shadow.needsUpdate=false;light.intensity=40;lighting.update(0,0,true);expect(light.shadow.needsUpdate).toBe(false);
  lighting.update(20,0,false);expect(light.shadow.needsUpdate).toBe(true);expect(light.intensity).toBe(0);lighting.dispose();
 });
});
