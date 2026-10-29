import * as THREE from "three";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";
import {PICKAXE,type HeldItemId} from "../craft/toolDefinitions.js";
import {INK_LAYER} from "../render/inkOutline.js";
let prototype:THREE.Group|null=null,pending:Promise<boolean>|null=null;
export function preloadHeldItems():Promise<boolean> {
 pending??=new GLTFLoader().loadAsync(PICKAXE.modelUrl+"?v="+PICKAXE.version).then(g=>{prototype=g.scene;return true;}).catch(()=>false);return pending;
}
export function heldItemPrototype(id:HeldItemId):THREE.Group|null {return id===PICKAXE.id?prototype:null;}
/** Calibrate from bind-space skin vertices, never from a remote arm origin or the current animation pose. */
export function handGrip(meshes:readonly THREE.SkinnedMesh[]):{bone:THREE.Bone;point:THREE.Vector3;rotation:THREE.Quaternion}|null {
 for(const mesh of meshes){const index=mesh.skeleton.bones.findIndex(b=>b.name.replace(/[._]/g,"").toLowerCase()==="handr");if(index<0)continue;
  const p=mesh.geometry.getAttribute("position"),j=mesh.geometry.getAttribute("skinIndex"),w=mesh.geometry.getAttribute("skinWeight");if(!j||!w)continue;
  const bounds=new THREE.Box3(),point=new THREE.Vector3(),inverse=mesh.skeleton.boneInverses[index]!;
  for(let i=0;i<p.count;i++){let influence=0;for(let k=0;k<4;k++)if(j.getComponent(i,k)===index)influence+=w.getComponent(i,k);if(influence>.45)bounds.expandByPoint(point.fromBufferAttribute(p,i).applyMatrix4(mesh.bindMatrix).applyMatrix4(inverse));}
  if(bounds.isEmpty())continue;
  const rotation=new THREE.Quaternion().setFromRotationMatrix(inverse.clone().invert()).invert().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...PICKAXE.grip.rotation as [number,number,number])));
  return {bone:mesh.skeleton.bones[index]!,point:bounds.getCenter(new THREE.Vector3()),rotation};
 }return null;
}
export class HeldItemInstance {
 readonly root=new THREE.Group();private readonly materials=new Set<THREE.Material>();
 constructor(asset:THREE.Group,grip:NonNullable<ReturnType<typeof handGrip>>,option:string){
  this.root.name="HeldItem/"+PICKAXE.id;this.root.userData.item=PICKAXE.id;this.root.userData.option=option;
  const model=asset.clone(true);model.updateMatrixWorld(true);const node=model.getObjectByName(PICKAXE.grip.node);
  if(!node)throw new Error("Missing item grip anchor");
  const inverse=new THREE.Matrix4().copy(model.matrixWorld).invert().multiply(node.matrixWorld).invert();model.applyMatrix4(inverse);
  model.traverse(o=>{if(o instanceof THREE.Mesh){const source:THREE.Material[]=Array.isArray(o.material)?(o.material as THREE.Material[]):[o.material as THREE.Material];const copies=source.map(m=>{const copy=m.clone();copy.transparent=true;copy.forceSinglePass=true;this.materials.add(copy);return copy;});o.material=copies.length===1?copies[0]!:copies;o.userData.heldItem=true;o.castShadow=true;o.receiveShadow=true;o.layers.enable(INK_LAYER);}});
  this.root.add(model);this.root.position.copy(grip.point);this.root.quaternion.copy(grip.rotation);this.root.scale.setScalar(PICKAXE.grip.scale);grip.bone.add(this.root);
 }
 setOpacity(opacity:number):void {for(const material of this.materials)material.opacity=THREE.MathUtils.clamp(opacity,0,1);}
 dispose():void {this.root.removeFromParent();for(const material of this.materials)material.dispose();this.materials.clear();}
}
