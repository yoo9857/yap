import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { kitConnectorGeometry } from "../src/craft/kitGeometry.js";
import { STUD_HQ_DISTANCE } from "../src/craft/blockStuds.js";

// The brick-top studs are a Blender asset (assets/blocks/studs) that the web game and the native
// client both read. These pin the exported GLB to its source and to the shape the game always had.
const root = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root));
interface Manifest { lodDistance: number; file: { sha256: string }; meshes: Record<"Stud_HQ" | "Stud_LOD1", { triangles: number }> }
interface Gltf {
  meshes: { name: string; primitives: { attributes: Record<string, number>; indices: number }[] }[];
  accessors: { bufferView: number; byteOffset?: number; count: number; type: string; componentType: number }[];
  bufferViews: { byteOffset?: number }[];
}
type Mesh = { pos: Float32Array; index: Uint16Array | Uint32Array };
const manifest = JSON.parse(read("assets/blocks/studs/runtime/manifest.json").toString("utf8")) as Manifest;

/** A GLB's meshes as flat position / index arrays, by mesh name. */
function meshes(glb: Buffer): Map<string, Mesh> {
  const json = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12))) as Gltf;
  const binStart = 20 + glb.readUInt32LE(12) + 8;
  const view = (accessor: number) => {
    const a = json.accessors[accessor]!, v = json.bufferViews[a.bufferView]!;
    const off = binStart + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const n = a.count * ({ SCALAR: 1, VEC2: 2, VEC3: 3 } as Record<string, number>)[a.type]!;
    const bytes = glb.buffer.slice(glb.byteOffset + off, glb.byteOffset + off + n * (a.componentType === 5126 || a.componentType === 5125 ? 4 : 2));
    return a.componentType === 5126 ? new Float32Array(bytes) : a.componentType === 5125 ? new Uint32Array(bytes) : new Uint16Array(bytes);
  };
  const out = new Map<string, Mesh>();
  for (const m of json.meshes) {
    const p = m.primitives[0]!;
    out.set(m.name, { pos: view(p.attributes.POSITION!) as Float32Array, index: view(p.indices) as Uint16Array });
  }
  return out;
}

const glb = read("apps/client/public/models/blocks/block-studs.glb");

describe("block studs (Blender asset)", () => {
  it("the game serves exactly the exported GLB the manifest names", () => {
    const runtime = read("assets/blocks/studs/runtime/block-studs.glb");
    expect(glb.equals(runtime)).toBe(true);
    expect(createHash("sha256").update(glb).digest("hex")).toBe(manifest.file.sha256);
    expect(manifest.lodDistance).toBe(STUD_HQ_DISTANCE);
  });

  it("Stud_HQ is the approved block's studs: the same surface points as the code twin", () => {
    const hq = meshes(glb).get("Stud_HQ")!;
    expect(hq.index.length / 3).toBe(manifest.meshes.Stud_HQ.triangles);
    const key = (x: number, y: number, z: number) => [x, y, z].map((v) => Math.round(v * 1e4)).join(",");
    const fromBlender = new Set<string>();
    for (let i = 0; i < hq.pos.length; i += 3) fromBlender.add(key(hq.pos[i]!, hq.pos[i + 1]!, hq.pos[i + 2]!));
    // the code twin, minus its bottom caps (they lie on the brick and the export drops them)
    const code = kitConnectorGeometry().getAttribute("position");
    const fromCode = new Set<string>();
    for (let i = 0; i < code.count; i++) fromCode.add(key(code.getX(i), code.getY(i), code.getZ(i)));
    expect([...fromBlender].sort()).toEqual([...fromCode].sort());
  });

  it("Stud_LOD1 keeps the silhouette at about a quarter of the triangles", () => {
    const m = meshes(glb), hq = m.get("Stud_HQ")!, lod = m.get("Stud_LOD1")!;
    expect(lod.index.length / 3).toBe(manifest.meshes.Stud_LOD1.triangles);
    expect(lod.index.length).toBeLessThan(hq.index.length * 0.3);
    const bounds = (p: Float32Array) => [0, 1, 2].map((k) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = k; i < p.length; i += 3) { lo = Math.min(lo, p[i]!); hi = Math.max(hi, p[i]!); }
      return [lo, hi];
    });
    // same footprint (four 20 cm studs on 0.5 m centres) and the same 4 cm height
    const [b0, b1] = [bounds(hq.pos), bounds(lod.pos)];
    for (let k = 0; k < 3; k++) for (let e = 0; e < 2; e++) expect(Math.abs(b0[k]![e]! - b1[k]![e]!)).toBeLessThan(0.0021);
    expect(b0[1]![1]).toBeCloseTo(0.04, 4);
  });
});
