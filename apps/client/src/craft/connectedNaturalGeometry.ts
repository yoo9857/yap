import * as THREE from "three";
import {lowAssemblyBumpGeometry} from "./lowAssemblyBump.js";
import {KitMesh} from "./kitShell.js";
import type {NaturalBlockKey} from "./naturalBlockGeometry.js";
export interface NaturalWorldCell {x:number;y:number;z:number;key:NaturalBlockKey}
export interface NaturalMaterialSlot {key:NaturalBlockKey;face:0|2}
type V=readonly [number,number,number];
const directions:readonly V[]=[[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]];
const id=(x:number,y:number,z:number):string=>x+","+y+","+z;
const corner:readonly V[]=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
const tetra:readonly (readonly number[])[]=[[0,5,1,6],[0,1,2,6],[0,2,3,6],[0,3,7,6],[0,7,4,6],[0,4,5,6]];
const edges:readonly (readonly [number,number])[]=[[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
export function naturalNeighbourMasks(cells:readonly NaturalWorldCell[]):number[] {
 const occupied=new Set(cells.map(c=>id(c.x,c.y,c.z)));
 return cells.map(c=>directions.reduce((mask,d,i)=>mask|(occupied.has(id(c.x+d[0],c.y+d[1],c.z+d[2]))?1<<i:0),0));
}
/**
 * Extract one exterior skin from occupied volume, before assigning materials.
 * A shared six-direction occupancy field prevents horizontal, vertical and mixed-material seams.
 * This preview mesher is intended for baked models/chunks, never per-frame work.
 */
export function connectedNaturalWorld(cells:readonly NaturalWorldCell[],resolution=8):{geometry:THREE.BufferGeometry;slots:NaturalMaterialSlot[];masks:number[]} {
 if(!cells.length)throw new Error("A connected block model needs cells");
 if(!Number.isInteger(resolution)||resolution<3||resolution>12)throw new Error("Natural mesh resolution must be 3..12");
 const occupied=new Map(cells.map(c=>[id(c.x,c.y,c.z),c])),tops=new Map<string,number>();
 for(const c of cells){const k=c.x+","+c.z;tops.set(k,Math.max(tops.get(k)??-Infinity,c.y+1));}
 const radius=.12;
 const cumulative=(t:number):number=>t<=-radius?0:t>=radius?1:.5+t/(2*radius)+Math.sin(Math.PI*t/radius)/(2*Math.PI);
 function axis(p:number):{i:number;w:number}[]{const values:{i:number;w:number}[]=[];for(let i=Math.floor(p-radius);i<=Math.floor(p+radius);i++){const w=cumulative(i+1-p)-cumulative(i-p);if(w>1e-10)values.push({i,w});}return values;}
 function density(p:V):number {let value=0;for(const x of axis(p[0]))for(const y of axis(p[1]))for(const z of axis(p[2]))if(occupied.has(id(x.i,y.i,z.i)))value+=x.w*y.w*z.w;return value;}
 function outward(p:V):THREE.Vector3 {const e=.015;return new THREE.Vector3(density([p[0]-e,p[1],p[2]])-density([p[0]+e,p[1],p[2]]),density([p[0],p[1]-e,p[2]])-density([p[0],p[1]+e,p[2]]),density([p[0],p[1],p[2]-e])-density([p[0],p[1],p[2]+e])).normalize();}
 function owner(p:V,n:THREE.Vector3):NaturalWorldCell {
  const inside=occupied.get(id(Math.floor(p[0]-n.x*.055),Math.floor(p[1]-n.y*.055),Math.floor(p[2]-n.z*.055)));if(inside)return inside;
  let best=cells[0]!,distance=Infinity;for(const c of cells){const d=Math.max(c.x-p[0],0,p[0]-c.x-1)**2+Math.max(c.y-p[1],0,p[1]-c.y-1)**2+Math.max(c.z-p[2],0,p[2]-c.z-1)**2;if(d<distance){distance=d;best=c;}}return best;
 }
 const lo:V=[Math.min(...cells.map(c=>c.x))-1/resolution,Math.min(...cells.map(c=>c.y))-1/resolution,Math.min(...cells.map(c=>c.z))-1/resolution];
 const nx=Math.round((Math.max(...cells.map(c=>c.x))+1-lo[0])*resolution)+2,ny=Math.round((Math.max(...cells.map(c=>c.y))+1-lo[1])*resolution)+2,nz=Math.round((Math.max(...cells.map(c=>c.z))+1-lo[2])*resolution)+2;
 const field=new Float32Array(nx*ny*nz),at=(x:number,y:number,z:number)=>(z*ny+y)*nx+x;
 const position=(x:number,y:number,z:number):V=>[lo[0]+x/resolution,lo[1]+y/resolution,lo[2]+z/resolution];
 for(let z=0;z<nz;z++)for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){const value=density(position(x,y,z));field[at(x,y,z)]=Math.abs(value-.5)<1e-8?.5:value;}
 const mesh=new KitMesh(),slots:NaturalMaterialSlot[]=[],slotMap=new Map<string,number>(),triSlots:number[]=[];
 function emit(a:V,b:V,c:V,n:THREE.Vector3,key:NaturalBlockKey,face:0|2,body:NaturalWorldCell):void {
  const name=key+"|"+face;let slot=slotMap.get(name);if(slot===undefined){slot=slots.length;slots.push({key,face});slotMap.set(name,slot);}
  const grain=((Math.imul(body.x,73856093)^Math.imul(body.y,19349663)^Math.imul(body.z,83492791))>>>0)%1024/1023;
  const shade=.985+grain*.015;const before=mesh.pos.length;mesh.tri(a,b,c,[n.x,n.y,n.z],shade);if(mesh.pos.length>before)triSlots.push(slot);
 }
 function triangle(a:V,b:V,c:V):void {
  const center:V=[(a[0]+b[0]+c[0])/3,(a[1]+b[1]+c[1])/3,(a[2]+b[2]+c[2])/3],n=outward(center);
  if(n.lengthSq()<1e-10)return;
  const cell=owner(center,n);if(cell.key!=="grass"){emit(a,b,c,n,cell.key,0,cell);return;}
  const top=tops.get(cell.x+","+cell.z)!;
  const height=(p:V)=>p[1]-top+.18-.018*Math.sin(p[0]*2.37+p[2]*1.73)-.012*Math.sin(p[0]*4.1-p[2]*2.93);
  const clip=(positive:boolean):V[]=>{
   const result:V[]=[],poly=[a,b,c];
   for(let i=0;i<3;i++){const p=poly[i]!,q=poly[(i+1)%3]!,v=height(p),w=height(q),pin=positive?v>=0:v<=0,qin=positive?w>=0:w<=0;if(pin)result.push(p);
    if(pin!==qin){const t=v/(v-w);result.push([p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t,p[2]+(q[2]-p[2])*t]);}}
   return result;
  };
  for(const green of [false,true]){const polygon=clip(green);for(let i=1;i+1<polygon.length;i++)emit(polygon[0]!,polygon[i]!,polygon[i+1]!,n,cell.key,green?0:2,cell);}
 }
 for(let z=0;z<nz-1;z++)for(let y=0;y<ny-1;y++)for(let x=0;x<nx-1;x++){
  const points=corner.map(d=>position(x+d[0],y+d[1],z+d[2])),values=corner.map(d=>field[at(x+d[0],y+d[1],z+d[2])]!);
  if(values.every(v=>v>=.5)||values.every(v=>v<.5))continue;
  for(const t of tetra){
   const hits:V[]=[];
   for(const [a,b] of edges){const ai=t[a]!,bi=t[b]!,va=values[ai]!,vb=values[bi]!;if((va>=.5)===(vb>=.5))continue;
    const s=(.5-va)/(vb-va),p=points[ai]!,q=points[bi]!,hit:V=[p[0]+(q[0]-p[0])*s,p[1]+(q[1]-p[1])*s,p[2]+(q[2]-p[2])*s];
    if(!hits.some(v=>Math.hypot(v[0]-hit[0],v[1]-hit[1],v[2]-hit[2])<1e-8))hits.push(hit);
   }
   if(hits.length<3)continue;
   const center=hits.reduce((v,p)=>v.add(new THREE.Vector3(...p)),new THREE.Vector3()).multiplyScalar(1/hits.length),n=outward([center.x,center.y,center.z]);
   if(n.lengthSq()<1e-10)continue;
   const u=new THREE.Vector3(...hits[0]!).sub(center).normalize(),v=new THREE.Vector3().crossVectors(n,u);
   hits.sort((a,b)=>{const av=new THREE.Vector3(...a).sub(center),bv=new THREE.Vector3(...b).sub(center);return Math.atan2(av.dot(v),av.dot(u))-Math.atan2(bv.dot(v),bv.dot(u));});
   for(let i=1;i+1<hits.length;i++)triangle(hits[0]!,hits[i]!,hits[i+1]!);
  }
 }
 const fieldVertexCount=mesh.pos.length/3,bumpNormals:number[]=[];let bumpCount=0;
 const bump=lowAssemblyBumpGeometry(),bp=bump.getAttribute("position"),bn=bump.getAttribute("normal");
 for(const cell of cells)if(!occupied.has(id(cell.x,cell.y+1,cell.z))){
  const name=cell.key+"|0";let slot=slotMap.get(name);if(slot===undefined){slot=slots.length;slots.push({key:cell.key,face:0});slotMap.set(name,slot);}
  for(let i=0;i<bp.count;i++){mesh.pos.push(bp.getX(i)+cell.x+.5,bp.getY(i)+cell.y+1,bp.getZ(i)+cell.z+.5);mesh.colours.push(1,1,1);bumpNormals.push(bn.getX(i),bn.getY(i),bn.getZ(i));if(i%3===0)triSlots.push(slot);}
  bumpCount++;
 }
 bump.dispose();
 const geometry=mesh.geometry(),normal=geometry.getAttribute("normal"),p=geometry.getAttribute("position");
 const colours=geometry.getAttribute("color");
 for(let i=0;i<p.count;i++){
  const point:V=[p.getX(i),p.getY(i),p.getZ(i)],n=i<fieldVertexCount?outward(point):new THREE.Vector3().fromArray(bumpNormals,(i-fieldVertexCount)*3);if(n.lengthSq()>1e-10)normal.setXYZ(i,n.x,n.y,n.z);
  const axes=[Math.abs(n.x),Math.abs(n.y),Math.abs(n.z)],axis=axes.indexOf(Math.max(...axes));
  if(axes[axis]!>.985){const d=Math.min(...point.filter((_,j)=>j!==axis).map(x=>Math.abs(x-Math.round(x)))),shade=1-.028*Math.exp(-((d/.018)**2));colours.setXYZ(i,colours.getX(i)*shade,colours.getY(i)*shade,colours.getZ(i)*shade);}
 }
 const groups=slots.map(()=>[] as number[]);triSlots.forEach((slot,i)=>groups[slot]!.push(i*3,i*3+1,i*3+2));geometry.setIndex(groups.flat());geometry.clearGroups();
 let offset=0;groups.forEach((g,i)=>{if(g.length)geometry.addGroup(offset,g.length,i);offset+=g.length;});
 geometry.userData.connection_axes=["-X","+X","-Y","+Y","-Z","+Z"];geometry.userData.internal_faces=false;geometry.userData.sample_resolution=resolution;geometry.userData.cells=cells.length;geometry.userData.cosmetic_bumps=bumpCount;
 return {geometry,slots,masks:naturalNeighbourMasks(cells)};
}

