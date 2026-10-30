import {beforeAll,describe,it,expect,vi} from "vitest";
import {readFile} from "node:fs/promises";
import * as THREE from "three";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";
import {HomeRig,disposeHomeRig,type HomeAssets} from "../src/player/homeRig.js";
import {handGrip,HeldItemInstance,preloadHeldItems} from "../src/player/heldItem.js";
import {PICKAXE,pickaxeCycle,pickaxeEfficiency,pickaxeWork,pickaxeInReach} from "../src/craft/toolDefinitions.js";
vi.mock("../src/player/faceCanvas.js",async()=>{const T=await import("three");return {faceBitmap:vi.fn(),FaceCanvas:class {texture=new T.Texture();set(){}play(){}update(){}dispose(){this.texture.dispose();}}};});
import {MiningEffects} from "../src/craft/miningEffects.js";
import {blockByKey} from "../src/craft/blocks.js";
import {INK_LAYER} from "../src/render/inkOutline.js";
const characters=new Map<string,HomeAssets>();let item:THREE.Group;
async function load(file:URL){const raw=await readFile(file),array=raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength),loader=new GLTFLoader();loader.register(()=>({name:"TEST_IMAGES",loadTexture:()=>Promise.resolve(new THREE.Texture())}));return loader.parseAsync(array,"");}
beforeAll(async()=>{for(const character of ["HOME","TT"] as const){const g=await load(new URL(`../public/models/characters/${character}/${character}.glb`,import.meta.url));characters.set(character,{scene:g.scene,animations:g.animations,character,faces:{sequences:{}}});}item=(await load(new URL("../public/models/items/tools/pickaxe-basic/pickaxe-basic.glb",import.meta.url))).scene;const loadItem=vi.spyOn(GLTFLoader.prototype,"loadAsync").mockResolvedValue({scene:item} as never);await preloadHeldItems();loadItem.mockRestore();});
describe("pickaxe grip and settings",()=>{
 it("has one textured runtime primitive, a hand origin, and two impact anchors",()=>{const meshes=item.getObjectsByProperty("type","Mesh") as THREE.Mesh[];expect(meshes).toHaveLength(1);expect((meshes[0]!.geometry.index?.count??0)/3).toBeLessThan(3000);expect(item.getObjectByName("Grip_Main")).toBeDefined();expect(item.getObjectByName("Impact_Left")).toBeDefined();expect(item.getObjectByName("Impact_Right")).toBeDefined();expect(meshes[0]!.geometry.getAttribute("uv").count).toBeGreaterThan(0);});
 it("locks the grip inside both real hands through movement, jump and posture transitions",()=>{
  for(const character of ["HOME","TT"]){const rig=new HomeRig(characters.get(character)!,character==="TT"?"tt":"mascot"),meshes=rig.root.getObjectsByProperty("type","SkinnedMesh").filter(m=>m.name!=="Character XR outline") as THREE.SkinnedMesh[],grip=handGrip(meshes);expect(grip).not.toBeNull();const held=new HeldItemInstance(item,grip!,"balanced"),anchor=held.root.getObjectByName("Grip_Main")!,point=new THREE.Vector3();
   for(const state of ["idle","run","jump","fall","idle","crawl","lie","idle"] as const)for(let frame=0;frame<20;frame++){rig.update(state,state==="run"?3:0,1/60);rig.root.updateMatrixWorld(true);const expected=grip!.bone.localToWorld(grip!.point.clone());anchor.getWorldPosition(point);expect(point.distanceTo(expected)).toBeLessThan(1e-6);expect(held.root.matrixWorld.elements.every(Number.isFinite)).toBe(true);}
   held.dispose();disposeHomeRig(rig.root);
  }
 });
 it("calibrates from bind space so equipping after an animation gives the same local grip",()=>{const a=new HomeRig(characters.get("HOME")!,"mascot"),b=new HomeRig(characters.get("HOME")!,"mascot");for(let i=0;i<20;i++)b.update("run",4,1/60);const get=(r:HomeRig)=>handGrip(r.root.getObjectsByProperty("type","SkinnedMesh").filter(o=>o.name!=="Character XR outline") as THREE.SkinnedMesh[])!;expect(get(a).point.distanceTo(get(b).point)).toBeLessThan(1e-9);expect(get(a).rotation.angleTo(get(b).rotation)).toBeLessThan(1e-6);disposeHomeRig(a.root);disposeHomeRig(b.root);});
 it("shares geometry while keeping held-item opacity and disposal per instance",()=>{const rig=new HomeRig(characters.get("HOME")!,"mascot"),grip=handGrip(rig.root.getObjectsByProperty("type","SkinnedMesh").filter(o=>o.name!=="Character XR outline") as THREE.SkinnedMesh[])!,a=new HeldItemInstance(item,grip,"balanced"),b=new HeldItemInstance(item,grip,"balanced"),am=a.root.getObjectByProperty("type","Mesh") as THREE.Mesh,bm=b.root.getObjectByProperty("type","Mesh") as THREE.Mesh;expect(am.geometry).toBe(bm.geometry);expect(am.material).not.toBe(bm.material);for(let frame=0;frame<30;frame++){a.updatePose(1/60,null,true);a.removePose();b.updatePose(1/60,null,true);b.removePose();}a.setOpacity(.2);expect((am.material as THREE.Material).opacity).toBe(.2);expect((bm.material as THREE.Material).opacity).toBe(1);const free=vi.spyOn(am.geometry,"dispose");a.dispose();expect(free).not.toHaveBeenCalled();b.dispose();disposeHomeRig(rig.root);});
 it("enforces reach and forward arc and applies work only on impact crossings",()=>{expect(pickaxeInReach(2.4)).toBe(true);expect(pickaxeInReach(2.401)).toBe(false);expect(pickaxeInReach(1,Math.PI)).toBe(false);expect(pickaxeInReach(1,.5,"precise-tip")).toBe(false);expect(pickaxeInReach(1,.5,"balanced")).toBe(true);expect(pickaxeInReach(NaN)).toBe(false);const hit=pickaxeCycle()*PICKAXE.swing.impactAt;expect(pickaxeWork(0,hit-.001,"stone")).toBe(0);expect(pickaxeWork(hit-.001,hit+.001,"stone")).toBeGreaterThan(0);expect(pickaxeEfficiency("stone")).toBeGreaterThan(pickaxeEfficiency("oak-log"));expect(PICKAXE.abilities.playerDamage).toBe(0);expect(PICKAXE.abilities.areaBreak).toBe(false);});
 it("keeps strike work independent of frame rate and makes options affect actual mining",()=>{const work=(step:number,option:string)=>{let total=0;for(let time=0;time<3-1e-8;time+=step)total+=pickaxeWork(time,Math.min(3,time+step),"stone",option);return total;};expect(work(1/60,"balanced")).toBeCloseTo(work(1/17,"balanced"),8);expect(pickaxeCycle("light-grip")).toBeLessThan(pickaxeCycle());expect(pickaxeEfficiency("stone","stone-focus")).toBeGreaterThan(pickaxeEfficiency("stone"));});
 it("moves the rigid mitten and tool together and eases out of an interrupted swing",()=>{
  for(const character of ["HOME","TT"]){const rig=new HomeRig(characters.get(character)!,character==="TT"?"tt":"mascot");rig.setHeldItem("pickaxe-basic");for(let frame=0;frame<40;frame++)rig.update("idle",0,1/60);const item=rig.root.getObjectByName("HeldItem/pickaxe-basic")!;expect(item).toBeDefined();
   const parent=item.parent!,local=item.position.clone(),anchor=item.getObjectByName("Grip_Main")!;rig.performAction("interact",1,true);
   for(let frame=0;frame<45;frame++){rig.update("idle",0,1/60);rig.root.updateMatrixWorld(true);expect(anchor.getWorldPosition(new THREE.Vector3()).distanceTo(parent.localToWorld(local.clone()))).toBeLessThan(1e-6);}
   const before=parent.quaternion.clone();rig.performAction("none",2);rig.update("idle",0,1/120);expect(parent.quaternion.angleTo(before)).toBeLessThan(.22);
   for(let frame=0;frame<40;frame++)rig.update("crawl",0,1/60);expect(item.visible).toBe(false);rig.setHeldItem(null);expect(rig.root.getObjectByName("HeldItem/pickaxe-basic")).toBeUndefined();disposeHomeRig(rig.root);
  }
 });
 it("prepares a target during windup without hiding it or showing damage",()=>{
  const scene=new THREE.Scene(),hidden=vi.fn(),fx=new MiningEffects(scene,hidden),def=blockByKey("stone")!,make=()=>({geometry:new THREE.BoxGeometry(1,1,1),rotation:new THREE.Quaternion()});
  fx.primeTarget([1,1,1],def,0,make);expect(hidden).not.toHaveBeenCalled();expect(fx.stats().geometry).toBeNull();expect(fx.stats().templates.templates).toBe(1);fx.burst([1,1,1],def,0,make);expect(fx.stats().fractures).toBe(1);fx.dispose();
 });

 it("places the handle through the thumb/palm cleft instead of the old wrist pivot",()=>{
  for(const character of ["HOME","TT"]){
   const rig=new HomeRig(characters.get(character)!,character==="TT"?"tt":"mascot");
   const mesh=rig.root.getObjectsByProperty("type","SkinnedMesh").find(m=>m.name!=="Character XR outline") as THREE.SkinnedMesh;
   const grip=handGrip([mesh])!,index=mesh.skeleton.bones.indexOf(grip.bone);
   const bindPoint=grip.point.clone().applyMatrix4(mesh.skeleton.boneInverses[index]!.clone().invert());
   const shaft=new THREE.Vector3(0,1,0).applyQuaternion(grip.bindRotation.clone().multiply(grip.rotation));
   bindPoint.addScaledVector(shaft,-PICKAXE.grip.handleSlide*PICKAXE.grip.scale);
   // Cleft of the approved thumb-only mitten, measured from its actual mesh.
   expect(bindPoint.x).toBeGreaterThan(-.70);expect(bindPoint.x).toBeLessThan(-.67);
   expect(bindPoint.y).toBeGreaterThan(.98);expect(bindPoint.y).toBeLessThan(1.01);
   expect(shaft.length()).toBeCloseTo(1,6);
   expect(shaft.z).toBeLessThan(-.999);
   expect(bindPoint.z).toBeCloseTo(0,5);
   disposeHomeRig(rig.root);
  }
 });
 it("lifts the real hand smoothly into a grasp while keeping its shoulder and socket attached",()=>{
  for(const character of ["HOME","TT"]){
   const rig=new HomeRig(characters.get(character)!,character==="TT"?"tt":"mascot");
   for(let i=0;i<30;i++)rig.update("idle",0,1/60);
   const mesh=rig.root.getObjectsByProperty("type","SkinnedMesh").find(m=>m.name!=="Character XR outline") as THREE.SkinnedMesh;
   const grip=handGrip([mesh])!;rig.root.updateMatrixWorld(true);
   const start=grip.bone.localToWorld(grip.point.clone()),previous=start.clone(),neutral=grip.bone.quaternion.clone();
   const position=mesh.geometry.getAttribute("position"),unchanged=Array.from(position.array);
   const inverse=mesh.skeleton.boneInverses[mesh.skeleton.bones.indexOf(grip.bone)]!;
   const cap=new THREE.Vector3(...mesh.userData.arm_cap_R as [number,number,number]).applyMatrix4(mesh.bindMatrix).applyMatrix4(inverse);
   const capAnchor=grip.bone.parent!.worldToLocal(grip.bone.localToWorld(cap.clone()));
   rig.setHeldItem("pickaxe-basic");const tool=rig.root.getObjectByName("HeldItem/pickaxe-basic")!,anchor=tool.getObjectByName("Grip_Main")!;
   const material=(tool.getObjectByProperty("type","Mesh") as THREE.Mesh).material as THREE.Material;
   expect(material.opacity).toBe(0);
   for(let frame=0;frame<36;frame++){
    rig.update("idle",0,1/60);rig.root.updateMatrixWorld(true);
    const current=grip.bone.localToWorld(grip.point.clone());
    expect(current.distanceTo(previous)).toBeLessThan(.05);previous.copy(current);
    expect(anchor.getWorldPosition(new THREE.Vector3()).distanceTo(current)).toBeLessThan(1e-6);
    expect(grip.bone.localToWorld(cap.clone()).distanceTo(grip.bone.parent!.localToWorld(capAnchor.clone()))).toBeLessThan(1e-5);
   }
   expect(previous.y-start.y).toBeGreaterThan(.035);
   expect(neutral.angleTo(grip.bone.quaternion)).toBeLessThan(.55);
   expect(material.opacity).toBe(1);
   expect(Array.from(position.array)).toEqual(unchanged);
   disposeHomeRig(rig.root);
  }
 });
 it("keeps the same grasp and visible item when only the option changes",()=>{
  const rig=new HomeRig(characters.get("HOME")!,"mascot");rig.setHeldItem("pickaxe-basic");
  for(let i=0;i<40;i++)rig.update("idle",0,1/60);
  const tool=rig.root.getObjectByName("HeldItem/pickaxe-basic")!,rotation=tool.parent!.quaternion.clone();
  rig.setHeldItem("pickaxe-basic","stone-focus");
  expect(rig.root.getObjectByName("HeldItem/pickaxe-basic")).toBe(tool);
  expect(tool.parent!.quaternion.angleTo(rotation)).toBeLessThan(1e-7);
  expect(tool.userData.option).toBe("stone-focus");
  expect(((tool.getObjectByProperty("type","Mesh") as THREE.Mesh).material as THREE.Material).opacity).toBe(1);
  disposeHomeRig(rig.root);
 });

 it("keeps the selected striking point facing forward through a downward impact and character turns",()=>{
  for(const character of ["HOME","TT"])for(const yaw of [0,Math.PI*.7]){
   const rig=new HomeRig(characters.get(character)!,character==="TT"?"tt":"mascot");rig.root.rotation.y=yaw;rig.setHeldItem("pickaxe-basic");
   for(let i=0;i<50;i++)rig.update("idle",0,1/60);
   const forward=new THREE.Vector3(0,0,1).applyQuaternion(rig.root.getWorldQuaternion(new THREE.Quaternion()));
   const sample=()=>{rig.root.updateMatrixWorld(true);const tip=rig.root.getObjectByName(PICKAXE.swing.impactNode)!.getWorldPosition(new THREE.Vector3()),center=rig.root.getObjectByName("Head_Center")!.getWorldPosition(new THREE.Vector3());return{height:tip.y,facing:tip.sub(center).normalize().dot(forward)};};
   expect(sample().facing).toBeGreaterThan(.6);rig.performAction("interact",1,true);
   const end=pickaxeCycle()*PICKAXE.swing.impactAt,dt=end/90;let high=0;
   for(let i=0;i<90;i++){const time=(i+1)*dt;rig.update("idle",0,dt,{toolTime:time});if(time>=.2&&!high)high=sample().height;}
   const impact=sample();expect(impact.facing).toBeGreaterThan(.3);expect(impact.height).toBeLessThan(high-.025);disposeHomeRig(rig.root);
  }
 });

 it("keeps a small connected sway when running and settles after stopping",()=>{
  for(const character of ["HOME","TT"]){
   const rig=new HomeRig(characters.get(character)!,character==="TT"?"tt":"mascot");rig.setHeldItem("pickaxe-basic");
   const item=rig.root.getObjectByName("HeldItem/pickaxe-basic")!,anchor=item.getObjectByName("Grip_Main")!,bone=item.parent!;
   const bounds=new THREE.Box3(),p=new THREE.Vector3(),previous=new THREE.Vector3();let maxStep=0;
   for(let frame=0;frame<200;frame++){rig.update("run",4.4,1/60);rig.root.updateMatrixWorld(true);anchor.getWorldPosition(p);expect(p.distanceTo(bone.localToWorld(item.position.clone()))).toBeLessThan(1e-6);if(frame>60){bounds.expandByPoint(p);maxStep=Math.max(maxStep,p.distanceTo(previous));}previous.copy(p);}
   const range=bounds.getSize(new THREE.Vector3());expect(range.y).toBeGreaterThan(.01);expect(range.y).toBeLessThan(.065);expect(maxStep).toBeLessThan(.03);
   for(let frame=0;frame<120;frame++)rig.update("idle",0,1/60);rig.root.updateMatrixWorld(true);const settled=anchor.getWorldPosition(new THREE.Vector3());rig.update("idle",0,1/60);rig.root.updateMatrixWorld(true);expect(anchor.getWorldPosition(p).distanceTo(settled)).toBeLessThan(.002);disposeHomeRig(rig.root);
  }
 });
 it("preserves the forward strike while running in four directions with every tool option",()=>{
  for(const character of ["HOME","TT"])for(const yaw of [0,Math.PI/2,Math.PI,-Math.PI/2])for(const option of PICKAXE.options){
   const rig=new HomeRig(characters.get(character)!,character==="TT"?"tt":"mascot");rig.root.rotation.y=yaw;rig.setHeldItem("pickaxe-basic",option.id);
   for(let i=0;i<60;i++)rig.update("run",4.4,1/60);rig.performAction("interact",1,true);
   const cycle=pickaxeCycle(option.id),dt=cycle/100;let previousHeight=0;
   for(let i=0;i<59;i++){const time=(i+1)*dt;rig.update("run",4.4,dt,{toolTime:time});rig.root.updateMatrixWorld(true);const tip=rig.root.getObjectByName(PICKAXE.swing.impactNode)!.getWorldPosition(new THREE.Vector3());if(i===38)previousHeight=tip.y;if(i===57){const center=rig.root.getObjectByName("Head_Center")!.getWorldPosition(new THREE.Vector3()),direction=tip.clone().sub(center).normalize().applyQuaternion(rig.root.getWorldQuaternion(new THREE.Quaternion()).invert());expect(direction.z).toBeGreaterThan(.5);expect(Math.atan2(Math.abs(direction.x),direction.z)).toBeLessThan(PICKAXE.targeting.arcDegrees*option.arc*Math.PI/360);expect(tip.y).toBeLessThan(previousHeight-.1);}}
   disposeHomeRig(rig.root);
  }
 });
 it("turns through the yaw seam without a hand jump or runaway lag",()=>{
  const rig=new HomeRig(characters.get("HOME")!,"mascot");rig.setHeldItem("pickaxe-basic");for(let i=0;i<60;i++)rig.update("run",2.2,1/60);
  const held=rig.root.getObjectByName("HeldItem/pickaxe-basic")!,sample=()=>{rig.root.updateMatrixWorld(true);return rig.root.worldToLocal(held.getWorldPosition(new THREE.Vector3()));};let previous=sample(),max=0;
  for(let i=0;i<180;i++){rig.root.rotation.y=3+i*.025;rig.update("run",2.2,1/60);const point=sample();max=Math.max(max,point.distanceTo(previous));previous=point;expect(held.matrixWorld.elements.every(Number.isFinite)).toBe(true);}expect(max).toBeLessThan(.035);disposeHomeRig(rig.root);
 });
 it("releases interrupted preparation, impact and recovery without snapping the hand",()=>{
  for(const phase of [.3,.58,.75]){const rig=new HomeRig(characters.get("HOME")!,"mascot");rig.setHeldItem("pickaxe-basic");for(let i=0;i<60;i++)rig.update("idle",0,1/60);rig.performAction("interact",1,true);for(let i=0;i<50;i++)rig.update("idle",0,phase*pickaxeCycle()/50);const held=rig.root.getObjectByName("HeldItem/pickaxe-basic")!,before=held.parent!.quaternion.clone();rig.performAction("none",2);rig.update("idle",0,1/120);expect(held.parent!.quaternion.angleTo(before)).toBeLessThan(.23);disposeHomeRig(rig.root);}
 });
 it("samples the same impact pose at 30, 60 and 144 fps",()=>{
  const samples:THREE.Vector3[]=[];
  for(const fps of [30,60,144]){const random=vi.spyOn(Math,"random").mockReturnValue(.37),rig=new HomeRig(characters.get("HOME")!,"mascot");random.mockRestore();rig.setHeldItem("pickaxe-basic");for(let i=0;i<fps;i++)rig.update("idle",0,1/fps);rig.performAction("interact",1,true);const end=pickaxeCycle()*PICKAXE.swing.impactAt;let time=0;while(time<end-1e-8){const dt=Math.min(1/fps,end-time);time+=dt;rig.update("idle",0,dt,{toolTime:time});}rig.root.updateMatrixWorld(true);samples.push(rig.root.getObjectByName(PICKAXE.swing.impactNode)!.getWorldPosition(new THREE.Vector3()));disposeHomeRig(rig.root);}expect(samples[0]!.distanceTo(samples[1]!)).toBeLessThan(.008);expect(samples[1]!.distanceTo(samples[2]!)).toBeLessThan(.008);
 });

 it("moves the actual striking tip forward and down through contact, including running and four facings",()=>{
  for(const character of ["HOME","TT"])for(const yaw of [0,Math.PI/2,Math.PI,-Math.PI/2])for(const option of PICKAXE.options)for(const speed of [0,4.4]){
   const rig=new HomeRig(characters.get(character)!,character==="TT"?"tt":"mascot");rig.root.rotation.y=yaw;rig.setHeldItem("pickaxe-basic",option.id);for(let i=0;i<60;i++)rig.update(speed?"run":"idle",speed,1/60);rig.performAction("interact",1,true);
   const tip=rig.root.getObjectByName(PICKAXE.swing.impactNode)!,sample=()=>{rig.root.updateMatrixWorld(true);return rig.root.worldToLocal(tip.getWorldPosition(new THREE.Vector3()));};
   const cycle=pickaxeCycle(option.id),dt=cycle/200;let previous=sample();const prepared=previous.clone();
   for(let i=1;i<=122;i++){const phase=i/200;rig.update(speed?"run":"idle",speed,dt,{toolTime:phase*cycle});const point=sample();if(i===76)prepared.copy(point);if(phase>=.55&&phase<=.6){const velocity=point.clone().sub(previous).divideScalar(dt);expect(velocity.z).toBeGreaterThan(.1);expect(velocity.y).toBeLessThan(-.5);}if(i===116)expect(point.z-prepared.z).toBeGreaterThan(.18);previous=point;}
   disposeHomeRig(rig.root);
  }
 });
 it("applies damage while the tip is approaching, not while it is retracting, at low and high frame rates",()=>{
  for(const fps of [30,60,144]){const rig=new HomeRig(characters.get("HOME")!,"mascot");rig.setHeldItem("pickaxe-basic");for(let i=0;i<fps;i++)rig.update("idle",0,1/fps);rig.performAction("interact",1,true);const tip=rig.root.getObjectByName(PICKAXE.swing.impactNode)!,sample=()=>{rig.root.updateMatrixWorld(true);return tip.getWorldPosition(new THREE.Vector3());};let time=0,previous=sample(),hits=0;
   while(time<pickaxeCycle()*3-1e-8){const next=time+1/fps;rig.update("idle",0,1/fps,{toolTime:next});const point=sample();if(pickaxeWork(time,next,"stone")>0){expect(point.z-previous.z).toBeGreaterThan(.001);expect(point.y-previous.y).toBeLessThan(-.001);hits++;}time=next;previous=point;}expect(hits).toBe(3);disposeHomeRig(rig.root);}
 });

 it("carries upper-body weight forward without moving the feet or leaking a lean on unequip",()=>{
  for(const character of ["HOME","TT"]){const rig=new HomeRig(characters.get(character)!,character==="TT"?"tt":"mascot");rig.setHeldItem("pickaxe-basic");for(let i=0;i<60;i++)rig.update("idle",0,1/60);rig.performAction("interact",1,true);const end=pickaxeCycle()*PICKAXE.swing.impactAt;
   for(let i=0;i<100;i++)rig.update("idle",0,end/100,{toolTime:(i+1)*end/100});rig.root.updateMatrixWorld(true);
   const mesh=rig.root.getObjectsByProperty("type","SkinnedMesh").find(o=>o.name!=="Character XR outline") as THREE.SkinnedMesh;
   const feet=mesh.skeleton.bones.filter(b=>/^(foot|toe)/.test(b.name)),points=feet.map(b=>b.getWorldPosition(new THREE.Vector3())),head=mesh.skeleton.bones.find(b=>b.name==="head")!,headBefore=head.getWorldPosition(new THREE.Vector3());
   const rootPosition=rig.root.position.clone();rig.setHeldItem(null);rig.root.updateMatrixWorld(true);
   feet.forEach((b,i)=>expect(b.getWorldPosition(new THREE.Vector3()).distanceTo(points[i]!)).toBeLessThan(1e-8));
   rig.performAction("none",2);for(let i=0;i<36;i++)rig.update("idle",0,1/120);rig.root.updateMatrixWorld(true);const headAfter=head.getWorldPosition(new THREE.Vector3());
   expect(rig.root.getObjectByName("HeldItem/pickaxe-basic")).toBeUndefined();
   expect(headBefore.z-headAfter.z).toBeGreaterThan(.05);expect(rig.root.position.distanceTo(rootPosition)).toBeLessThan(1e-9);disposeHomeRig(rig.root);
  }
 });

 it("keeps actual hand motion flowing through preparation and recovery intermediates",()=>{
  for(const character of ["HOME","TT"]){
   const rig=new HomeRig(characters.get(character)!,character==="TT"?"tt":"mascot");rig.setHeldItem("pickaxe-basic");
   for(let i=0;i<120;i++)rig.update("idle",0,1/120);
   rig.performAction("interact",1,true);
   const held=rig.root.getObjectByName("HeldItem/pickaxe-basic")!,bone=held.parent!,cycle=pickaxeCycle(),dt=cycle/400;
   const previous=bone.getWorldQuaternion(new THREE.Quaternion());
   for(let i=1;i<=800;i++){
    rig.update("idle",0,dt,{toolTime:i*dt});rig.root.updateMatrixWorld(true);
    const rotation=bone.getWorldQuaternion(new THREE.Quaternion());
    // These are intermediate keys, not the genuine reversal at the top/bottom.
    if(i===480||i===696)expect(rotation.angleTo(previous)/dt).toBeGreaterThan(2);
    previous.copy(rotation);
   }
   disposeHomeRig(rig.root);
  }
 });
 it("returns through repeated strokes without a hand or torso jump at the cycle seam",()=>{
  for(const character of ["HOME","TT"])for(const speed of [0,4.4]){
   const rig=new HomeRig(characters.get(character)!,character==="TT"?"tt":"mascot");rig.setHeldItem("pickaxe-basic");
   for(let i=0;i<120;i++)rig.update(speed?"run":"idle",speed,1/120);
   rig.performAction("interact",1,true);
   const held=rig.root.getObjectByName("HeldItem/pickaxe-basic")!,bone=held.parent!,torso=bone.parent!,cycle=pickaxeCycle(),dt=cycle/240;
   const hand=bone.getWorldQuaternion(new THREE.Quaternion()),body=torso.getWorldQuaternion(new THREE.Quaternion());
   for(let i=1;i<=725;i++){
    rig.update(speed?"run":"idle",speed,dt,{toolTime:i*dt});rig.root.updateMatrixWorld(true);
    const nextHand=bone.getWorldQuaternion(new THREE.Quaternion()),nextBody=torso.getWorldQuaternion(new THREE.Quaternion());
    if(i>240&&(i%240<4||i%240>236)){expect(nextHand.angleTo(hand)).toBeLessThan(.02);expect(nextBody.angleTo(body)).toBeLessThan(.01);}
    hand.copy(nextHand);body.copy(nextBody);
   }
   disposeHomeRig(rig.root);
  }
 });
 it("keeps the approved local handle angle rigid while the whole arm and body follow the stroke",()=>{
  for(const character of ["HOME","TT"]){
   const rig=new HomeRig(characters.get(character)!,character==="TT"?"tt":"mascot");rig.setHeldItem("pickaxe-basic");
   for(let i=0;i<120;i++)rig.update("idle",0,1/120);
   const held=rig.root.getObjectByName("HeldItem/pickaxe-basic")!,rotation=held.quaternion.clone(),point=held.position.clone(),anchor=held.getObjectByName("Grip_Main")!;
   rig.performAction("interact",1,true);
   for(let i=0;i<240;i++){
    rig.root.rotation.y=3+i*.015;rig.update("run",4.4,1/120,{toolTime:(i+1)/120});rig.root.updateMatrixWorld(true);
    expect(held.quaternion.angleTo(rotation)).toBeLessThan(1e-7);expect(held.position.distanceTo(point)).toBeLessThan(1e-9);
    expect(anchor.getWorldPosition(new THREE.Vector3()).distanceTo(held.parent!.localToWorld(point.clone()))).toBeLessThan(1e-6);
   }
   disposeHomeRig(rig.root);
  }
 });

 it("settles the arm on unequip and resumes the same grasp during a rapid reselection",()=>{
  for(const character of ["HOME","TT"])for(const phase of [null,.58]){
   const rig=new HomeRig(characters.get(character)!,character==="TT"?"tt":"mascot");rig.setHeldItem("pickaxe-basic");for(let i=0;i<120;i++)rig.update("idle",0,1/120);
   if(phase!==null){rig.performAction("interact",1,true);for(let i=0;i<100;i++)rig.update("idle",0,pickaxeCycle()*phase/100,{toolTime:(i+1)*pickaxeCycle()*phase/100});}
   const tool=rig.root.getObjectByName("HeldItem/pickaxe-basic")!,bone=tool.parent!,local=tool.position.clone();rig.root.updateMatrixWorld(true);const before=bone.localToWorld(local.clone());
   rig.setHeldItem(null);expect(tool.visible).toBe(false);rig.performAction("none",2);rig.update("idle",0,1/120);rig.root.updateMatrixWorld(true);
   expect(bone.localToWorld(local.clone()).distanceTo(before)).toBeLessThan(.025);
   for(let i=0;i<6;i++)rig.update("idle",0,1/120);
   rig.root.updateMatrixWorld(true);const mid=bone.localToWorld(local.clone());rig.setHeldItem("pickaxe-basic");expect(rig.root.getObjectByName("HeldItem/pickaxe-basic")).toBe(tool);
   rig.update("idle",0,1/120);rig.root.updateMatrixWorld(true);expect(bone.localToWorld(local.clone()).distanceTo(mid)).toBeLessThan(.025);
   for(let i=0;i<60;i++)rig.update("idle",0,1/120);expect(tool.visible).toBe(true);
   rig.setHeldItem(null);for(let i=0;i<40;i++)rig.update("idle",0,1/120);expect(rig.root.getObjectByName("HeldItem/pickaxe-basic")).toBeUndefined();disposeHomeRig(rig.root);
  }
 });
 it("suppresses depth, shadow and ink until the fading tool is actually visible",()=>{
  const rig=new HomeRig(characters.get("HOME")!,"mascot");rig.setHeldItem("pickaxe-basic");const tool=rig.root.getObjectByName("HeldItem/pickaxe-basic")!,mesh=tool.getObjectByProperty("type","Mesh") as THREE.Mesh,material=mesh.material as THREE.Material;
  rig.update("idle",0,1/120);expect(material.opacity).toBe(0);expect(tool.visible).toBe(false);expect(mesh.castShadow).toBe(false);expect(mesh.layers.isEnabled(INK_LAYER)).toBe(false);expect(material.depthWrite).toBe(false);
  for(let i=0;i<60;i++)rig.update("idle",0,1/120);expect(tool.visible).toBe(true);expect(mesh.castShadow).toBe(true);expect(mesh.layers.isEnabled(INK_LAYER)).toBe(true);expect(material.depthWrite).toBe(true);
  rig.setHeldOpacity(.2);expect(mesh.castShadow).toBe(false);expect(mesh.layers.isEnabled(INK_LAYER)).toBe(false);expect(material.depthWrite).toBe(false);disposeHomeRig(rig.root);
 });

});
