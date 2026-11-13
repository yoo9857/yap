import * as THREE from "three";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";

let prototype:Promise<THREE.Group>|null=null;
let template:THREE.Group|null=null;
let leases=0;
function free(root:THREE.Object3D):void{
 const geometry=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>();
 root.traverse(o=>{if(o instanceof THREE.Mesh){geometry.add(o.geometry as THREE.BufferGeometry);const m=o.material as THREE.Material|THREE.Material[];for(const p of Array.isArray(m)?m:[m])materials.add(p);}});
 for(const g of geometry)g.dispose();for(const m of materials)m.dispose();
}
function source():Promise<THREE.Group>{
 return prototype??=new GLTFLoader().loadAsync('/models/items/fire/extinguisher/extinguisher.glb?v=1.3.1').then(g=>{template=g.scene;if(!leases){free(g.scene);template=null;prototype=null;}return g.scene;}).catch(error=>{prototype=null;throw error;});
}
/** The same movable Blender parts are also exported into the native app. */
export class FireExtinguisher {
 readonly root=new THREE.Group();
 readonly ready:Promise<void>;
 readonly grip=new THREE.Vector3(0,.4784,.044);
 readonly viewGrip=new THREE.Vector3(0,.5084,.112);
 private pin:THREE.Object3D|null=null;
 private lever:THREE.Object3D|null=null;
 private nozzle:THREE.Object3D|null=null;
 private tip:THREE.Object3D|null=null;
 private inlet:THREE.Object3D|null=null;
 showRemovedPin=false;
 private anchor:THREE.Object3D|null=null;
 private lead:THREE.Object3D|null=null;
 private hose:THREE.Object3D|null=null;
 private readonly pinBind=new THREE.Vector3();
 private readonly nozzleBind=new THREE.Vector3();
 private readonly leverBind=new THREE.Quaternion();
 private readonly scratch=new THREE.Vector3();
 private readonly target=new THREE.Vector3();
 private readonly direction=new THREE.Vector3();
 private readonly inverse=new THREE.Quaternion();
 private readonly rotation=new THREE.Quaternion();
 private readonly forward=new THREE.Vector3(0,0,1);
 private readonly carryPivot=new THREE.Vector3();
 private readonly carryAxis=new THREE.Vector3();
 private tube:THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>|null=null;
 private disposed=false;
 constructor(){
  leases++;this.root.name='Blender extinguisher';
  this.ready=source().then(asset=>{
   if(this.disposed)return;
   const model=asset.clone(true);this.root.add(model);
   this.pin=model.getObjectByName('SafetyPin')??null;this.lever=model.getObjectByName('Lever')??null;
   this.nozzle=model.getObjectByName('Nozzle')??null;this.tip=model.getObjectByName('Nozzle_Tip')??null;this.inlet=model.getObjectByName('Nozzle_Hose_Socket')??null;
   const grip=model.getObjectByName('Grip_Main');if(grip){model.updateWorldMatrix(true,true);grip.getWorldPosition(this.grip);this.root.worldToLocal(this.grip);}
   this.viewGrip.copy(this.grip).z+=.068;
   this.viewGrip.y+=.030;
   this.anchor=model.getObjectByName('Hose_Anchor')??null;this.lead=model.getObjectByName('Hose_Lead')??null;this.hose=model.getObjectByName('Hose')??null;
   if(this.pin)this.pinBind.copy(this.pin.position);if(this.lever)this.leverBind.copy(this.lever.quaternion);if(this.nozzle)this.nozzleBind.copy(this.nozzle.position);
   model.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=true;o.receiveShadow=true;}});
  });
 }
 /** A semantic anchor on the physical pull ring, not an approximate overlay coordinate. */
 partPosition(part:'pin'|'nozzle',out:THREE.Vector3):boolean{
  const node=this.root.getObjectByName(part==='pin'?'Pin_Grip':'Nozzle_Tip');if(!node)return false;node.getWorldPosition(out);return true;
 }
 /** Animate the physical pin and lever. World-space hands keep the hose connected while walking. */
 pose(pinOut:number,squeeze:number,nozzleHand?:THREE.Vector3,aimAt?:THREE.Vector3,hoseForward?:THREE.Vector3):void{
  if(this.pin){this.pin.quaternion.identity();this.pin.position.copy(this.pinBind);this.pin.position.x+=.17*pinOut;this.pin.visible=pinOut<.99||this.showRemovedPin;}
  if(this.lever)this.lever.quaternion.copy(this.leverBind).multiply(this.rotation.setFromAxisAngle(new THREE.Vector3(1,0,0),.20*(pinOut>=.99?squeeze:0)));
  if(!this.nozzle)return;
  if(nozzleHand){this.nozzle.parent!.updateWorldMatrix(true,false);this.nozzle.position.copy(this.nozzle.parent!.worldToLocal(this.scratch.copy(nozzleHand)));}
  else this.nozzle.position.copy(this.nozzleBind);
  this.nozzle.updateWorldMatrix(true,true);
  if(aimAt){
   this.nozzle.getWorldPosition(this.scratch);this.direction.copy(aimAt).sub(this.scratch).normalize();
   this.nozzle.parent!.getWorldQuaternion(this.inverse).invert();
   this.nozzle.quaternion.copy(this.inverse.multiply(this.rotation.setFromUnitVectors(this.forward,this.direction)));
  }else this.nozzle.quaternion.identity();
  if(this.hose)this.hose.visible=!nozzleHand;
  if(nozzleHand)this.updateHose(hoseForward);else if(this.tube)this.tube.visible=false;
 }
 /** Place the mitten over the moulded nozzle grip, ahead of the rear hose ferrule. */
 carry(squeeze:number,nozzleGrip:THREE.Vector3,aimAt:THREE.Vector3,hoseForward:THREE.Vector3,hoseClearance=.27):void{
  this.carryAxis.copy(aimAt).sub(nozzleGrip).normalize();
  this.carryPivot.copy(nozzleGrip).addScaledVector(this.carryAxis,-.036);
  this.pose(1,squeeze,this.carryPivot,aimAt,this.carryAxis.copy(hoseForward).multiplyScalar(hoseClearance));
 }
 nozzleRay(position:THREE.Vector3,direction:THREE.Vector3):boolean{
  if(!this.tip||!this.nozzle)return false;
  this.tip.updateWorldMatrix(true,false);this.tip.getWorldPosition(position);this.nozzle.getWorldPosition(this.scratch);direction.copy(position).sub(this.scratch).normalize();return true;
 }
 /** Put the withdrawn pin on the lesson tray, while ordinary world models hide it. */
 displayRemovedPin(at:THREE.Vector3,amount:number):void{
  if(!this.pin?.parent)return;this.pin.visible=true;this.pin.parent.updateWorldMatrix(true,false);
  this.pin.position.lerp(this.pin.parent.worldToLocal(this.scratch.copy(at)),amount);
  this.pin.quaternion.setFromAxisAngle(new THREE.Vector3(1,0,0),-Math.PI*.5*amount);
 }
 private updateHose(hoseForward?:THREE.Vector3):void{
  if(!this.hose?.parent||!this.anchor||!this.nozzle)return;
  const segments=24,sides=10;
  if(!this.tube){
   const g=new THREE.BufferGeometry(),n=(segments+1)*sides;
   g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(n*3),3));g.setAttribute('normal',new THREE.BufferAttribute(new Float32Array(n*3),3));
   const indices:number[]=[];for(let i=0;i<segments;i++)for(let j=0;j<sides;j++){const a=i*sides+j,b=i*sides+(j+1)%sides,c=a+sides,d=b+sides;indices.push(a,c,b,b,c,d);}g.setIndex(indices);
   this.tube=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0x263842,roughness:.66}));this.tube.name="Flexible_extinguisher_hose";this.tube.userData.sides=sides;this.tube.frustumCulled=false;this.hose.parent.add(this.tube);
  }
  this.tube.visible=true;const parent=this.hose.parent;
  parent.updateWorldMatrix(true,false);this.anchor.getWorldPosition(this.scratch);const a=parent.worldToLocal(this.scratch.clone());
  (this.inlet??this.nozzle).getWorldPosition(this.target);const c=parent.worldToLocal(this.target.clone());
  this.nozzle.getWorldQuaternion(this.rotation);parent.getWorldQuaternion(this.inverse).invert();
  const endDirection=new THREE.Vector3(0,0,1).applyQuaternion(this.inverse.multiply(this.rotation));
  const startDirection=new THREE.Vector3(1,0,0);
  if(this.lead){this.lead.getWorldPosition(this.scratch);startDirection.copy(parent.worldToLocal(this.scratch)).sub(a).normalize();}
  const distance=a.distanceTo(c),bend=Math.min(.13,Math.max(.045,distance*.24));
  const b=a.clone().addScaledVector(startDirection,bend),d=c.clone().addScaledVector(endDirection,-bend);
  const clearance = new THREE.Vector3(0,-.14,0);
  if(hoseForward){
   parent.getWorldQuaternion(this.inverse).invert();
   clearance.copy(hoseForward).applyQuaternion(this.inverse);
   clearance.y-=.065;
  }
  const p=this.tube.geometry.getAttribute('position'),n=this.tube.geometry.getAttribute('normal');
  const tangent=new THREE.Vector3(),right=new THREE.Vector3(),up=new THREE.Vector3(),centre=new THREE.Vector3();
  for(let i=0;i<=segments;i++){const t=i/segments,s=1-t;
   centre.copy(a).multiplyScalar(s*s*s).addScaledVector(b,3*s*s*t).addScaledVector(d,3*s*t*t).addScaledVector(c,t*t*t);centre.addScaledVector(clearance,16*s*s*t*t);
   tangent.copy(b).sub(a).multiplyScalar(3*s*s).addScaledVector(this.direction.copy(d).sub(b),6*s*t).addScaledVector(this.scratch.copy(c).sub(d),3*t*t);tangent.addScaledVector(clearance,32*s*t*(1-2*t)).normalize();
   // Carry the frame along the tube so crossing vertical never twists or folds a ring.
   right.addScaledVector(tangent,-right.dot(tangent));
   if(right.lengthSq()<.001)right.crossVectors(tangent,Math.abs(tangent.y)>.95?this.forward:THREE.Object3D.DEFAULT_UP);
   right.normalize();up.crossVectors(right,tangent).normalize();
   for(let j=0;j<sides;j++){const angle=j*Math.PI*2/sides;this.scratch.copy(right).multiplyScalar(Math.cos(angle)).addScaledVector(up,Math.sin(angle));const k=i*sides+j;n.setXYZ(k,this.scratch.x,this.scratch.y,this.scratch.z);p.setXYZ(k,centre.x+this.scratch.x*.012,centre.y+this.scratch.y*.012,centre.z+this.scratch.z*.012);}}
  p.needsUpdate=n.needsUpdate=true;
 }
 dispose():void{
  if(this.disposed)return;this.disposed=true;
  this.tube?.geometry.dispose();this.tube?.material.dispose();this.root.clear();leases--;
  if(!leases&&template){free(template);template=null;prototype=null;}
 }
}
