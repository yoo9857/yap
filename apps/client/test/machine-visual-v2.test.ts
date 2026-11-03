import {beforeAll,describe,expect,it,vi} from "vitest";
import {readFile} from "node:fs/promises";
import * as T from "three";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";
import {MachineAssets,MachineVisual,GhostPart,wheelMountSide,type MachineRole} from "../src/craft/machines/machineVisual.js";
import {preset,PART_ORDER,type PartKind} from "../src/craft/machines/blueprint.js";
import {PHYSICS_RULES} from "../src/craft/machines/physicsRules.js";
let assets:MachineAssets,low:T.Group;
async function load(file:string){const raw=await readFile(new URL('../public/models/machines/'+file,import.meta.url)),loader=new GLTFLoader();loader.register(()=>({name:"TEST_TEXTURES",loadTexture:()=>Promise.resolve(new T.Texture())}));return (await loader.parseAsync(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength),"")).scene;}
beforeAll(async()=>{assets=new MachineAssets();for(const root of (await load("machine-kit.glb")).children){const templates:{geometry:T.BufferGeometry;material:T.Material;role:MachineRole}[]=[];root.traverse(o=>{if(o instanceof T.Mesh)templates.push({geometry:o.geometry as T.BufferGeometry,material:o.material as T.Material,role:o.userData.machineRole as MachineRole});});assets.templates.set(root.name as PartKind,templates);}assets.loaded=true;low=await load("machine-kit-lod1.glb");});
const matrix=(mesh:T.InstancedMesh,index:number)=>{const slot=(mesh.userData.partIndices as number[]).indexOf(index);const m=new T.Matrix4();mesh.getMatrixAt(slot,m);return m;};
describe("Blender machine modules in the actual game visual",()=>{
 it("releases shared paint and normal textures exactly once when the asset owner closes",()=>{
  const owner=new MachineAssets(),texture=new T.Texture(),geometry=new T.BoxGeometry(),a=new T.MeshStandardMaterial({map:texture,normalMap:texture}),b=new T.MeshStandardMaterial({map:texture});
  owner.templates.set("frame",[{geometry,material:a},{geometry,material:b}]);const releaseTexture=vi.spyOn(texture,"dispose"),releaseGeometry=vi.spyOn(geometry,"dispose");owner.dispose();owner.dispose();expect(releaseTexture).toHaveBeenCalledTimes(1);expect(releaseGeometry).toHaveBeenCalledTimes(1);expect(owner.templates.size).toBe(0);
 });
 it("supplies the same eight module names in both LODs, with baked origin, UVs and finite normals",()=>{
  expect([...assets.templates.keys()].sort()).toEqual([...PART_ORDER].sort());expect(low.children.map(c=>c.name).sort()).toEqual([...PART_ORDER].sort());
  for(const templates of assets.templates.values())for(const t of templates){expect(t.geometry.getAttribute("uv").count).toBe(t.geometry.getAttribute("position").count);expect(Array.from(t.geometry.getAttribute("position").array).every(Number.isFinite)).toBe(true);expect(t.geometry.getAttribute("normal").count).toBeGreaterThan(0);}
  low.traverse(o=>{if(o instanceof T.Mesh){expect(o.position.length()).toBeLessThan(1e-8);expect(o.quaternion.angleTo(new T.Quaternion())).toBeLessThan(1e-8);}});
 });
 it("matches the real wheel radius and X axle after Blender's coordinate conversion",()=>{
  const bounds=new T.Box3();for(const t of assets.templates.get("wheel")!)if(t.role==="body"){t.geometry.computeBoundingBox();bounds.union(t.geometry.boundingBox!);}const size=bounds.getSize(new T.Vector3());expect(size.y).toBeCloseTo(PHYSICS_RULES.wheelRadius*2,2);expect(size.z).toBeCloseTo(PHYSICS_RULES.wheelRadius*2,2);expect(size.x).toBeLessThan(.6);
 });
 it("connects left and right wheels inward and leaves an unsupported wheel unmounted",()=>{
  const b=preset("rover");expect(wheelMountSide(b,[2,0,2])).toBe(1);expect(wheelMountSide(b,[-2,0,2])).toBe(-1);expect(wheelMountSide(b,[7,0,7])).toBe(0);
 });
 it("keeps the mount fixed while the tire spins, hub steers and spring follows suspension travel",()=>{
  const b=preset("rover"),v=new MachineVisual(assets);v.rebuild(b);const index=b.parts.findIndex(p=>p.kind==="wheel"&&p.cell[0]>0),mesh=(role:string)=>v.meshes.find(m=>m.userData.machineRole===role&&(m.userData.partIndices as number[]).includes(index))!;
  const fixed=matrix(mesh("wheel-fixed"),index),tire=matrix(mesh("body"),index);v.wheel(index,.38,2,.3);v.flushWheels();expect(matrix(mesh("wheel-fixed"),index).elements).toEqual(fixed.elements);expect(matrix(mesh("body"),index).equals(tire)).toBe(false);
  const p=new T.Vector3(),q=new T.Quaternion(),scale=new T.Vector3();matrix(mesh("wheel-hub"),index).decompose(p,q,scale);expect(p.y).toBeCloseTo(-.38);matrix(mesh("wheel-strut"),index).decompose(p,q,scale);expect(scale.y).toBeCloseTo(.38/PHYSICS_RULES.suspensionLength);v.dispose();
 });
 it("hides covered studs and restores them when a stacked part is removed",()=>{
  const b=preset("rover"),v=new MachineVisual(assets),under=b.parts.findIndex(p=>p.kind==="frame"&&p.cell[0]===0&&p.cell[2]===0);v.rebuild(b);
  const visible=()=>v.meshes.filter(m=>m.userData.machineRole==="studs").some(m=>(m.userData.partIndices as number[]).includes(under));expect(visible()).toBe(false);b.parts=b.parts.filter(p=>p.kind!=="gyro");v.rebuild(b);expect(visible()).toBe(true);v.dispose();
 });
 it("preserves a child's chosen paint after hovering or erasing highlights",()=>{
  const b=preset("rover"),v=new MachineVisual(assets);b.parts[0]!.custom={color:"coral"};v.rebuild(b);const mesh=v.meshes.find(m=>m.material instanceof T.Material&&m.material.name==="Warm enamel"&&(m.userData.partIndices as number[]).includes(0))!,slot=(mesh.userData.partIndices as number[]).indexOf(0),before=new T.Color(),after=new T.Color();mesh.getColorAt(slot,before);v.highlight(0,new T.Color(0xff6688));v.highlight(-1,new T.Color());mesh.getColorAt(slot,after);expect(after.r).toBeCloseTo(before.r);expect(after.g).toBeCloseTo(before.g);expect(after.b).toBeCloseTo(before.b);v.dispose();
 });
 it("previews a wheel at the same suspended height used by the real assembled model",()=>{
  const ghost=new GhostPart(assets);ghost.set("wheel",0,-1);const tire=ghost.root.children.find(m=>m.userData.machineRole==="body")!;expect(tire.position.y).toBe(-PHYSICS_RULES.suspensionLength);const mount=ghost.root.children.find(m=>m.userData.machineRole==="wheel-fixed")!;expect(mount.rotation.y).toBe(Math.PI);ghost.dispose();
 });
});
