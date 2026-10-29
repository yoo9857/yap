import * as THREE from "three";
import {lowAssemblyBumpGeometry} from "./lowAssemblyBump.js";
import {KitMesh,kitContours,type KitCell} from "./kitShell.js";
export type NaturalBlockKey="snow"|"grass"|"dirt"|"diamond-block";
type Point=readonly [number,number];
interface Ring {y:number;inset:number;shade:number;material:number;wiggle?:number}
const cross=(a:Point,b:Point):number=>a[0]*b[1]-a[1]*b[0];
const area=(p:readonly Point[]):number=>p.reduce((v,a,i)=>v+cross(a,p[(i+1)%p.length]!),0)/2;
const wave=(x:number,z:number,variant:number):number=>Math.sin(x*2.37+z*1.73+variant*1.31)*.56+Math.sin(x*4.1-z*2.93+variant*.77)*.29+Math.cos(x*.91+z*3.17+variant)*.15;
const inside=(p:Point,loop:readonly Point[]):boolean=>{let result=false;for(let i=0,j=loop.length-1;i<loop.length;j=i++){const a=loop[i]!,b=loop[j]!;if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])result=!result;}return result;};

/** Preserve a readable square silhouette. Only the perimeter, not the whole cell, is softened. */
function outline(loop:readonly Point[],inset:number,radius:number,steps:number):Point[] {
 const points:Point[]=[];
 for(let i=0;i<loop.length;i++){
  const p=loop[i]!,prev=loop[(i+loop.length-1)%loop.length]!,next=loop[(i+1)%loop.length]!;
  const al=Math.hypot(p[0]-prev[0],p[1]-prev[1]),bl=Math.hypot(next[0]-p[0],next[1]-p[1]);
  const a:Point=[(p[0]-prev[0])/al,(p[1]-prev[1])/al],b:Point=[(next[0]-p[0])/bl,(next[1]-p[1])/bl];
  const divisor=Math.max(.01,1+a[0]*b[0]+a[1]*b[1]);
  const c:Point=[p[0]-(a[1]+b[1])*inset/divisor,p[1]+(a[0]+b[0])*inset/divisor];
  const r=Math.min(radius,al*.24,bl*.24),f:Point=[c[0]-a[0]*r,c[1]-a[1]*r],t:Point=[c[0]+b[0]*r,c[1]+b[1]*r];
  for(let step=0;step<=steps;step++){const v=step/steps,u=1-v;points.push([u*u*f[0]+2*u*v*c[0]+v*v*t[0],u*u*f[1]+2*u*v*c[1]+v*v*t[1]]);}
 }return points;
}
function profiles(key:NaturalBlockKey):Ring[] {
 if(key==="grass")return [
  {y:0,inset:.038,shade:.94,material:2},{y:.055,inset:.012,shade:1,material:2},
  {y:.62,inset:.013,shade:1,material:2},{y:.785,inset:.012,shade:.98,material:2,wiggle:.038},
  {y:.805,inset:.004,shade:.97,material:0,wiggle:.038},{y:.94,inset:.015,shade:1,material:0},{y:1,inset:.060,shade:1,material:0}];
 if(key==="snow")return [
  {y:0,inset:.060,shade:.98,material:0},{y:.06,inset:.015,shade:1,material:0},{y:.68,inset:.012,shade:1,material:0},
  {y:.84,inset:.025,shade:1,material:0},{y:.94,inset:.065,shade:1,material:0},{y:1,inset:.135,shade:1,material:0}];
 if(key==="diamond-block")return [
  {y:0,inset:.09,shade:.95,material:0},{y:.12,inset:.016,shade:1,material:0},{y:.77,inset:.022,shade:.99,material:0},
  {y:.94,inset:.065,shade:1,material:0},{y:1,inset:.13,shade:1,material:0}];
 return [
  {y:0,inset:.045,shade:.96,material:0},{y:.07,inset:.012,shade:1,material:0},{y:.37,inset:.015,shade:.99,material:0},
  {y:.70,inset:.011,shade:1,material:0},{y:.94,inset:.023,shade:1,material:0},{y:1,inset:.065,shade:1,material:0}];
}
/** Average nearby face normals at bevels without turning broad block faces into inflated spheres. */
function smoothBevelNormals(geometry:THREE.BufferGeometry,key:NaturalBlockKey):void {
 if(key==="diamond-block")return;
 const p=geometry.getAttribute("position"),n=geometry.getAttribute("normal"),buckets=new Map<string,number[]>();
 const id=(i:number):string=>[p.getX(i),p.getY(i),p.getZ(i)].map(x=>Math.round(x*1e6)).join(",");
 for(let i=0;i<p.count;i++){const k=id(i),list=buckets.get(k)??[];list.push(i);buckets.set(k,list);}
 const original=new Float32Array(n.array),a=new THREE.Vector3(),b=new THREE.Vector3(),sum=new THREE.Vector3();
 for(let i=0;i<p.count;i++){
  a.fromArray(original,i*3);sum.set(0,0,0);
  for(const j of buckets.get(id(i))!){b.fromArray(original,j*3);if(a.dot(b)>.62)sum.add(b);}
  sum.normalize();n.setXYZ(i,sum.x,sum.y,sum.z);
 }
}
function surface(cells:readonly KitCell[],key:NaturalBlockKey,variant:number,round=false):THREE.BufferGeometry {
 const loops=round?[Array.from({length:24},(_,i):Point=>[.5+.5*Math.cos(i*Math.PI/12),.5+.5*Math.sin(i*Math.PI/12)])]:kitContours(cells).map(loop=>loop.filter((p,i)=>{
  const a=loop[(i+loop.length-1)%loop.length]!,b=loop[(i+1)%loop.length]!;
  return Math.abs(cross([p[0]-a[0],p[1]-a[1]],[b[0]-p[0],b[1]-p[1]]))>1e-8;
 }));
 const rings=profiles(key),radius=round?.012:key==="snow"?.12:key==="diamond-block"?.09:.065,steps=key==="diamond-block"?1:4;
 const paths=loops.map(loop=>rings.map((r,index)=>outline(loop,r.inset,radius,steps).map(p=>{
  const amount=(key==="dirt"?.004:key==="diamond-block"?.007:key==="snow"?.002:0)*(index>0&&index<rings.length-1?1:0);
  return [p[0]+wave(p[0],p[1],variant)*amount,p[1]+wave(p[1]+.7,p[0]-.2,variant)*amount] as Point;
 })));
 const mesh=new KitMesh(),triangleMaterials:number[]=[];
 const capture=(material:number,action:()=>void):void=>{const before=mesh.pos.length/9;action();while(triangleMaterials.length<mesh.pos.length/9)triangleMaterials.push(material);if(before>triangleMaterials.length)throw Error("Invalid natural surface");};
 for(let l=0;l<loops.length;l++)for(let r=1;r<rings.length;r++){
  const low=rings[r-1]!,high=rings[r]!,a=paths[l]![r-1]!,b=paths[l]![r]!;
  capture(high.material,()=>{for(let i=0;i<a.length;i++){
   const j=(i+1)%a.length,pa=a[i]!,pb=a[j]!,pc=b[j]!,pd=b[i]!;
   const height=(p:Point,ring:Ring)=>ring.y+(ring.wiggle??0)*wave(p[0],p[1],variant);
   mesh.quad([pa[0],height(pa,low),pa[1]],[pb[0],height(pb,low),pb[1]],[pc[0],height(pc,high),pc[1]],[pd[0],height(pd,high),pd[1]],[pb[1]-pa[1],0,pa[0]-pb[0]],high.shade);
  }});
 }
 for(let i=0;i<loops.length;i++){
  if(area(loops[i]!)<0)continue;
  const holes=loops.map((loop,j)=>({loop,j})).filter(o=>area(o.loop)<0&&inside(o.loop[0]!,loops[i]!));
  capture(0,()=>mesh.plane(paths[i]!.at(-1)!,holes.map(h=>paths[h.j]!.at(-1)!),1,true,1));
  capture(key==="grass"?2:0,()=>mesh.plane(paths[i]![0]!,holes.map(h=>paths[h.j]![0]!),0,false,.96));
 }
 const geometry=mesh.geometry(),groups:[number[],number[],number[]]=[[],[],[]];
 triangleMaterials.forEach((material,i)=>groups[material]!.push(i*3,i*3+1,i*3+2));geometry.setIndex(groups.flat());geometry.clearGroups();
 let offset=0;groups.forEach((group,i)=>{if(group.length)geometry.addGroup(offset,group.length,i);offset+=group.length;});
 smoothBevelNormals(geometry,key);geometry.userData.design="natural-v4";geometry.userData.connector=false;return geometry;
}
/** Terrain surfaces share one outer perimeter, so a large plate does not become a field of identical badges. */
export function naturalCellsGeometry(cells:readonly (readonly [number,number,number])[],key:NaturalBlockKey,variant=0,round=false):THREE.BufferGeometry {
 const layers=new Map<number,KitCell[]>(),pieces:THREE.BufferGeometry[]=[],occupied=new Set(cells.map(c=>c.join(",")));
 for(const [x,y,z] of cells){const row=layers.get(y)??[];row.push([x,z]);layers.set(y,row);}
 for(const [y,row] of layers){const geometry=surface(row,key,variant,round);geometry.translate(0,y,0);pieces.push(geometry);}
 for(const [x,y,z] of cells)if(!occupied.has([x,y+1,z].join(","))){const bump=lowAssemblyBumpGeometry();bump.translate(x+.5,y+1,z+.5);pieces.push(bump);}
 if(pieces.length===1)return pieces[0]!;
 const positions:number[]=[],normals:number[]=[],colours:number[]=[],uvs:number[]=[],groups:[number[],number[],number[]]=[[],[],[]];let offset=0;
 for(const geometry of pieces){
  positions.push(...geometry.getAttribute("position").array);normals.push(...geometry.getAttribute("normal").array);colours.push(...geometry.getAttribute("color").array);uvs.push(...geometry.getAttribute("uv").array);
  for(const group of geometry.groups)for(let i=group.start;i<group.start+group.count;i++)groups[group.materialIndex??0]!.push(offset+geometry.index!.getX(i));
  offset+=geometry.getAttribute("position").count;geometry.dispose();
 }
 const result=new THREE.BufferGeometry();for(const [name,values,size] of [["position",positions,3],["normal",normals,3],["color",colours,3],["uv",uvs,2]] as const)result.setAttribute(name,new THREE.Float32BufferAttribute(values,size));
 result.setIndex(groups.flat());let start=0;groups.forEach((group,i)=>{if(group.length)result.addGroup(start,group.length,i);start+=group.length;});result.computeBoundingBox();result.computeBoundingSphere();result.userData.design="natural-v4.2";result.userData.cosmetic_bumps=cells.filter(([x,y,z])=>!occupied.has([x,y+1,z].join(","))).length;return result;
}

