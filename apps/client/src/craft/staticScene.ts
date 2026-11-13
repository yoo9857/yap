/** Metre-accurate imported scenery. Voxel cells keep their existing semantics. */
export type Vec3 = readonly [number, number, number];
export interface StaticBox { min: Vec3; max: Vec3; name?: string }
export interface StaticRamp extends StaticBox { h0: number; h1: number }
export interface StaticHit { dist: number; point: Vec3; normal: Vec3 }
interface Item { box: StaticBox; ramp?: StaticRamp }
interface Node extends StaticBox { items?: Item[]; left?: Node; right?: Node }
const EPS = 1e-6;
const overlap=(a:Vec3,b:Vec3,c:StaticBox)=>a.every((v,k)=>v<c.max[k]!-EPS&&b[k]!>c.min[k]!+EPS);
function tree(items:Item[]):Node|null {
  if(!items.length)return null;
  const min:[number,number,number]=[Infinity,Infinity,Infinity],max:[number,number,number]=[-Infinity,-Infinity,-Infinity];
  for(const {box:b} of items)for(let k=0;k<3;k++){min[k]=Math.min(min[k]!,b.min[k]!);max[k]=Math.max(max[k]!,b.max[k]!);}
  if(items.length<=8)return {min,max,items};
  const axis=[0,1,2].sort((a,b)=>(max[b]!-min[b]!)-(max[a]!-min[a]!))[0]!;
  items.sort((a,b)=>a.box.min[axis]!+a.box.max[axis]!-b.box.min[axis]!-b.box.max[axis]!);
  const mid=items.length>>1;return {min,max,left:tree(items.slice(0,mid))!,right:tree(items.slice(mid))!};
}
/** Entry through an AABB, including zero for an origin already inside it. */
function boxRay(p:Vec3,d:Vec3,b:StaticBox,reach:number):{dist:number;normal:Vec3}|null {
  let enter=0,exit=reach,axis=-1,sign=0;
  for(let k=0;k<3;k++){
    const v=d[k]!,q=p[k]!;
    if(Math.abs(v)<1e-12){if(q<b.min[k]!-EPS||q>b.max[k]!+EPS)return null;continue;}
    const a=(b.min[k]!-q)/v,z=(b.max[k]!-q)/v,lo=Math.min(a,z);
    if(lo>enter){enter=lo;axis=k;sign=v>0?-1:1;}
    exit=Math.min(exit,Math.max(a,z));if(enter>exit+EPS)return null;
  }
  const normal:[number,number,number]=[0,0,0];if(axis>=0)normal[axis]=sign;
  return {dist:enter,normal};
}
export class StaticScene {
  private readonly root:Node|null;
  constructor(readonly boxes:readonly StaticBox[],readonly ramps:readonly StaticRamp[],private readonly origin:()=>readonly[number,number]=()=>[0,0]){
    this.root=tree([...boxes.map(box=>({box})),...ramps.map(ramp=>({box:ramp,ramp}))]);
  }
  private absolute(p:Vec3):[number,number,number]{const[x,z]=this.origin();return[p[0]+x,p[1],p[2]+z];}
  private height(r:StaticRamp,z:number):number{return r.h0+(r.h1-r.h0)*(z-r.min[2])/(r.max[2]-r.min[2]);}
  intersects(min:Vec3,max:Vec3):boolean {
    const a=this.absolute(min),b=this.absolute(max),stack=this.root?[this.root]:[];
    while(stack.length){const n=stack.pop()!;if(!overlap(a,b,n))continue;
      if(!n.items){stack.push(n.left!,n.right!);continue;}
      for(const {box:c,ramp:r}of n.items){if(!overlap(a,b,c))continue;
        if(!r||a[1]<Math.max(this.height(r,Math.max(a[2],r.min[2])),this.height(r,Math.min(b[2],r.max[2])))-EPS)return true;
      }
    }return false;
  }
  rampFloor(x:number,y:number,z:number,half:number):number|null {
    const p=this.absolute([x,y,z]);let top=-Infinity;
    for(const r of this.ramps){
      if(p[0]+half<=r.min[0]||p[0]-half>=r.max[0]||p[2]+half<=r.min[2]||p[2]-half>=r.max[2])continue;
      const h=Math.max(this.height(r,Math.max(r.min[2],p[2]-half)),this.height(r,Math.min(r.max[2],p[2]+half)));
      if(Math.abs(h-y)<.65)top=Math.max(top,h);
    }return Number.isFinite(top)?top:null;
  }
  floorBelow(x:number,y:number,z:number):number {
    const p=this.absolute([x,y,z]);let top=-Infinity;
    const a:Vec3=[p[0]-EPS*2,-1e8,p[2]-EPS*2],b:Vec3=[p[0]+EPS*2,y+.25+EPS*2,p[2]+EPS*2],stack=this.root?[this.root]:[];
    while(stack.length){const n=stack.pop()!;if(!overlap(a,b,n))continue;if(!n.items){stack.push(n.left!,n.right!);continue;}
      for(const {box:c,ramp:r}of n.items)if(p[0]>=c.min[0]&&p[0]<=c.max[0]&&p[2]>=c.min[2]&&p[2]<=c.max[2]){
        const h=r?this.height(r,p[2]):c.max[1];if(h<=y+.25)top=Math.max(top,h);
      }
    }return top;
  }
  raycast(origin:Vec3,dir:Vec3,reach:number):StaticHit|null {
    const p=this.absolute(origin),stack=this.root?[this.root]:[];let nearest:StaticHit|null=null;
    while(stack.length){const n=stack.pop()!;if(!boxRay(p,dir,n,nearest?.dist??reach))continue;
      if(!n.items){stack.push(n.left!,n.right!);continue;}
      for(const {box:b,ramp:r}of n.items){let hit=boxRay(p,dir,b,nearest?.dist??reach);if(!hit)continue;
        if(r){
          const slope=(r.h1-r.h0)/(r.max[2]-r.min[2]),q=p[1]-slope*p[2]-(r.h0-slope*r.min[2]),v=dir[1]-slope*dir[2];
          if(Math.abs(v)<1e-12){if(q>EPS)continue;}
          else{const t=-q/v;if(v<0&&t>hit.dist){const len=Math.hypot(1,slope);hit={dist:t,normal:[0,1/len,-slope/len]};}else if(v>0&&t<hit.dist-EPS)continue;}
          const at:Vec3=[p[0]+dir[0]*hit.dist,p[1]+dir[1]*hit.dist,p[2]+dir[2]*hit.dist];
          if(hit.dist>reach||!at.every((v,k)=>v>=b.min[k]!-EPS&&v<=b.max[k]!+EPS))continue;
        }
        if(nearest&&hit.dist>=nearest.dist)continue;
        nearest={...hit,point:[origin[0]+dir[0]*hit.dist,origin[1]+dir[1]*hit.dist,origin[2]+dir[2]*hit.dist]};
      }
    }return nearest;
  }
}
