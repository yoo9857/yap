import * as THREE from "three";
import {AIR,blockByKey} from "./blocks.js";
import {VoxelWorld,WORLD_X,WORLD_Z} from "./voxelWorld.js";
import {isFullCubeShape} from "./shapes.js";
export type SandCell=readonly [number,number,number];
export interface SandHost {
 scene:THREE.Scene;
 shape(block:number,shape:number,cell:SandCell):{geometry:THREE.BufferGeometry;rotation:THREE.Quaternion;materials:THREE.Material[]};
 write(x:number,y:number,z:number,block:number,shape:number):void;
 hidden(cells:readonly SandCell[]):void;
 canEnter?:(x:number,y:number,z:number)=>boolean;
}
interface Grain {x:number;cellY:number;z:number;y:number;velocity:number;block:number;shape:number;mesh:THREE.Mesh}
const loose=new Set([blockByKey("sand")!.id,blockByKey("red-sand")!.id]);
export const isLooseSand=(block:number,shape:number):boolean=>loose.has(block)&&isFullCubeShape(shape);
/** Logical cells stay in the world throughout motion, so saving or stopping a fall never loses material. */
export class SandSim {
 private readonly pending=new Set<number>();private readonly active=new Map<number,Grain>();private disposed=false;
 constructor(private readonly world:VoxelWorld,private readonly host:SandHost){}
 touch(x:number,y:number,z:number):void {for(const py of [y,y+1])if(this.world.inBounds(x,py,z)&&isLooseSand(this.world.get(x,py,z),this.world.getShape(x,py,z)))this.pending.add(VoxelWorld.index(x,py,z));}
 wakeAll():void {for(let i=0;i<this.world.cells.length;i++)if(isLooseSand(this.world.cells[i]!,this.world.shapes[i]!))this.pending.add(i);}
 private decode(index:number):[number,number,number] {return [index%WORLD_X,Math.floor(index/(WORLD_X*WORLD_Z)),Math.floor(index/WORLD_X)%WORLD_Z];}
 private canFall(x:number,y:number,z:number):boolean {return y>0&&!this.world.isBlocked(x,y-1,z)&&(this.host.canEnter?.(x,y-1,z)??true);}
 private syncHidden():void {this.host.hidden([...this.active.values()].map(g=>[g.x,g.cellY,g.z] as const));}
 update(dt:number):void {
  if(this.disposed)return;const step=Math.max(0,Math.min(.05,dt));let checked=0,changed=false;const retry:number[]=[];
  for(const index of this.pending){if(this.active.size>=32||checked++>=256)break;this.pending.delete(index);if(this.active.has(index))continue;const [x,y,z]=this.decode(index),block=this.world.get(x,y,z),shape=this.world.getShape(x,y,z);
   if(!isLooseSand(block,shape))continue;if(!this.canFall(x,y,z)){if(y>0&&!this.world.isBlocked(x,y-1,z))retry.push(index);continue;}const model=this.host.shape(block,shape,[x,y,z]),mesh=new THREE.Mesh(model.geometry,model.materials.length===1?model.materials[0]:model.materials);mesh.name="Falling loose sand";mesh.quaternion.copy(model.rotation);mesh.position.set(x+.5,y+.5,z+.5);mesh.castShadow=true;mesh.receiveShadow=true;this.host.scene.add(mesh);this.active.set(index,{x,cellY:y,z,y,velocity:0,block,shape,mesh});changed=true;
  }
  for(const index of retry)this.pending.add(index);
  // Each update walks crossed cell boundaries, preventing a fast grain from tunnelling through support.
  for(const [oldIndex,g] of [...this.active]){
   if(this.world.get(g.x,g.cellY,g.z)!==g.block||this.world.getShape(g.x,g.cellY,g.z)!==g.shape){g.mesh.removeFromParent();g.mesh.geometry.dispose();this.active.delete(oldIndex);changed=true;continue;}
   if(!this.world.isBlocked(g.x,g.cellY-1,g.z)&&!(this.host.canEnter?.(g.x,g.cellY-1,g.z)??true)){g.velocity=0;continue;}
   g.velocity=Math.min(18,g.velocity+9.81*step);let nextY=g.y-g.velocity*step;
   if(!this.canFall(g.x,g.cellY,g.z))nextY=g.cellY;
   while(nextY<=g.cellY-1&&this.canFall(g.x,g.cellY,g.z)){
    const from=g.cellY,to=from-1;this.host.write(g.x,from,g.z,AIR,0);this.host.write(g.x,to,g.z,g.block,g.shape);g.cellY=to;this.touch(g.x,from+1,g.z);changed=true;
    if(!this.canFall(g.x,to,g.z)){nextY=to;break;}
   }
   g.y=Math.max(g.cellY-1,nextY);g.mesh.position.y=g.y+.5;
   this.active.delete(oldIndex);const index=VoxelWorld.index(g.x,g.cellY,g.z);
   if(!this.canFall(g.x,g.cellY,g.z)&&g.y<=g.cellY){g.mesh.removeFromParent();g.mesh.geometry.dispose();changed=true;this.touch(g.x,g.cellY+1,g.z);}
   else this.active.set(index,g);
  }
  if(changed)this.syncHidden();
 }
 /** Field scrolling retains the logical sand cells; restart their visual fall in the new coordinate window. */
 shift():void {this.clear();this.wakeAll();}
 stats():{falling:number;queued:number}{return {falling:this.active.size,queued:this.pending.size};}
 clear():void {for(const g of this.active.values()){g.mesh.removeFromParent();g.mesh.geometry.dispose();}this.active.clear();this.pending.clear();this.host.hidden([]);}
 dispose():void {if(this.disposed)return;this.clear();this.disposed=true;}
}
