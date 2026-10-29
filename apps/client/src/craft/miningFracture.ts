import * as THREE from "three";
import {ConvexGeometry} from "three/examples/jsm/geometries/ConvexGeometry.js";
import {fractureRandom} from "./fractureVariation.js";
import {woodFractureSurface} from "./woodFractureSurface.js";
import {miningResponse,type MiningResponse} from "./miningResponse.js";

interface Vertex {p:THREE.Vector3;n:THREE.Vector3;uv:THREE.Vector2;colour:THREE.Vector3;seam?:number}
interface Triangle {vertices:[Vertex,Vertex,Vertex];material:number;component?:number}
export interface FracturePiece {geometry:THREE.BufferGeometry;center:THREE.Vector3;volume:number}
const EPS=1e-6;
const interpolate=(a:Vertex,b:Vertex,t:number):Vertex=>({p:a.p.clone().lerp(b.p,t),n:a.n.clone().lerp(b.n,t).normalize(),uv:a.uv.clone().lerp(b.uv,t),colour:a.colour.clone().lerp(b.colour,t)});

/** Clip an actual surface, preserving its exterior UVs; close cuts with a separate interior material. */
function clip(triangles:Triangle[],normal:THREE.Vector3,distance:number,interior:number,convex=false):Triangle[] {
 const result:Triangle[]=[],segments:[THREE.Vector3,THREE.Vector3][]=[];
 for(const triangle of triangles){
  const polygon:Vertex[]=[],crossings:THREE.Vector3[]=[],vertices=triangle.vertices,distances=vertices.map(v=>normal.dot(v.p)-distance);
  for(let i=0;i<3;i++){
   const a=vertices[i]!,b=vertices[(i+1)%3]!,da=distances[i]!,db=distances[(i+1)%3]!;
   if(da<=EPS)polygon.push(a);
   if(da>EPS&&db< -EPS||da< -EPS&&db>EPS){const v=interpolate(a,b,da/(da-db));polygon.push(v);crossings.push(v.p);}
   else if(Math.abs(da)<=EPS)crossings.push(a.p);
  }
  for(let i=1;i<polygon.length-1;i++)result.push({vertices:[polygon[0]!,polygon[i]!,polygon[i+1]!],material:triangle.material});
  if(!distances.some(d=>d>EPS)||!distances.some(d=>d<=EPS))continue;
  const unique=[...new Map(crossings.map(p=>[p.toArray().map(v=>Math.round(v*1e6)).join(","),p])).values()];
  if(unique.length!==2||unique[0]!.distanceToSquared(unique[1]!)<1e-14)continue;
  const face=vertices[1].p.clone().sub(vertices[0].p).cross(vertices[2].p.clone().sub(vertices[0].p)),direction=normal.clone().cross(face);let [a,b]=unique as [THREE.Vector3,THREE.Vector3];
  if(b.clone().sub(a).dot(direction)<0)[a,b]=[b,a];segments.push([a,b]);
 }
 if(!segments.length)return result;
 const axis=Math.abs(normal.y)<.8?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0),u=axis.cross(normal).normalize(),v=normal.clone().cross(u),points=new Map<string,THREE.Vector3>(),edges=new Map<string,{a:string;b:string}>();
 if(convex){
  const unique=new Map<string,THREE.Vector2>();for(const [a,b] of segments)for(const p of [a,b]){const q=new THREE.Vector2(p.dot(u),p.dot(v));unique.set(Math.round(q.x*1e7)+","+Math.round(q.y*1e7),q);}
  const sorted=[...unique.values()].sort((a,b)=>a.x-b.x||a.y-b.y),cross=(a:THREE.Vector2,b:THREE.Vector2,c:THREE.Vector2)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x),half=(list:THREE.Vector2[])=>{const hull:THREE.Vector2[]=[];for(const p of list){while(hull.length>1&&cross(hull[hull.length-2]!,hull[hull.length-1]!,p)<=1e-12)hull.pop();hull.push(p);}return hull;},lower=half(sorted),upper=half([...sorted].reverse());lower.pop();upper.pop();const hull=[...lower,...upper];
  const vertex=(p:THREE.Vector2):Vertex=>({p:normal.clone().multiplyScalar(distance).addScaledVector(u,p.x).addScaledVector(v,p.y),n:normal.clone(),uv:p.clone().addScalar(.5),colour:new THREE.Vector3(1,1,1)});
  for(let i=1;i<hull.length-1;i++)result.push({vertices:[vertex(hull[0]!),vertex(hull[i]!),vertex(hull[i+1]!)],material:interior});return result;
 }
 const key=(p:THREE.Vector3)=>p.toArray().map(n=>Math.round(n*1e5)).join(",");
 for(const [a,b] of segments){const ka=key(a),kb=key(b);if(ka===kb)continue;points.set(ka,a);points.set(kb,b);const forward=ka+"/"+kb,reverse=kb+"/"+ka;if(edges.has(reverse))edges.delete(reverse);else edges.set(forward,{a:ka,b:kb});}
 const outgoing=new Map<string,Set<string>>();for(const [id,edge] of edges){let list=outgoing.get(edge.a);if(!list)outgoing.set(edge.a,list=new Set());list.add(id);}
 const rings:THREE.Vector2[][]=[];
 while(edges.size){
  const [firstId,first]=edges.entries().next().value!,loop:string[]=[first.a];let id=firstId,edge=first,closed=false;
  for(let step=0;step<segments.length+2;step++){
   edges.delete(id);outgoing.get(edge.a)?.delete(id);loop.push(edge.b);if(edge.b===first.a){closed=true;break;}
   const next=[...(outgoing.get(edge.b)??[])].find(id=>edges.has(id));if(!next)break;id=next;edge=edges.get(next)!;
  }
  if(!closed||loop.length<4)continue;loop.pop();const ring=loop.map(k=>{const p=points.get(k)!;return new THREE.Vector2(p.dot(u),p.dot(v));});if(Math.abs(THREE.ShapeUtils.area(ring))>1e-9)rings.push(ring);
 }
 const contains=(ring:THREE.Vector2[],p:THREE.Vector2)=>{let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i]!,b=ring[j]!;if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;};
 const areas=rings.map(r=>Math.abs(THREE.ShapeUtils.area(r))),parents=rings.map((ring,i)=>{let parent=-1,area=Infinity;for(let j=0;j<rings.length;j++)if(areas[j]!>areas[i]!+1e-9&&areas[j]!<area&&contains(rings[j]!,ring[0]!)){parent=j;area=areas[j]!;}return parent;});
 const depth=(i:number):number=>parents[i]===-1?0:1+depth(parents[i]!);
 for(let i=0;i<rings.length;i++){
  if(depth(i)%2)continue;const outer=rings[i]!.map(p=>p.clone()),holes=rings.filter((_,j)=>parents[j]===i).map(r=>r.map(p=>p.clone())),all=[...outer,...holes.flat()];
  for(const indices of THREE.ShapeUtils.triangulateShape(outer,holes)){
   const vertices=indices.map(k=>{const p=all[k]!;return {p:normal.clone().multiplyScalar(distance).addScaledVector(u,p.x).addScaledVector(v,p.y),n:normal.clone(),uv:p.clone().addScalar(.5),colour:new THREE.Vector3(1,1,1)};}) as [Vertex,Vertex,Vertex];
   if(vertices[1].p.clone().sub(vertices[0].p).cross(vertices[2].p.clone().sub(vertices[0].p)).dot(normal)<0)[vertices[1],vertices[2]]=[vertices[2],vertices[1]];
   result.push({vertices,material:interior});
  }
 }
 return result;
}

/** Seeded complementary Voronoi pieces, with unequal stone cells and long irregular wood sections. */
export function fractureGeometry(source:THREE.BufferGeometry,interior:number,seed=7249,response:MiningResponse=miningResponse("stone")):FracturePiece[] {
 return cutFracture(source,interior,seed,response,0);
}
function cutFracture(source:THREE.BufferGeometry,interior:number,seed:number,response:MiningResponse,retry:number):FracturePiece[] {
 const p=source.getAttribute("position"),n=source.getAttribute("normal"),uv=source.getAttribute("uv"),colour=source.getAttribute("color"),index=source.index,triangles:Triangle[]=[];
 const count=index?.count??p.count,detailed=response.pattern==="stone"||response.pattern==="wood";
 for(let i=0;i<count;i+=3){
  const vertices:Vertex[]=[];
  for(let j=0;j<3;j++){const k=index?index.getX(i+j):i+j;vertices.push({p:new THREE.Vector3().fromBufferAttribute(p,k),n:n?new THREE.Vector3().fromBufferAttribute(n,k):new THREE.Vector3(0,1,0),uv:uv?new THREE.Vector2(uv.getX(k),uv.getY(k)):new THREE.Vector2(),colour:colour?new THREE.Vector3().fromBufferAttribute(colour,k):new THREE.Vector3(1,1,1)});}
  const material=source.groups.find(g=>i>=g.start&&i<g.start+g.count)?.materialIndex??0;
  const slot=material<interior?material:0;
  const append=(v:[Vertex,Vertex,Vertex],depth=0):void=>{
   if(response.pattern!=="metal"&&!detailed||depth>9){triangles.push({vertices:v,material:slot});return;}
   const lengths=v.map((a,j)=>a.p.distanceToSquared(v[(j+1)%3]!.p)),longest=Math.max(...lengths),edge=lengths.indexOf(longest);
   if(longest<(detailed?.04:.055)){triangles.push({vertices:v,material:slot});return;}
   const a=v[edge]!,b=v[(edge+1)%3]!,c=v[(edge+2)%3]!,mid=interpolate(a,b,.5);append([a,mid,c],depth+1);append([mid,b,c],depth+1);
  };
  append(vertices as [Vertex,Vertex,Vertex]);
 }
 // Keep touching closed solids separate: a cap must never bridge the air beside a top pad.
 const parents=triangles.map((_,i)=>i),find=(i:number):number=>{while(parents[i]!==i){parents[i]=parents[parents[i]!]!;i=parents[i]!;}return i;},owners=new Map<string,number>();
 triangles.forEach((t,i)=>{for(const v of t.vertices){const k=v.p.toArray().map(n=>Math.round(n*1e7)).join(","),owner=owners.get(k);if(owner===undefined)owners.set(k,i);else parents[find(i)]=find(owner);}});
 const components=new Map<number,Triangle[]>();triangles.forEach((t,i)=>{const id=find(i);t.component=id;const list=components.get(id)??[];list.push(t);components.set(id,list);});
 const convexComponents=new Set<number>();
 const volumeOf=(list:Triangle[])=>Math.abs(list.reduce((sum,t)=>sum+t.vertices[0].p.dot(t.vertices[1].p.clone().cross(t.vertices[2].p))/6,0));
 for(const [id,list] of components){
  const unique=new Map<string,THREE.Vector3>();for(const t of list)for(const v of t.vertices)unique.set(v.p.toArray().join(","),v.p);
  const hull=new ConvexGeometry([...unique.values()]),hp=hull.getAttribute("position");let volume=0;
  for(let i=0;i<hp.count;i+=3)volume+=new THREE.Vector3().fromBufferAttribute(hp,i).dot(new THREE.Vector3().fromBufferAttribute(hp,i+1).cross(new THREE.Vector3().fromBufferAttribute(hp,i+2)))/6;
  hull.dispose();const sourceVolume=volumeOf(list);if(Math.abs(Math.abs(volume)-sourceVolume)<Math.max(1e-6,sourceVolume*1e-5))convexComponents.add(id);
 }
 const cutSolids=(input:Triangle[],n:THREE.Vector3,d:number):Triangle[]=>{const groups=new Map<number,Triangle[]>();for(const t of input){const id=t.component??0,list=groups.get(id)??[];list.push(t);groups.set(id,list);}const output:Triangle[]=[];for(const [id,list] of groups)for(const t of clip(list,n,d,interior,convexComponents.has(id)))output.push({...t,component:id});return output;};
 const rng=fractureRandom(seed);
 const sites:THREE.Vector3[]=[];
 if(response.pattern==="stone"){
  // A dense weak region and a sparse body create chips beside larger load-bearing sections.
  const coreCount=10+Math.floor(rng()*5),chips=3+Math.floor(rng()*3),weak=new THREE.Vector3((rng()-.5)*.5,.12+rng()*.2,(rng()-.5)*.5);
  for(let attempt=0;sites.length<coreCount&&attempt<1000;attempt++){
   const clustered=rng()<.38,p=clustered?weak.clone().add(new THREE.Vector3((rng()-.5)*.42,(rng()-.5)*.4,(rng()-.5)*.42)):new THREE.Vector3((rng()-.5)*.84,(rng()-.5)*.84,(rng()-.5)*.84);
   p.clampScalar(-.43,.43);if(sites.every(s=>s.distanceToSquared(p)>.026))sites.push(p);
  }
  const phase=rng()*Math.PI*2;
  for(let i=0;i<chips;i++){const angle=phase+i*Math.PI*2/chips+(rng()-.5)*.65;sites.push(new THREE.Vector3(THREE.MathUtils.clamp(Math.cos(angle)*.61,-.48,.48),.34+rng()*.13,THREE.MathUtils.clamp(Math.sin(angle)*.61,-.48,.48)));}
 }else if(response.pattern==="metal"){
  for(const axis of [new THREE.Vector3(1,0,0),new THREE.Vector3(0,1,0),new THREE.Vector3(0,0,1)])for(const sign of [-1,1])sites.push(axis.clone().multiplyScalar(sign*(.34+rng()*.12)).add(new THREE.Vector3((rng()-.5)*.1,(rng()-.5)*.1,(rng()-.5)*.1)));
 }else{
  const [nx,ny,nz]=response.grid,wood=response.pattern==="wood",angle=(rng()-.5)*(wood?1.1:.7),c=Math.cos(angle),s=Math.sin(angle);
  for(let y=0;y<ny;y++)for(let z=0;z<nz;z++)for(let x=0;x<nx;x++){
   const p=new THREE.Vector3((x+.5)/nx-.5+(rng()-.5)*(wood?.65/nx:.22),(y+.5)/ny-.5+(rng()-.5)*(ny===1?.018:.22),(z+.5)/nz-.5+(rng()-.5)*(wood?.65/nz:.22));
   // Rotate across the fibers, never tilt their long axis across the grain.
   if(wood&&response.grain==="x"){const py=p.y;p.y=py*c-p.z*s;p.z=py*s+p.z*c;}else{const px=p.x;p.x=px*c-p.z*s;p.z=px*s+p.z*c;}
   p.clampScalar(-.46,.46);sites.push(p);
  }
  if(wood)for(const side of [-1,1]){const across=side*(.45+rng()*.035),front=.435+rng()*.05;sites.push(response.grain==="y"?new THREE.Vector3(across,(rng()-.5)*.018,front):new THREE.Vector3((rng()-.5)*.018,across,front));}
  if(response.pattern==="granular"&&nx===3&&ny===2)for(const x of [-1,1])for(const z of [-1,1])sites.push(new THREE.Vector3(x*(.43+rng()*.05),.36+rng()*.1,z*(.43+rng()*.05)));
 }
 const metric=new THREE.Vector3(...response.metric).multiply(new THREE.Vector3(...response.metric));
 const pieces:FracturePiece[]=[];
 for(const site of sites){
  let clipped=triangles;const cuts:{normal:THREE.Vector3;distance:number}[]=[];
  // Nearest cuts first keep intermediate surfaces small.
  for(const other of sites.filter(p=>p!==site).sort((a,b)=>a.distanceToSquared(site)-b.distanceToSquared(site))){
   const normal=other.clone().sub(site).multiply(metric).normalize(),distance=normal.dot(site.clone().add(other).multiplyScalar(.5));
   cuts.push({normal,distance});clipped=cutSolids(clipped,normal,distance);if(!clipped.length)break;
  }
  if(clipped.length<4)continue;
  clipped=clipped.map(t=>{
   const vertices=t.vertices.map(v=>({...v,p:v.p,seam:1-THREE.MathUtils.smoothstep(Math.min(...cuts.map(c=>Math.abs(c.normal.dot(v.p)-c.distance))),0,.035)})) as [Vertex,Vertex,Vertex];
   if(t.material===interior){const n=vertices[1].p.clone().sub(vertices[0].p).cross(vertices[2].p.clone().sub(vertices[0].p)).normalize();for(const v of vertices){v.n=n;if(response.pattern==="wood"){const grain=response.grain==="y"?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0),across=grain.clone().cross(n).normalize();v.uv.set(v.p.dot(across)*1.8,v.p.dot(grain));}}}
   return {vertices,material:t.material};
  });
  const bounds=new THREE.Box3();let volume=0;
  for(const t of clipped){for(const v of t.vertices)bounds.expandByPoint(v.p);const [a,b,c]=t.vertices;volume+=a.p.dot(b.p.clone().cross(c.p))/6;}
  volume=Math.abs(volume);if(volume<1e-5)continue;
  const center=bounds.getCenter(new THREE.Vector3()),geometry=new THREE.BufferGeometry(),positions:number[]=[],normals:number[]=[],uvs:number[]=[],colours:number[]=[],seams:number[]=[];
  // Pack material groups; all original UVs stay in the source coordinate space.
  clipped.sort((a,b)=>a.material-b.material);let group=-1,start=0;
  for(const t of clipped){if(t.material!==group){if(group>=0)geometry.addGroup(start,positions.length/3-start,group);group=t.material;start=positions.length/3;}
   for(const v of t.vertices){positions.push(v.p.x-center.x,v.p.y-center.y,v.p.z-center.z);normals.push(v.n.x,v.n.y,v.n.z);uvs.push(v.uv.x,v.uv.y);colours.push(v.colour.x,v.colour.y,v.colour.z);seams.push(v.seam??0);}}
  if(group>=0)geometry.addGroup(start,positions.length/3-start,group);
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute("normal",new THREE.Float32BufferAttribute(normals,3));geometry.setAttribute("uv",new THREE.Float32BufferAttribute(uvs,2));geometry.setAttribute("fracture",new THREE.Float32BufferAttribute(seams,1));geometry.setAttribute("color",new THREE.Float32BufferAttribute(colours,3));geometry.computeBoundingBox();geometry.computeBoundingSphere();
  pieces.push({geometry,center,volume});
 }
 // Reject ill-conditioned random cuts instead of caching an overlapping or incomplete partition.
 const originalVolume=[...components.values()].reduce((sum,list)=>sum+volumeOf(list),0),cutVolume=pieces.reduce((sum,p)=>sum+p.volume,0);
 if(Math.abs(originalVolume-cutVolume)>Math.max(1e-6,originalVolume*1e-5)){
  for(const piece of pieces)piece.geometry.dispose();
  return retry<2?cutFracture(source,interior,(seed+0x9e3779b9)|0,response,retry+1):[];
 }
 return pieces;
}

export interface DamageShape {geometry:THREE.BufferGeometry;rotation:THREE.Quaternion;materials?:THREE.Material|THREE.Material[]}
/** Already-cut pieces (from the worker / template cache) plus shared materials the fracture must not dispose. */
export interface PreparedDamage {pieces:FracturePiece[];materials:THREE.Material[];interior:THREE.Material}
/** Plain arrays so a cut survives postMessage and can be copied per mined block. groups = [start,count,material,…]. */
export interface FractureTemplatePiece {position:Float32Array;normal:Float32Array;uv:Float32Array;color:Float32Array;fracture:Float32Array;groups:number[];center:[number,number,number];volume:number}
export function fractureTemplate(source:THREE.BufferGeometry,interior:number,seed:number,response:MiningResponse):FractureTemplatePiece[] {
 return fractureGeometry(source,interior,seed,response).map(piece=>{
  const g=piece.geometry,array=(name:string)=>g.getAttribute(name).array as Float32Array;
  const result:FractureTemplatePiece={position:array("position"),normal:array("normal"),uv:array("uv"),color:array("color"),fracture:array("fracture"),groups:g.groups.flatMap(x=>[x.start,x.count,x.materialIndex??0]),center:[piece.center.x,piece.center.y,piece.center.z],volume:piece.volume};
  g.dispose();return result;
 });
}
/** Each mined block gets its own copy: seams and dents rewrite positions and normals in place. */
export function piecesFromTemplate(template:readonly FractureTemplatePiece[]):FracturePiece[] {
 return template.map(t=>{
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.BufferAttribute(new Float32Array(t.position),3));geometry.setAttribute("normal",new THREE.BufferAttribute(new Float32Array(t.normal),3));
  geometry.setAttribute("uv",new THREE.BufferAttribute(new Float32Array(t.uv),2));geometry.setAttribute("color",new THREE.BufferAttribute(new Float32Array(t.color),3));geometry.setAttribute("fracture",new THREE.BufferAttribute(new Float32Array(t.fracture),1));
  for(let i=0;i<t.groups.length;i+=3)geometry.addGroup(t.groups[i]??0,t.groups[i+1]??0,t.groups[i+2]??0);
  geometry.computeBoundingBox();geometry.computeBoundingSphere();
  return {geometry,center:new THREE.Vector3(...t.center),volume:t.volume};
 });
}
/** The fresh cut surface. Shared per block type by MiningEffects: a new material per mined block is a shader-program churn. */
export function fractureInterior(family:string,colour:string,exterior:readonly THREE.Material[]):{material:THREE.MeshStandardMaterial;textures:THREE.Texture[]} {
 const wood=family==="wood"?woodFractureSurface(colour):null;
 const inner=wood?.material??new THREE.MeshStandardMaterial({color:family==="grass"?"#886248":colour,roughness:family==="gem"?.5:.98,metalness:family==="metal"?.8:family==="ore"?.08:0});
 const reference=exterior[family==="grass"?Math.min(2,exterior.length-1):0];
 if(!wood&&reference instanceof THREE.MeshStandardMaterial){inner.map=reference.map;inner.normalMap=reference.normalMap;inner.normalScale.copy(reference.normalScale).multiplyScalar(1.4);inner.roughnessMap=reference.roughnessMap;inner.envMap=reference.envMap;inner.envMapIntensity=reference.envMapIntensity;if(reference.map)inner.color.copy(reference.color);}
 if(family==="metal")inner.roughness=.48;if(family==="glass"){inner.transparent=true;inner.opacity=.5;inner.roughness=.2;}
 if(!wood)inner.color.multiplyScalar(family==="snow"?.86:family==="gem"?.62:.72);inner.name="Fresh fracture interior / "+family;
 return {material:inner,textures:wood?.textures??[]};
}
interface AnimatedPiece extends FracturePiece {motion:number;timing:number;mesh:THREE.Mesh;velocity:THREE.Vector3;spin:THREE.Vector3;loose:boolean;age:number;delay:number;life:number;origin:THREE.Vector3;direction:THREE.Vector3;activation:number;rest:Float32Array;restNormals:Float32Array;seams:Float32Array;open:Uint32Array}
export class MiningFracture {
 readonly root=new THREE.Group();
 readonly pieces:AnimatedPiece[]=[];
 private readonly owned:THREE.Material[]=[];
 private readonly ownedTextures:THREE.Texture[]=[];
 private phase:"mining"|"breaking"|"cancelled"="mining";
 private progress=0;
 private aperture=0;
 private finished=false;
 readonly response:MiningResponse;
 private readonly supportNormal=new THREE.Vector3();
 private readonly chipOrder:AnimatedPiece[];
 private readonly supportCorner=new THREE.Vector3();
 private readonly scratch=new THREE.Vector3();
 private applied=-1;
 private readonly impact=new THREE.Vector3();
 private readonly phaseOffset:number;
 constructor(model:DamageShape|PreparedDamage,colour:string,family:string,cell:readonly [number,number,number],seed:number,key=family){
  this.response=miningResponse(family,key);
  const rng=fractureRandom(seed^0x51ed270b);this.impact.set((rng()-.5)*.5,.5,(rng()-.5)*.5);this.phaseOffset=rng()*Math.PI*2;
  this.root.name="Geometric mining fracture";this.root.position.set(cell[0]+.5,cell[1]+.5,cell[2]+.5);
  let exterior:THREE.Material[],inner:THREE.Material,source:FracturePiece[];
  if("pieces" in model){exterior=model.materials;inner=model.interior;source=model.pieces;}
  else{
   // Bake orientation before cutting so grass tops, gravity and chip direction stay in world axes.
   model.geometry.applyQuaternion(model.rotation);
   exterior=model.materials?(Array.isArray(model.materials)?model.materials:[model.materials]):[new THREE.MeshStandardMaterial({color:colour,roughness:.85})];
   if(!model.materials)this.owned.push(...exterior);
   const surface=fractureInterior(family,colour,exterior);inner=surface.material;this.owned.push(inner);this.ownedTextures.push(...surface.textures);
   source=fractureGeometry(model.geometry,exterior.length,seed,this.response);model.geometry.dispose();
  }
  const materials=[...exterior,inner];
  for(const piece of source){
   const mesh=new THREE.Mesh(piece.geometry,materials);mesh.position.copy(piece.center);mesh.castShadow=true;mesh.receiveShadow=true;mesh.name="Fracture shard";this.root.add(mesh);
   const direction=piece.center.clone();direction.y=Math.max(0,direction.y)*.3;if(direction.lengthSq()<1e-5)direction.set(.1,.03,.1);direction.normalize();
   // Seams, dents and peels move vertices a few cm at most: the culling sphere gets that margin once instead of
   // being recomputed per frame. The box stays the rest box (contacts measure from it).
   piece.geometry.computeBoundingBox();piece.geometry.computeBoundingSphere();piece.geometry.boundingSphere!.radius+=.07;
   const seams=Float32Array.from(piece.geometry.getAttribute("fracture").array),open:number[]=[];for(let i=0;i<seams.length;i++)if(seams[i]!>0)open.push(i);
   this.pieces.push({...piece,motion:.8+rng()*.4,timing:rng()*.028,mesh,origin:piece.center.clone(),direction,activation:THREE.MathUtils.clamp((.5-piece.center.y)*.27+(.5-piece.center.z)*.15,0,.45),seams,open:Uint32Array.from(open),rest:Float32Array.from(piece.geometry.getAttribute("position").array),restNormals:Float32Array.from(piece.geometry.getAttribute("normal").array),velocity:new THREE.Vector3(),spin:new THREE.Vector3(),loose:false,age:0,delay:0,life:.9});
  }
  this.chipOrder=this.pieces.filter(p=>this.response.pattern==="wood"||p.center.y>.15&&p.volume<.055).sort((a,b)=>a.volume-b.volume||b.center.z+b.center.x-a.center.z-a.center.x);
 }
 setProgress(progress:number):void {
  if(this.phase!=="mining")return;this.progress=THREE.MathUtils.clamp(progress,0,1);
  // Sub-millimetre changes are invisible; skip the vertex rewrite and the re-upload.
  if(Math.abs(this.progress-this.applied)<.002)return;this.applied=this.progress;
  // This is a continuous opening, with an early fine seam and deeper branching later.
  const response=this.response,open=THREE.MathUtils.smoothstep(this.progress,response.openAt,1);
  this.aperture=(response.openAt>.6?0:.0015)+response.opening*Math.pow(open,1.65);
  for(const p of this.pieces){if(p.loose)continue;
   const spread=THREE.MathUtils.smoothstep(this.progress,Math.max(p.activation,response.openAt),Math.max(p.activation,response.openAt)+.35);
   p.mesh.position.copy(p.origin);if(response.pattern==="stone")this.openStoneSeams(p);else if(response.pattern==="wood")this.openWoodSeams(p);else p.mesh.position.addScaledVector(p.direction,this.aperture*spread);
   if(response.dent||response.compression)this.deform(p);
   if(response.pattern==="metal"){
    const bend=THREE.MathUtils.smoothstep(this.progress,.67,1)*.18;
    p.mesh.rotation.set((p.direction.z||.25)*bend,0,-p.direction.x*bend);
    const pivotY=p.geometry.boundingBox!.min.y,moved=this.scratch.set(0,pivotY,0).applyQuaternion(p.mesh.quaternion);p.mesh.position.x-=moved.x;p.mesh.position.y+=pivotY-moved.y;p.mesh.position.z-=moved.z;
   }
  }
  for(let i=0;i<2;i++){const p=this.chipOrder[i];if(p&&!p.loose&&this.progress>=response.chipAt[i]!)this.release(p,0,true);}

 }
 /** Open only the advancing fracture lips. The solid body keeps its footprint and never inflates. */
 private openStoneSeams(piece:AnimatedPiece):void {
  const positions=piece.geometry.getAttribute("position"),reach=.05+this.progress*1.6;
  for(const i of piece.open){
   const x=piece.rest[i*3]!,y=piece.rest[i*3+1]!,z=piece.rest[i*3+2]!,distance=Math.hypot(x+piece.origin.x-this.impact.x,y+piece.origin.y-this.impact.y,z+piece.origin.z-this.impact.z),growth=THREE.MathUtils.smoothstep(reach-distance,-.025,.09),lip=piece.seams[i]!*growth,rough=.55+.7*Math.abs(Math.sin((x+piece.origin.x)*31+(z+piece.origin.z)*23+this.phaseOffset)*Math.cos((y+piece.origin.y)*29-(z+piece.origin.z)*17)),amount=this.aperture*lip*rough;
   const length=Math.max(.05,Math.hypot(x,y,z));positions.setXYZ(i,x-x/length*amount,y-y/length*amount,z-z/length*amount);
  }
  positions.needsUpdate=true;
 }
 /** A split advances along the fibers; its root stays joined until the final peel. */
 private openWoodSeams(piece:AnimatedPiece):void {
  const positions=piece.geometry.getAttribute("position"),vertical=this.response.grain==="y",reach=this.progress*1.35,peel=THREE.MathUtils.smoothstep(this.progress,.7,1)*.028,front=THREE.MathUtils.smoothstep(piece.origin.z,-.1,.35);
  for(let i=0;i<positions.count;i++){
   const x=piece.rest[i*3]!,y=piece.rest[i*3+1]!,z=piece.rest[i*3+2]!,along=vertical?y+piece.origin.y:x+piece.origin.x,growth=THREE.MathUtils.smoothstep(reach-(.5-along),-.03,.13),fibers=.72+.28*Math.sin(along*41+(x+piece.origin.x)*23+(z+piece.origin.z)*17+this.phaseOffset),opening=this.aperture*piece.seams[i]!*growth*fibers,px=vertical?x:0,py=vertical?0:y,length=Math.max(.025,Math.hypot(px,py,z)),root=THREE.MathUtils.clamp(along+.5,0,1),bend=peel*root*root*front;
   positions.setXYZ(i,x-px/length*opening+(vertical?piece.direction.x*bend:0),y-py/length*opening+(vertical?0:piece.direction.y*bend),z-z/length*opening+piece.direction.z*bend);
  }
  positions.needsUpdate=true;
 }
 /** Shared deformation field keeps pieces joined during a dent; it is frozen at release. */
 private deform(piece:AnimatedPiece):void {
  const positions=piece.geometry.getAttribute("position"),normals=piece.geometry.getAttribute("normal"),r=this.response,dent=r.dent*THREE.MathUtils.smoothstep(this.progress,.02,.7),compression=r.compression*this.progress;
  for(let i=0;i<positions.count;i++){
   const x=piece.rest[i*3]!+piece.origin.x,y=piece.rest[i*3+1]!+piece.origin.y,z=piece.rest[i*3+2]!+piece.origin.z,wy=Math.max(0,y+.5),field=Math.exp(-((x-.12)**2+(z-.18)**2)/.13);
   const depth=dent*field*wy*wy,newY=(y+.5)*(1-compression)-.5-depth;
   positions.setXYZ(i,x-piece.origin.x,newY-piece.origin.y,z-piece.origin.z);
   const derivative=1-compression-2*dent*field*wy,dx=depth*2*(x-.12)/.13,dz=depth*2*(z-.18)/.13;
   this.supportNormal.set(piece.restNormals[i*3]!-dx*piece.restNormals[i*3+1]!/derivative,piece.restNormals[i*3+1]!/derivative,piece.restNormals[i*3+2]!-dz*piece.restNormals[i*3+1]!/derivative).normalize();normals.setXYZ(i,this.supportNormal.x,this.supportNormal.y,this.supportNormal.z);
  }
  positions.needsUpdate=true;normals.needsUpdate=true;
 }
 private release(p:AnimatedPiece,delay:number,chip:boolean):void {
  p.loose=true;p.age=0;p.delay=delay;p.life=chip?(this.response.pattern==="wood"?1.05:.78):this.response.life;
  p.velocity.set(p.direction.x*(chip?.24:this.response.scatter),chip?.08:-.05,p.direction.z*(chip?.24:this.response.scatter));
  p.spin.set(p.direction.z*(chip?1.5:this.response.spin),p.direction.x*this.response.spin*.7,-p.direction.x*(chip?1.5:this.response.spin));
  if(this.response.pattern==="wood"){const grain=this.response.grain==="y"?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0);p.spin.crossVectors(grain,p.direction).multiplyScalar(chip?3.1:this.response.spin);}
  if(this.response.pattern==="stone"||this.response.pattern==="wood"){p.velocity.multiplyScalar(p.motion);p.spin.multiplyScalar(p.motion);p.life*=.94+p.motion*.06;}
 }
 breakApart():void {
  if(this.phase!=="mining")return;this.phase="breaking";
  // Transfer each existing shard at its exact pose; bottom sections give way first.
  for(let i=0;i<this.pieces.length;i++){const p=this.pieces[i]!;if(!p.loose)this.release(p,this.response.pattern==="wood"?Math.max(0,.5-p.origin.z)*this.response.stagger+p.timing:(p.origin.y+.5)*this.response.stagger+p.timing,false);}
 }
 cancel():void {this.phase="cancelled";for(const p of this.pieces)if(!p.loose)p.mesh.visible=false;}
 update(dt:number,world:{isBlocked(x:number,y:number,z:number):boolean}):void {
  for(const p of this.pieces){if(!p.loose||!p.mesh.visible)continue;p.age+=dt;if(p.age<p.delay)continue;
   const elapsed=p.age-p.delay;if(elapsed>=p.life){p.mesh.visible=false;continue;}
   const before=this.root.position.y+p.mesh.position.y;
   const drag=Math.exp(-this.response.drag*dt);p.velocity.x*=drag;p.velocity.z*=drag;
   p.velocity.y-=this.response.gravity*dt;p.mesh.position.addScaledVector(p.velocity,dt);p.mesh.rotation.x+=p.spin.x*dt;p.mesh.rotation.y+=p.spin.y*dt;p.mesh.rotation.z+=p.spin.z*dt;
   // While mining, exclude this still-solid logical cell from loose-chip collision.
   const worldPosition=this.scratch.copy(p.mesh.position).add(this.root.position),bounds=p.geometry.boundingBox!;let radius=0;
   for(let i=0;i<8;i++){this.supportCorner.set(i&1?bounds.max.x:bounds.min.x,i&2?bounds.max.y:bounds.min.y,i&4?bounds.max.z:bounds.min.z).applyQuaternion(p.mesh.quaternion);radius=Math.max(radius,-this.supportCorner.y*p.mesh.scale.y);}
   const fy=Math.floor(worldPosition.y-radius);
   const ownX=Math.floor(this.root.position.x),ownY=Math.floor(this.root.position.y),ownZ=Math.floor(this.root.position.z),x=Math.floor(worldPosition.x),z=Math.floor(worldPosition.z);
   const occupied=!(this.phase==="mining"&&x===ownX&&fy===ownY&&z===ownZ)&&world.isBlocked(x,fy,z);
   if(occupied&&!world.isBlocked(x,fy+1,z)&&before>=fy+1){p.mesh.position.y=fy+1+radius-this.root.position.y;if(p.velocity.y<0)p.velocity.y*= -this.response.bounce;
    if(this.response.pattern==="wood"){
     const grain=(this.response.grain==="y"?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0)).applyQuaternion(p.mesh.quaternion),upright=Math.abs(grain.y);
     if(upright>.15){this.supportNormal.set(0,1,0).cross(grain).multiplyScalar(Math.sign(grain.y)*this.response.gravity*3.5*dt);p.spin.add(this.supportNormal).multiplyScalar(.985);p.velocity.x*=.95;p.velocity.z*=.95;}
     else{p.spin.multiplyScalar(.5);p.velocity.x*=.65;p.velocity.z*=.65;}
    }else{p.velocity.x*=.48;p.velocity.z*=.48;p.spin.multiplyScalar(.45);}
   }
   const fade=1-THREE.MathUtils.smoothstep(elapsed,p.life*.65,p.life);p.mesh.scale.setScalar(Math.max(.001,fade));
  }
  if(this.response.pattern==="stone"&&this.phase==="breaking")this.shardContacts(world);
  if(this.response.pattern==="wood"&&this.phase==="breaking")this.woodContacts(world);
  this.finished=this.phase!=="mining"&&!this.pieces.some(p=>p.mesh.visible);
 }
 /** Small conservative contacts keep falling stone sections from collapsing through one another. */
 private shardContacts(world:{isBlocked(x:number,y:number,z:number):boolean}):void {
  const loose=this.pieces.filter(p=>p.loose&&p.mesh.visible&&p.age>p.delay+.12);
  for(let pass=0;pass<2;pass++)for(let i=0;i<loose.length;i++)for(let j=i+1;j<loose.length;j++){
   const a=loose[i]!,b=loose[j]!,distance=a.mesh.position.distanceTo(b.mesh.position),radius=(Math.cbrt(a.volume)*a.mesh.scale.x+Math.cbrt(b.volume)*b.mesh.scale.x)*.38;
   if(distance>=radius||distance<1e-5)continue;this.supportNormal.copy(a.mesh.position).sub(b.mesh.position).multiplyScalar(1/distance);
   const correction=(radius-distance)*.38;a.mesh.position.addScaledVector(this.supportNormal,correction);b.mesh.position.addScaledVector(this.supportNormal,-correction);
   const closing=this.supportCorner.copy(a.velocity).sub(b.velocity).dot(this.supportNormal);if(closing<0){a.velocity.addScaledVector(this.supportNormal,-closing*.52);b.velocity.addScaledVector(this.supportNormal,closing*.52);a.spin.multiplyScalar(.92);b.spin.multiplyScalar(.92);}
  }
  this.groundContacts(loose,world);
 }
 /** Long sections use capsule contacts instead of the compact stone approximation. */
 private woodContacts(world:{isBlocked(x:number,y:number,z:number):boolean}):void {
  const loose=this.pieces.filter(p=>p.loose&&p.mesh.visible&&p.age>p.delay+.12),vertical=this.response.grain==="y";
  for(let pass=0;pass<3;pass++){
   const rods=loose.map(p=>{const bounds=p.geometry.boundingBox!,size=bounds.getSize(new THREE.Vector3()),length=vertical?size.y:size.x,radius=Math.sqrt(p.volume/Math.max(.05,length))*.5*p.mesh.scale.x,half=Math.max(.005,length*p.mesh.scale.x*.5-radius),center=bounds.getCenter(new THREE.Vector3()).multiply(p.mesh.scale).applyQuaternion(p.mesh.quaternion).add(p.mesh.position),axis=(vertical?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0)).applyQuaternion(p.mesh.quaternion);return {p,a:center.clone().addScaledVector(axis,-half),b:center.clone().addScaledVector(axis,half),radius};});
   for(let i=0;i<rods.length;i++)for(let j=i+1;j<rods.length;j++){
    const a=rods[i]!,b=rods[j]!,u=a.b.clone().sub(a.a),v=b.b.clone().sub(b.a),w=a.a.clone().sub(b.a),aa=u.dot(u),bb=u.dot(v),cc=v.dot(v),dd=u.dot(w),ee=v.dot(w),denominator=aa*cc-bb*bb;
    let sa=denominator>1e-9?THREE.MathUtils.clamp((bb*ee-cc*dd)/denominator,0,1):0,sb=0;
    for(let step=0;step<3;step++){sb=THREE.MathUtils.clamp((bb*sa+ee)/Math.max(1e-9,cc),0,1);sa=THREE.MathUtils.clamp((bb*sb-dd)/Math.max(1e-9,aa),0,1);}
    const separation=a.a.clone().addScaledVector(u,sa).sub(b.a).addScaledVector(v,-sb),distance=separation.length(),limit=a.radius+b.radius;if(distance>=limit||distance<1e-6)continue;separation.multiplyScalar(1/distance);
    const share=b.p.volume/(a.p.volume+b.p.volume),correction=Math.min(.012,(limit-distance)*.45);a.p.mesh.position.addScaledVector(separation,correction*share);b.p.mesh.position.addScaledVector(separation,-correction*(1-share));
    const closing=this.supportCorner.copy(a.p.velocity).sub(b.p.velocity).dot(separation);if(closing<0){a.p.velocity.addScaledVector(separation,-closing*share);b.p.velocity.addScaledVector(separation,closing*(1-share));a.p.spin.multiplyScalar(.97);b.p.spin.multiplyScalar(.97);}
   }
   this.groundContacts(loose,world);
  }
 }
 private groundContacts(loose:AnimatedPiece[],world:{isBlocked(x:number,y:number,z:number):boolean}):void {
  for(const p of loose){const bounds=p.geometry.boundingBox!;let radius=0;for(let i=0;i<8;i++){this.supportCorner.set(i&1?bounds.max.x:bounds.min.x,i&2?bounds.max.y:bounds.min.y,i&4?bounds.max.z:bounds.min.z).applyQuaternion(p.mesh.quaternion);radius=Math.max(radius,-this.supportCorner.y*p.mesh.scale.y);}
   const x=Math.floor(this.root.position.x+p.mesh.position.x),z=Math.floor(this.root.position.z+p.mesh.position.z),y=Math.floor(this.root.position.y+p.mesh.position.y-radius);
   if(world.isBlocked(x,y,z)&&!world.isBlocked(x,y+1,z)&&this.root.position.y+p.mesh.position.y>=y+1){p.mesh.position.y=y+1+radius-this.root.position.y;if(p.velocity.y<0)p.velocity.y=0;}
  }
 }
 stats():{pieces:number;attached:number;loose:number;aperture:number;visibleVolume:number;finished:boolean;mode:string}{return {pieces:this.pieces.length,attached:this.pieces.filter(p=>!p.loose&&p.mesh.visible).length,loose:this.pieces.filter(p=>p.loose&&p.mesh.visible).length,aperture:this.aperture,visibleVolume:this.pieces.filter(p=>!p.loose&&p.mesh.visible).reduce((a,p)=>a+p.volume,0),finished:this.finished,mode:this.response.pattern};}
 dispose():void {this.root.removeFromParent();for(const p of this.pieces)p.geometry.dispose();for(const m of this.owned)m.dispose();for(const t of this.ownedTextures)t.dispose();this.pieces.length=0;}
}
