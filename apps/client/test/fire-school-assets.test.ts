import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
// Inspect the shipped GLB bytes. Physics tests alone cannot catch invisible,
// inward-facing walls: their collision boxes still work when rendering is broken.
const raw=readFileSync(new URL("../public/models/environments/fire-school/school.glb",import.meta.url));
const jsonLength=raw.readUInt32LE(12);
interface GlbDocument {
 accessors:{bufferView:number;byteOffset?:number;type:string;componentType:number;count:number}[];
 bufferViews:{byteOffset?:number;byteStride?:number}[];
 meshes:{name:string;primitives:{indices:number;attributes:{POSITION:number}}[]}[];
}
const doc=JSON.parse(raw.subarray(20,20+jsonLength).toString()) as GlbDocument;
const binStart=20+jsonLength+8;
function accessor(id:number):number[][]{
 const a=doc.accessors[id]!,v=doc.bufferViews[a.bufferView]!;
 const components=a.type==="VEC3"?3:1,bytes=a.componentType===5126||a.componentType===5125?4:a.componentType===5123?2:1;
 const start=binStart+(v.byteOffset??0)+(a.byteOffset??0),stride=v.byteStride??components*bytes;
 return Array.from({length:a.count},(_,i)=>Array.from({length:components},(_,k)=>{
  const p=start+i*stride+k*bytes;
  return a.componentType===5126?raw.readFloatLE(p):a.componentType===5125?raw.readUInt32LE(p):a.componentType===5123?raw.readUInt16LE(p):raw.readUInt8(p);
 }));
}
describe("the actual school GLB surface winding",()=>{
 for(const name of ["Campus | Ground","Exterior | Chunky corner piers"]){
  it(`${name} encloses positive volume, with outward faces`,()=>{
   const meshes=doc.meshes.filter(m=>m.name===name);if(!meshes.length)throw Error(`missing ${name}`);
   let volume=0;
   for(const mesh of meshes)for(const p of mesh.primitives){
    const xyz=accessor(p.attributes.POSITION),ix=accessor(p.indices).flat();
    for(let j=0;j<ix.length;j+=3){const a=xyz[ix[j]!]!,b=xyz[ix[j+1]!]!,c=xyz[ix[j+2]!]!;
     volume+=(a[0]!*(b[1]!*c[2]!-b[2]!*c[1]!)+a[1]!*(b[2]!*c[0]!-b[0]!*c[2]!)+a[2]!*(b[0]!*c[1]!-b[1]!*c[0]!))/6;
    }
   }
   expect(volume,`${name} is inside out`).toBeGreaterThan(1);
  });
 }
});

// Decorative tiles replace coincident slab faces. These render meshes intentionally
// retain hidden internal faces, so their signed volume is not a valid solid test.
// The Blender BVH audit instead probes the actual exported visible surfaces.
it("has outward visible interior surfaces and complete walls in the audited runtime GLB",()=>{
 const audit=JSON.parse(readFileSync(new URL("../../../assets/environments/fire-school/validation/runtime-visibility-audit.json",import.meta.url),"utf8")) as {glbSha256:string;backfacesVisibleFromFreeAir:number;missingWallOrCeilingSamples:number;raysHittingOpaqueSurface:number;wallAndCeilingChecks:number};
 expect(audit.glbSha256).toBe(createHash("sha256").update(raw).digest("hex"));
 expect(audit.backfacesVisibleFromFreeAir).toBe(0);expect(audit.missingWallOrCeilingSamples).toBe(0);
 expect(audit.raysHittingOpaqueSurface).toBeGreaterThan(15000);expect(audit.wallAndCeilingChecks).toBeGreaterThan(3000);
});
