import * as THREE from "three";
export type KitCell=readonly [number,number];
type P=readonly [number,number];type V=readonly [number,number,number];type S=readonly [number,number,number];

/** Explicit winding keeps closed bases, bevels and designed openings renderable from every angle. */
export class KitMesh {
  readonly pos:number[]=[];readonly colours:number[]=[];
  tri(a:V,b:V,c:V,n:V,shade=1):void {
    const cross=new THREE.Vector3(b[0]-a[0],b[1]-a[1],b[2]-a[2]).cross(new THREE.Vector3(c[0]-a[0],c[1]-a[1],c[2]-a[2]));
    if(cross.lengthSq()<1e-16)return;
    if(cross.dot(new THREE.Vector3(...n))<0)[b,c]=[c,b];
    this.pos.push(...a,...b,...c);for(let i=0;i<3;i++)this.colours.push(shade,shade,shade);
  }
  quad(a:V,b:V,c:V,d:V,n:V,shade=1):void {this.tri(a,b,c,n,shade);this.tri(a,c,d,n,shade);}
  plane(outline:readonly P[],holes:readonly (readonly P[])[],y:number,up:boolean,shade=1):void {
    const outer=outline.map(p=>new THREE.Vector2(...p)),inner=holes.map(h=>h.map(p=>new THREE.Vector2(...p))),all=[...outer,...inner.flat()];
    for(const [a,b,c] of THREE.ShapeUtils.triangulateShape(outer,inner)){const pa=all[a!]!,pb=all[b!]!,pc=all[c!]!;this.tri([pa.x,y,pa.y],[pb.x,y,pb.y],[pc.x,y,pc.y],[0,up?1:-1,0],shade);}
  }
  wall(lower:readonly P[],upper:readonly P[],low:number,high:number,shade=1,inward=false):void {
    for(let i=0;i<lower.length;i++){const j=(i+1)%lower.length,a=lower[i]!,b=lower[j]!,c=upper[j]!,d=upper[i]!,s=inward?-1:1;
      this.quad([a[0],low,a[1]],[b[0],low,b[1]],[c[0],high,c[1]],[d[0],high,d[1]],[s*(b[1]-a[1]),0,s*(a[0]-b[0])],shade);}
  }
  geometry():THREE.BufferGeometry {
    const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(this.pos,3));g.setAttribute("color",new THREE.Float32BufferAttribute(this.colours,3));g.computeVertexNormals();
    const p=g.getAttribute("position"),n=g.getAttribute("normal"),uv:number[]=[];
    const normal=new THREE.Vector3(),u=new THREE.Vector3(),v=new THREE.Vector3(),point=new THREE.Vector3();
    for(let i=0;i<p.count;i++){
      normal.fromBufferAttribute(n,i);const x=Math.abs(normal.x),y=Math.abs(normal.y),z=Math.abs(normal.z);
      if(y>=x&&y>=z){u.set(1,0,0).addScaledVector(normal,-normal.x).normalize();v.crossVectors(normal,u);}
      else{v.set(0,1,0).addScaledVector(normal,-normal.y).normalize();u.crossVectors(v,normal);}
      point.fromBufferAttribute(p,i);uv.push(point.dot(u),point.dot(v));
    }
    g.setAttribute("uv",new THREE.Float32BufferAttribute(uv,2));g.computeBoundingBox();g.computeBoundingSphere();return g;
  }
}
const key=(p:P):string=>p.join(",");
const area=(loop:readonly P[]):number=>loop.reduce((v,p,i)=>{const q=loop[(i+1)%loop.length]!;return v+p[0]*q[1]-q[0]*p[1];},0)/2;

/** Union outlines retain enclosed holes and keep matching blocks continuous across a chunk edge. */
export function kitContours(cells:readonly KitCell[]):P[][] {
  const occupied=new Set(cells.map(key)),edges:{a:P;b:P;used:boolean}[]=[];
  for(const [x,z] of cells){
    if(!occupied.has(key([x,z-1])))edges.push({a:[x,z],b:[x+1,z],used:false});
    if(!occupied.has(key([x+1,z])))edges.push({a:[x+1,z],b:[x+1,z+1],used:false});
    if(!occupied.has(key([x,z+1])))edges.push({a:[x+1,z+1],b:[x,z+1],used:false});
    if(!occupied.has(key([x-1,z])))edges.push({a:[x,z+1],b:[x,z],used:false});
  }
  const starts=new Map<string,typeof edges>();for(const e of edges){const k=key(e.a),list=starts.get(k)??[];list.push(e);starts.set(k,list);}
  const loops:P[][]=[];
  for(const first of edges){if(first.used)continue;const loop:P[]=[];let e=first;
    for(let guard=0;guard<=edges.length;guard++){
      e.used=true;loop.push(e.a);if(key(e.b)===key(first.a))break;
      const choices=(starts.get(key(e.b))??[]).filter(v=>!v.used),dx=e.b[0]-e.a[0],dz=e.b[1]-e.a[1];
      const turn=(v:typeof e)=>Math.atan2(dx*(v.b[1]-v.a[1])-dz*(v.b[0]-v.a[0]),dx*(v.b[0]-v.a[0])+dz*(v.b[1]-v.a[1]));
      choices.sort((a,b)=>turn(b)-turn(a));if(!choices[0])throw new Error("Open kit contour");e=choices[0];
    }if(loop.length>=4)loops.push(loop);
  }return loops;
}
function section(loop:readonly P[],inset:number,joined?:(x:number,z:number)=>boolean,contact?:(x:number,z:number)=>boolean):P[] {
  const out:P[]=[],count=loop.length;
  const edge=(i:number):P=>{const a=loop[(i+count)%count]!,b=loop[(i+1+count)%count]!,len=Math.hypot(b[0]-a[0],b[1]-a[1]);return [(b[0]-a[0])/len,(b[1]-a[1])/len];};
  const distance=(i:number)=>{const a=loop[(i+count)%count]!,b=loop[(i+1+count)%count]!,d=edge(i);return joined?.(Math.floor((a[0]+b[0])/2+d[1]*.1),Math.floor((a[1]+b[1])/2-d[0]*.1))?0:contact?.(Math.floor((a[0]+b[0])/2-d[1]*.1),Math.floor((a[1]+b[1])/2+d[0]*.1)) ? 0.01 : inset;};
  for(let i=0;i<count;i++){
    const p=loop[i]!,a=edge(i-1),b=edge(i),da=distance(i-1),db=distance(i),cross=a[0]*b[1]-a[1]*b[0];
    if(Math.abs(cross)<1e-6){out.push([p[0]-b[1]*db,p[1]+b[0]*db]);continue;}
    const c:P=[p[0]-a[1]*da-b[1]*db,p[1]+a[0]*da+b[0]*db],r=da===0||db===0?0:.035;
    const f:P=[c[0]-a[0]*r,c[1]-a[1]*r],t:P=[c[0]+b[0]*r,c[1]+b[1]*r];
    for(let j=0;j<=3;j++){const v=j/3,u=1-v;out.push([u*u*f[0]+2*u*v*c[0]+v*v*t[0],u*u*f[1]+2*u*v*c[1]+v*v*t[1]]);}
  }return out;
}
export function roundedSquare(x:number,z:number,w:number,r=.065):P[] {
  const out:P[]=[],h=w/2;
  for(let c=0;c<4;c++){const a=c*Math.PI/2,cx=x+(c===0||c===3?1:-1)*(h-r),cz=z+(c<2?1:-1)*(h-r);
    for(let i=0;i<=3;i++){const t=a+i*Math.PI/6;out.push([cx+Math.cos(t)*r,cz+Math.sin(t)*r]);}}
  return out;
}
/** A shared shell has only external perimeter walls; cell edges never divide its top or sides. */
export function kitFootprintGeometry(cells:readonly KitCell[],joined?:(x:number,z:number)=>boolean,stacked?:(x:number,z:number,dy:-1|1)=>boolean):THREE.BufferGeometry {
  const mesh=new KitMesh(),loops=kitContours(cells).map(loop=>loop.filter((p,i)=>{
    const a=loop[(i+loop.length-1)%loop.length]!,b=loop[(i+1)%loop.length]!;
    if((p[0]-a[0])*(b[1]-p[1])-(p[1]-a[1])*(b[0]-p[0])!==0)return true;
    const joinedEdge=(v:P,w:P)=>joined?.(Math.floor((v[0]+w[0])/2+(w[1]-v[1])*.1),Math.floor((v[1]+w[1])/2-(w[0]-v[0])*.1))??false;
    const stackedEdge=(v:P,w:P,dy:-1|1)=>{const length=Math.hypot(w[0]-v[0],w[1]-v[1]);return stacked?.(Math.floor((v[0]+w[0])/2-(w[1]-v[1])/length*.1),Math.floor((v[1]+w[1])/2+(w[0]-v[0])/length*.1),dy)??false;};
    return joinedEdge(a,p)!==joinedEdge(p,b)||stackedEdge(a,p,1)!==stackedEdge(p,b,1)||stackedEdge(a,p,-1)!==stackedEdge(p,b,-1);
  })),profile:S[]=[[0,.032,1],[.012,.016,1],[.04,.01,1],[.96,.01,1],[.988,.016,1],[1,.032,1]];
  const sections=loops.map(loop=>profile.map(([y,d])=>section(loop,d,joined,stacked&&(y<.041||y>.959)?(x,z)=>stacked(x,z,y<.041?-1:1):undefined)));
  for(let l=0;l<loops.length;l++)for(let i=1;i<profile.length;i++)mesh.wall(sections[l]![i-1]!,sections[l]![i]!,profile[i-1]![0],profile[i]![0],profile[i]![2]);
  for(let l=0;l<loops.length;l++){
    if(area(loops[l]!)<=0)continue;
    const contains=(p:P)=>{let inside=false;const poly=loops[l]!;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i]!,b=poly[j]!;if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;};
    const holes=loops.map((loop,i)=>({loop,i})).filter(({loop})=>area(loop)<0&&contains(loop[0]!));
    mesh.plane(sections[l]!.at(-1)!,holes.map(h=>sections[h.i]!.at(-1)!),1,true);
    mesh.plane(sections[l]![0]!,holes.map(h=>sections[h.i]![0]!),0,false,1);
  }return mesh.geometry();
}
export const KIT_CONNECTOR_HEIGHT=.04;
/** Four small closed studs keep the construction-brick silhouette, with a softly beveled top edge. */
export function kitConnectorGeometry():THREE.BufferGeometry {
  const mesh=new KitMesh(),profile:readonly (readonly [number,number])[]=[[0,.098],[.004,.10],[.03,.10],[.037,.094],[KIT_CONNECTOR_HEIGHT,.086]];
  for(const x of [-.25,.25])for(const z of [-.25,.25]){
    const loops=profile.map(([,radius])=>Array.from({length:16},(_,i)=>[x+Math.cos(i*Math.PI/8)*radius,z+Math.sin(i*Math.PI/8)*radius] as P));
    for(let i=1;i<profile.length;i++)mesh.wall(loops[i-1]!,loops[i]!,profile[i-1]![0],profile[i]![0],1);
    mesh.plane(loops.at(-1)!,[],KIT_CONNECTOR_HEIGHT,true);mesh.plane(loops[0]!,[],0,false);
  }
  const geometry=mesh.geometry(),p=geometry.getAttribute("position"),n=geometry.getAttribute("normal"),uv=geometry.getAttribute("uv"),buckets=new Map<string,THREE.Vector3>(),key=(i:number)=>[p.getX(i),p.getY(i),p.getZ(i)].map(v=>Math.round(v*1e6)).join(",");
  // Smooth each turned wall, keeping the flat closed top distinct from its tiny bevel.
  for(let i=0;i<p.count;i++)if(Math.abs(n.getY(i))<.999){const k=key(i),sum=buckets.get(k)??new THREE.Vector3();sum.add(new THREE.Vector3().fromBufferAttribute(n,i));buckets.set(k,sum);}
  for(let i=0;i<p.count;i++)if(Math.abs(n.getY(i))<.999){const sum=buckets.get(key(i))!.clone().normalize();n.setXYZ(i,sum.x,sum.y,sum.z);}
  for(let i=0;i<p.count;i++)if(Math.abs(n.getY(i))>.999)uv.setXY(i,p.getX(i)+.5,n.getY(i)>0?-p.getZ(i)-.5:p.getZ(i)+.5);
  geometry.userData.cosmetic=true;geometry.userData.studs=4;return geometry;
}
export function kitRoundGeometry():THREE.BufferGeometry {
  const mesh=new KitMesh(),levels:S[]=[[0,.468,1],[.012,.484,1],[.04,.49,1],[.96,.49,1],[.988,.484,1],[1,.468,1]];
  const loops=levels.map(([,r])=>Array.from({length:24},(_,i):P=>[.5+Math.cos(i*Math.PI/12)*r,.5+Math.sin(i*Math.PI/12)*r]));
  for(let i=1;i<levels.length;i++)mesh.wall(loops[i-1]!,loops[i]!,levels[i-1]![0],levels[i]![0],levels[i]![2]);
  mesh.plane(loops[0]!,[],0,false);mesh.plane(loops.at(-1)!,[],1,true);
  const g=mesh.geometry();g.translate(-.5,-.5,-.5);return g;
}
/** Nominal cell coordinates, shared by exported parts and the single-piece placement preview. */
export function kitCellsGeometry(cells:readonly (readonly [number,number,number])[],connectors=true,joined?:(x:number,y:number,z:number)=>boolean):THREE.BufferGeometry {
  const layers=new Map<number,KitCell[]>(),occupied=new Set(cells.map(c=>c.join(","))),parts:THREE.BufferGeometry[]=[];
  for(const [x,y,z] of cells){const layer=layers.get(y)??[];layer.push([x,z]);layers.set(y,layer);}
  for(const [y,layer] of layers){const g=kitFootprintGeometry(layer,joined?(x,z)=>joined(x,y,z):undefined,(x,z,dy)=>occupied.has([x,y+dy,z].join(","))||!!joined?.(x,y+dy,z));g.translate(0,y,0);parts.push(g);}
  if(connectors)for(const [x,y,z] of cells)if(!occupied.has([x,y+1,z].join(","))){const g=kitConnectorGeometry();g.translate(x+.5,y+1,z+.5);parts.push(g);}
  const positions:number[]=[],normals:number[]=[],colours:number[]=[],uvs:number[]=[];
  for(const g of parts){positions.push(...g.getAttribute("position").array);normals.push(...g.getAttribute("normal").array);colours.push(...g.getAttribute("color").array);uvs.push(...g.getAttribute("uv").array);g.dispose();}
  const result=new THREE.BufferGeometry();for(const [name,values,size] of [["position",positions,3],["normal",normals,3],["color",colours,3],["uv",uvs,2]] as const)result.setAttribute(name,new THREE.Float32BufferAttribute(values,size));result.computeBoundingBox();result.computeBoundingSphere();return result;
}


