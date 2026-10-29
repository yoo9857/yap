import * as THREE from "three";
import {fractureTemplate,type FractureTemplatePiece} from "./miningFracture.js";
import {miningResponse} from "./miningResponse.js";

/**
 * Cutting a block into Voronoi shards is 20–150 ms of main-thread work (stone is
 * the worst: 16 pieces, ~33k vertices). Done on the first mining frame it was the
 * hitch players felt every time they started digging, so the cut runs in a worker
 * and the result is kept per (block, shape, variant): a block type is cut at most
 * once per cached variant; further digs reuse its arrays (~1 ms). The LRU stays
 * bounded even with a larger set of seeded topologies.
 */
export interface FractureRequest {id:number;position:Float32Array;normal:Float32Array|null;uv:Float32Array|null;color:Float32Array|null;index:Uint32Array|null;groups:number[];interior:number;seed:number;family:string;key:string}
export type FractureReply = {id:number;ok:true;pieces:FractureTemplatePiece[];ms:number}|{id:number;ok:false};

export function cutRequest(request:FractureRequest):FractureTemplatePiece[] {
 const geometry=new THREE.BufferGeometry();
 geometry.setAttribute("position",new THREE.BufferAttribute(request.position,3));
 if(request.normal)geometry.setAttribute("normal",new THREE.BufferAttribute(request.normal,3));
 if(request.uv)geometry.setAttribute("uv",new THREE.BufferAttribute(request.uv,2));
 if(request.color)geometry.setAttribute("color",new THREE.BufferAttribute(request.color,3));
 if(request.index)geometry.setIndex(new THREE.BufferAttribute(request.index,1));
 for(let i=0;i<request.groups.length;i+=3)geometry.addGroup(request.groups[i]!,request.groups[i+1]!,request.groups[i+2]);
 return fractureTemplate(geometry,request.interior,request.seed,miningResponse(request.family,request.key));
}
export const templateTransfers=(pieces:readonly FractureTemplatePiece[]):Transferable[]=>pieces.flatMap(p=>[p.position.buffer,p.normal.buffer,p.uv.buffer,p.color.buffer,p.fracture.buffer]);

const copy=(geometry:THREE.BufferGeometry,name:string):Float32Array|null=>{const a=geometry.getAttribute(name);if(!a)return null;const out=new Float32Array(a.count*a.itemSize);for(let i=0;i<a.count;i++)for(let k=0;k<a.itemSize;k++)out[i*a.itemSize+k]=a.getComponent(i,k);return out;};

export class FractureTemplates {
 private readonly ready=new Map<string,FractureTemplatePiece[]>();
 private readonly jobs=new Map<number,string>();
 private worker:Worker|null=null;
 private failed=typeof Worker==="undefined";
 private serial=0;
 private lastMs=0;
 /** ~8 templates ≈ at most ~12 MB of plain arrays; least recently dug goes first. */
 constructor(private readonly limit=8){}
 get(key:string):FractureTemplatePiece[]|undefined {const t=this.ready.get(key);if(t){this.ready.delete(key);this.ready.set(key,t);}return t;}
 pending(key:string):boolean {for(const k of this.jobs.values())if(k===key)return true;return false;}
 /** Takes ownership of `source` (already rotated into world axes). */
 request(key:string,source:THREE.BufferGeometry,interior:number,seed:number,family:string,blockKey:string):void {
  if(this.ready.has(key)||this.pending(key)){source.dispose();return;}
  const index=source.index?Uint32Array.from(source.index.array as ArrayLike<number>):null;
  const request:FractureRequest={id:++this.serial,position:copy(source,"position")!,normal:copy(source,"normal"),uv:copy(source,"uv"),color:copy(source,"color"),index,groups:source.groups.flatMap(g=>[g.start,g.count,g.materialIndex??0]),interior,seed,family,key:blockKey};
  source.dispose();
  const worker=this.ensureWorker();
  if(!worker){const start=performance.now();this.store(key,cutRequest(request));this.lastMs=performance.now()-start;return;}
  this.jobs.set(request.id,key);
  worker.postMessage(request,[request.position.buffer,...[request.normal,request.uv,request.color,request.index].filter(a=>!!a).map(a=>a.buffer)]);
 }
 private ensureWorker():Worker|null {
  if(this.failed)return null;if(this.worker)return this.worker;
  try{
   const worker=new Worker(new URL("./fractureWorker.ts",import.meta.url),{type:"module"});
   // A broken worker falls back to cutting on the main thread (slower, still correct).
   worker.onerror=()=>{this.failed=true;worker.terminate();this.worker=null;this.jobs.clear();};
   worker.onmessage=(event:MessageEvent<FractureReply>)=>{const reply=event.data,key=this.jobs.get(reply.id);this.jobs.delete(reply.id);if(!key)return;// A cut that throws is remembered as empty (particles only) rather than retried every frame.
    if(reply.ok){this.lastMs=reply.ms;this.store(key,reply.pieces);}else this.store(key,[]);};
   return this.worker=worker;
  }catch{this.failed=true;return null;}
 }
 private store(key:string,pieces:FractureTemplatePiece[]):void {this.ready.set(key,pieces);while(this.ready.size>this.limit)this.ready.delete(this.ready.keys().next().value!);}
 stats():{templates:number;pending:number;floats:number;worker:boolean;lastMs:number}{let floats=0;for(const t of this.ready.values())for(const p of t)floats+=p.position.length*2+p.uv.length+p.color.length+p.fracture.length;return {templates:this.ready.size,pending:this.jobs.size,floats,worker:!!this.worker,lastMs:Math.round(this.lastMs)};}
 dispose():void {this.worker?.terminate();this.worker=null;this.failed=true;this.jobs.clear();this.ready.clear();}
}
