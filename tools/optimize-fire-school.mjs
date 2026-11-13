// node tools/optimize-fire-school.mjs [--check]
//
// The fire drill's school as the game loads it: public/models/environments/fire-school/school.glb
// (the Blender export, assets/environments/fire-school/source/build_school.py) made small and
// cheap to draw → school.min.glb beside it.
//   - everything that shares a material becomes ONE mesh (the school never moves): the export's
//     ~255 draw calls become one per material, in the picture AND in the shadow pass
//   - vertices are welded and quantized, the buffers meshopt-compressed (EXT_meshopt_compression):
//     megabytes less to download, and less memory on a phone
//   (meshopt's simplifier was tried, 2026-11-13: 265k triangles came down only to 255k at 5 mm
//   and 231k at 9 cm — the export splits its vertices at every hard edge, so nearly every edge is
//   a border the simplifier keeps. Fewer triangles have to come from the Blender side: fewer bevel
//   segments on the furniture, which is most of the count.)
// The game loads school.min.glb and falls back to school.glb. school.min.json records what the
// .min was made from; `--check` (and test/fire-school-asset.test.ts) fail when school.glb has
// changed since — run this again after every export.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, flatten, join as joinMeshes, meshopt, prune, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../apps/client/public/models/environments/fire-school");
const src = join(dir, "school.glb"), out = join(dir, "school.min.glb"), stamp = join(dir, "school.min.json");
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

if (process.argv.includes("--check")) {
  const made = existsSync(stamp) ? JSON.parse(readFileSync(stamp, "utf8")) : null;
  if (!made || made.source !== sha(src) || !existsSync(out)) {
    console.error("school.min.glb is stale: run `node tools/optimize-fire-school.mjs`");
    process.exit(1);
  }
  console.log("school.min.glb is up to date");
  process.exit(0);
}

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(src);
const count = () => {
  let draws = 0, triangles = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    draws++;
    triangles += (prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION").getCount()) / 3;
  }
  return { draws, triangles: Math.round(triangles), materials: doc.getRoot().listMaterials().length };
};
const before = count();
await doc.transform(
  dedup(), // the same material or mesh exported twice is one
  flatten(), // no node hierarchy: every mesh in the school's own space…
  joinMeshes({ keepNamed: false }), // …so all that share a material can be one mesh
  weld(),
  prune(),
  meshopt({ encoder: MeshoptEncoder, level: "medium" }),
);
await io.write(out, doc);
const after = count();
const record = { source: sha(src), sourceBytes: statSync(src).size, bytes: statSync(out).size, before, after };
writeFileSync(stamp, JSON.stringify(record, null, 2) + "\n");
console.log(`school.glb      ${(record.sourceBytes / 1e6).toFixed(2)} MB  ${before.draws} draw calls  ${before.triangles} triangles  ${before.materials} materials`);
console.log(`school.min.glb  ${(record.bytes / 1e6).toFixed(2)} MB  ${after.draws} draw calls  ${after.triangles} triangles  ${after.materials} materials`);
