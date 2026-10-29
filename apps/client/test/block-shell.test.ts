import * as THREE from "three";
import {describe,it,expect,vi} from "vitest";
import {kitFootprintGeometry,kitConnectorGeometry,kitRoundGeometry,kitCellsGeometry,kitRampGeometry,KIT_CONNECTOR_HEIGHT} from "../src/craft/kitGeometry.js";
import {VoxelWorld} from "../src/craft/voxelWorld.js";
import {VoxelView} from "../src/craft/voxelView.js";
vi.mock("../src/render/textures.js",()=>({loadTexture:()=>Promise.resolve(null)}));
function ray(g:THREE.BufferGeometry,x:number,y:number,z:number,dy:number):THREE.Intersection|undefined {
  const mesh=new THREE.Mesh(g,new THREE.MeshBasicMaterial());mesh.updateMatrixWorld(true);
  const hit=new THREE.Raycaster(new THREE.Vector3(x,y,z),new THREE.Vector3(0,dy,0)).intersectObject(mesh)[0];(mesh.material as THREE.Material).dispose();return hit;
}
function closed(g:THREE.BufferGeometry):void {
  const p=g.getAttribute("position"),edges=new Map<string,number>();
  const point=(i:number)=>[p.getX(i),p.getY(i),p.getZ(i)].map(n=>Math.round(n*1e6)).join(",");
  for(let i=0;i<p.count;i+=3)for(let a=0;a<3;a++){const key=[point(i+a),point(i+(a+1)%3)].sort().join("/");edges.set(key,(edges.get(key)??0)+1);}
  expect([...edges.values()].filter(n=>n!==2)).toHaveLength(0);
  expect(g.getAttribute("color").count).toBe(p.count);
}
describe("moulded block shell",()=>{
  it("has a four small closed studs and a completely flat underside without automatic holes",()=>{
    const g=kitFootprintGeometry([[0,0]]),boss=kitConnectorGeometry();
    for(const x of [.2,.5,.8])for(const z of [.2,.5,.8])expect(ray(g,x,-.5,z,1)!.point.y).toBeCloseTo(0,6);
    expect(ray(boss,0,1,0,-1)).toBeUndefined();
    for(const x of [-.25,.25])for(const z of [-.25,.25])expect(ray(boss,x,1,z,-1)!.point.y).toBeCloseTo(KIT_CONNECTOR_HEIGHT,6);
    expect(boss.boundingBox!.max.y).toBeLessThan(.05);expect(boss.userData.studs).toBe(4);
    closed(g);closed(boss);g.dispose();boss.dispose();
  });
  it("removes internal seams and retains an open courtyard in a joined ring",()=>{
    const bar=kitFootprintGeometry([[0,0],[1,0],[2,0]]),p=bar.getAttribute("position"),n=bar.getAttribute("normal");
    for(let i=0;i<p.count;i++)if(p.getY(i)>.2&&Math.abs(p.getX(i)-1)<1e-6)expect(Math.abs(n.getX(i))).toBeLessThan(.01);
    closed(bar);bar.dispose();
    const ring=kitFootprintGeometry([[0,0],[1,0],[2,0],[0,1],[2,1],[0,2],[1,2],[2,2]]);
    expect(ray(ring,1.5,2,1.5,-1)).toBeUndefined();expect(ray(ring,.5,2,.5,-1)!.point.y).toBeCloseTo(1);
    closed(ring);ring.dispose();
  });
  it("exports closed cube, round, slope and corner surfaces with finite attributes",()=>{
    for(const geometry of [kitFootprintGeometry([[0,0],[1,0],[0,1]]),kitRoundGeometry(),kitRampGeometry(),kitRampGeometry(true)]){
      closed(geometry);for(const attribute of Object.values(geometry.attributes))expect([...attribute.array].every(Number.isFinite)).toBe(true);geometry.dispose();
    }
    const tilted=kitCellsGeometry([[0,0,0],[0,1,0],[0,2,0]]);expect(tilted.boundingBox!.max.y).toBeCloseTo(3+KIT_CONNECTOR_HEIGHT);tilted.dispose();
  });
  it("uses a continuous shell in the actual game and releases its geometry on edits",()=>{
    const world=new VoxelWorld(),scene=new THREE.Scene(),view=new VoxelView(scene);world.setShaped(8,2,8,3,18);world.setShaped(9,2,8,3,18);view.update(world);
    const shells=scene.children.filter((o):o is THREE.InstancedMesh=>{if(!(o instanceof THREE.InstancedMesh)||o.count!==1)return false;const g=o.geometry as THREE.BufferGeometry;return Boolean(g.getAttribute("color"))&&g.boundingBox!.min.x>7;});
    expect(shells[0]).toBeDefined();const geometry=shells[0]!.geometry,disposed=vi.fn();geometry.addEventListener("dispose",disposed);
    expect(geometry.boundingBox!.max.x).toBeCloseTo(9.99,4);
    world.set(9,2,8,0);view.markCellDirty(9,2,8);view.update(world);expect(disposed).toHaveBeenCalledOnce();view.dispose();
  });
});

