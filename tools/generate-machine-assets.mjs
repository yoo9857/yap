// Original procedural assets. Rebuild: node tools/generate-machine-assets.mjs
// No downloaded models or runtime modelling dependency; outputs standard GLB.
import * as T from "../apps/client/node_modules/three/build/three.module.js";
import { RoundedBoxGeometry } from "../apps/client/node_modules/three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "../apps/client/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js";
import { GLTFExporter } from "../apps/client/node_modules/three/examples/jsm/exporters/GLTFExporter.js";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Exporter's Blob reader has a browser API; Node's Blob already handles bytes.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }
};
const out = new URL("../apps/client/public/models/machines/", import.meta.url);
const verifyOnly = process.argv.includes("--check");
const palette = {
  ceramic: new T.MeshStandardMaterial({
    name: "Ceramic enamel",
    color: 0xe8e6d6,
    roughness: 0.32,
    metalness: 0.25,
  }),
  graphite: new T.MeshStandardMaterial({
    name: "Graphite chassis",
    color: 0x293640,
    roughness: 0.55,
    metalness: 0.65,
  }),
  steel: new T.MeshStandardMaterial({
    name: "Machined aluminium",
    color: 0xa2b3b8,
    roughness: 0.26,
    metalness: 0.85,
  }),
  brass: new T.MeshStandardMaterial({
    name: "Safety ochre",
    color: 0xe6a53b,
    roughness: 0.38,
    metalness: 0.45,
  }),
  signal: new T.MeshStandardMaterial({
    name: "Status cyan",
    color: 0x7cebd8,
    emissive: 0x38cdbb,
    emissiveIntensity: 1.6,
    roughness: 0.3,
  }),
  glass: new T.MeshStandardMaterial({
    name: "Smoked canopy",
    color: 0x427b8b,
    roughness: 0.12,
    metalness: 0.4,
    transparent: true,
    opacity: 0.72,
    side: T.DoubleSide,
  }),
  rubber: new T.MeshStandardMaterial({
    name: "Tire rubber",
    color: 0x18232a,
    roughness: 0.95,
    metalness: 0,
  }),
};
function kit(low = false) {
  const scene = new T.Scene();
  const segments = low ? 12 : 24;
  const make = (name, build) => {
    const source = new T.Group();
    source.name = name;
    const mesh = (geo, mat, x = 0, y = 0, z = 0, rot) => {
      const m = new T.Mesh(geo, palette[mat]);
      m.position.set(x, y, z);
      if (rot) m.rotation.set(...rot);
      source.add(m);
      return m;
    };
    const box = (w, h, d, mat, x = 0, y = 0, z = 0, soft = 0) =>
      mesh(
        soft
          ? new RoundedBoxGeometry(w, h, d, 1, soft)
          : new T.BoxGeometry(w, h, d),
        mat,
        x,
        y,
        z,
      );
    const cylinder = (r1, r2, h, mat, x = 0, y = 0, z = 0, rot) =>
      mesh(new T.CylinderGeometry(r1, r2, h, segments), mat, x, y, z, rot);
    const ring = (r, t, mat, x = 0, y = 0, z = 0, rot) =>
      mesh(new T.TorusGeometry(r, t, low ? 4 : 8, segments), mat, x, y, z, rot);
    const bolt = (x, y, z) => cylinder(0.034, 0.034, 0.025, "steel", x, y, z);
    build({ mesh, box, cylinder, ring, bolt });
    source.updateMatrixWorld(true);
    const byMaterial = new Map();
    source.traverse((o) => {
      if (!o.isMesh) return;
      const geo = o.geometry.index
        ? o.geometry.toNonIndexed()
        : o.geometry.clone();
      geo.applyMatrix4(o.matrixWorld);
      const list = byMaterial.get(o.material) ?? [];
      list.push(geo);
      byMaterial.set(o.material, list);
    });
    const baked = new T.Group();
    baked.name = name;
    for (const [material, geometries] of byMaterial) {
      const merged = mergeGeometries(geometries, false);
      merged.computeBoundingBox();
      const m = new T.Mesh(merged, material);
      m.name = `${name}_${material.name.replaceAll(" ", "_")}`;
      baked.add(m);
      for (const geo of geometries) geo.dispose();
    }
    scene.add(baked);
  };
  make("frame", ({ box, bolt }) => {
    box(0.94, 0.12, 0.94, "ceramic", 0, 0.39, 0, 0.035);
    box(0.92, 0.09, 0.92, "graphite", 0, -0.4, 0, 0.025);
    for (const x of [-0.36, 0.36])
      for (const z of [-0.36, 0.36]) {
        box(0.12, 0.7, 0.12, "brass", x, 0, z);
        if (!low) bolt(x, 0.47, z);
      }
    for (const z of [-0.44, 0.44]) {
      box(0.62, 0.19, 0.06, "graphite", 0, -0.02, z);
      box(0.32, 0.05, 0.025, "brass", 0, 0.02, z + Math.sign(z) * 0.036);
    }
    for (const x of [-0.44, 0.44])
      box(0.055, 0.17, 0.65, "graphite", x, -0.02, 0);
    box(0.6, 0.008, 0.03, "graphite", 0, 0.455, 0.25);
    box(0.15, 0.01, 0.05, "brass", -0.22, 0.455, -0.25);
    box(0.09, 0.01, 0.05, "brass", -0.07, 0.455, -0.25);
  });
  make("cockpit", ({ box, cylinder, mesh }) => {
    box(0.94, 0.14, 0.95, "graphite", 0, -0.4, 0, 0.04);
    box(0.82, 0.45, 0.18, "graphite", 0, -0.13, -0.23, 0.035);
    box(0.5, 0.16, 0.46, "rubber", 0, -0.22, -0.04, 0.035);
    box(0.49, 0.48, 0.13, "rubber", 0, 0.03, -0.23, 0.035);
    for (const x of [-0.41, 0.41]) {
      box(0.12, 0.77, 0.11, "ceramic", x, 0.04, -0.38, 0.025);
      const front = box(0.1, 0.72, 0.1, "ceramic", x, 0.015, 0.34, 0.022);
      front.rotation.x = -0.23;
      box(0.12, 0.11, 0.85, "ceramic", x, 0.43, -0.04, 0.025);
      box(0.018, 0.55, 0.68, "glass", x, 0.03, 0);
    }
    const windscreen = box(0.72, 0.61, 0.025, "glass", 0, 0.05, 0.405);
    windscreen.rotation.x = -0.23;
    box(0.93, 0.11, 0.9, "ceramic", 0, 0.49, -0.02, 0.035);
    box(0.7, 0.06, 0.045, "signal", 0, 0.47, 0.46);
    box(0.67, 0.15, 0.18, "graphite", 0, -0.12, 0.25);
    const dashboard = box(0.23, 0.015, 0.12, "signal", 0, -0.028, 0.22);
    dashboard.rotation.x = 0.25;
    if (!low) {
      for (const x of [-0.24, 0.24])
        cylinder(0.022, 0.022, 0.12, "steel", x, -0.01, 0.1);
      for (const x of [-0.38, 0.38])
        mesh(new T.TorusGeometry(0.035, 0.013, 6, 12), "brass", x, -0.3, 0.45);
    }
  });
  make("wheel", ({ box, cylinder, ring }) => {
    cylinder(0.53, 0.53, 0.45, "rubber", 0, 0, 0, [0, 0, Math.PI / 2]);
    for (const side of [-1, 1]) {
      ring(0.4, 0.1, "rubber", side * 0.24, 0, 0, [0, Math.PI / 2, 0]);
      cylinder(0.32, 0.32, 0.05, "steel", side * 0.25, 0, 0, [
        0,
        0,
        Math.PI / 2,
      ]);
      cylinder(0.22, 0.22, 0.058, "graphite", side * 0.28, 0, 0, [
        0,
        0,
        Math.PI / 2,
      ]);
      cylinder(0.1, 0.1, 0.07, "brass", side * 0.31, 0, 0, [0, 0, Math.PI / 2]);
      if (!low)
        for (let i = 0; i < 6; i++) {
          const a = (i * Math.PI) / 3;
          cylinder(
            0.027,
            0.027,
            0.035,
            "steel",
            side * 0.32,
            Math.cos(a) * 0.24,
            Math.sin(a) * 0.24,
            [0, 0, Math.PI / 2],
          );
        }
    }
    for (let i = 0; i < (low ? 12 : 24); i++) {
      const a = (i * Math.PI * 2) / (low ? 12 : 24);
      for (const side of [-1, 1]) {
        const tread = box(
          0.22,
          0.07,
          0.11,
          "rubber",
          side * 0.125,
          Math.cos(a) * 0.535,
          Math.sin(a) * 0.535,
        );
        tread.rotation.x = a;
        tread.rotation.y = side * 0.25;
      }
    }
  });
  make("thruster", ({ box, cylinder, ring }) => {
    cylinder(0.3, 0.3, 0.62, "graphite", 0, 0.08, 0);
    cylinder(0.4, 0.38, 0.16, "ceramic", 0, 0.36, 0);
    cylinder(0.33, 0.43, 0.23, "steel", 0, -0.32, 0);
    cylinder(0.31, 0.36, 0.03, "rubber", 0, -0.452, 0);
    cylinder(0.22, 0.27, 0.035, "signal", 0, -0.47, 0);
    ring(0.33, 0.033, "brass", 0, -0.19, 0, [Math.PI / 2, 0, 0]);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const fin = box(
        0.12,
        0.48,
        0.19,
        "brass",
        Math.cos(a) * 0.32,
        0.07,
        Math.sin(a) * 0.32,
        0.018,
      );
      fin.rotation.y = -a;
      if (!low)
        cylinder(
          0.025,
          0.025,
          0.38,
          "steel",
          Math.cos(a + 0.5) * 0.29,
          0.05,
          Math.sin(a + 0.5) * 0.29,
        );
    }
    box(0.1, 0.07, 0.1, "signal", 0, 0.46, 0);
  });
  make("ballast", ({ box, cylinder, ring }) => {
    box(0.92, 0.84, 0.92, "graphite", 0, -0.02, 0, 0.05);
    for (const y of [-0.3, 0.02, 0.34]) box(0.96, 0.1, 0.96, "brass", 0, y, 0);
    box(0.5, 0.1, 0.5, "steel", 0, 0.44, 0, 0.03);
    ring(0.2, 0.045, "steel", 0, 0.49, 0, [Math.PI / 2, 0, 0]);
    if (!low)
      for (const x of [-0.34, 0.34])
        for (const z of [-0.34, 0.34])
          cylinder(0.05, 0.05, 0.06, "steel", x, 0.4, z);
  });
  make("wing", ({ box, cylinder }) => {
    // Panel normal is +Y and the chord runs along Z, so a row of wing parts
    // along X reads as one continuous span.
    box(1.26, 0.07, 0.86, "ceramic", 0, 0, 0, 0.03);
    cylinder(0.075, 0.075, 1.26, "steel", 0, 0.01, 0.43, [0, 0, Math.PI / 2]);
    box(1.2, 0.03, 0.2, "brass", 0, 0.01, -0.44);
    for (const x of [-0.42, 0, 0.42]) box(0.06, 0.11, 0.78, "brass", x, 0, 0);
    box(0.26, 0.035, 0.12, "signal", 0.46, 0.055, -0.3);
    if (!low)
      for (const x of [-0.56, 0.56]) box(0.05, 0.16, 0.5, "graphite", x, 0, 0);
  });
  make("balloon", ({ box, cylinder, mesh }) => {
    mesh(new T.SphereGeometry(0.46, segments, low ? 8 : 16), "ceramic", 0, 0.14, 0);
    for (let i = 0; i < (low ? 3 : 5); i++) {
      const a = (i * Math.PI) / (low ? 3 : 5);
      const band = mesh(
        new T.TorusGeometry(0.462, 0.016, low ? 4 : 6, segments),
        "brass",
        0,
        0.14,
        0,
      );
      band.rotation.y = a;
      band.rotation.x = Math.PI / 2;
    }
    cylinder(0.12, 0.17, 0.12, "graphite", 0, -0.32, 0);
    box(0.3, 0.16, 0.3, "brass", 0, -0.44, 0, 0.03);
    if (!low)
      for (const x of [-0.17, 0.17])
        for (const z of [-0.17, 0.17])
          cylinder(0.014, 0.014, 0.42, "steel", x, -0.16, z);
  });
  make("gyro", ({ box, ring, mesh }) => {
    box(0.88, 0.11, 0.88, "graphite", 0, -0.39, 0, 0.035);
    for (const x of [-0.36, 0.36])
      for (const z of [-0.36, 0.36]) box(0.075, 0.74, 0.075, "steel", x, 0, z);
    box(0.87, 0.065, 0.87, "ceramic", 0, 0.4, 0, 0.025);
    ring(0.3, 0.028, "brass");
    ring(0.27, 0.028, "steel", 0, 0, 0, [Math.PI / 2, 0, 0]);
    ring(0.24, 0.025, "brass", 0, 0, 0, [0, Math.PI / 2, 0]);
    mesh(new T.IcosahedronGeometry(0.15, low ? 0 : 1), "signal");
    box(0.32, 0.085, 0.04, "signal", 0, -0.28, 0.44);
  });
  return scene;
}

async function compile(low) {
  const scene = kit(low),
    report = [];
  for (const part of scene.children) {
    let triangles = 0;
    part.traverse((o) => {
      if (o.isMesh)
        triangles +=
          (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
    });
    const bounds = new T.Box3().setFromObject(part),
      size = bounds.getSize(new T.Vector3());
    if (
      !Number.isFinite(triangles) ||
      triangles > 12000 ||
      Math.max(size.x, size.y, size.z) > 1.3
    )
      throw new Error(`Asset budget/bounds failed: ${part.name}`);
    report.push({
      part: part.name,
      triangles,
      primitives: part.children.length,
      size: size.toArray().map((n) => +n.toFixed(3)),
    });
  }
  const bytes = Buffer.from(
    await new GLTFExporter().parseAsync(scene, {
      binary: true,
      onlyVisible: true,
    }),
  );
  if (
    bytes.readUInt32LE(0) !== 0x46546c67 ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    throw new Error("Invalid GLB header");
  return { bytes, report };
}

if (!verifyOnly) await mkdir(out, { recursive: true });
const manifest = {
  version: 1,
  source: "tools/generate-machine-assets.mjs",
  provenance: "Original procedural geometry; no third-party model assets",
  units: "metres",
  forward: "+Z",
  up: "+Y",
  wheelAxis: "+X",
  files: [],
};
for (const low of [false, true]) {
  const { bytes, report } = await compile(low),
    file = low ? "machine-kit-lod1.glb" : "machine-kit.glb";
  if (verifyOnly) {
    const existing = await readFile(new URL(file, out));
    if (!existing.equals(bytes))
      throw new Error(`Stale generated asset: ${file}. Run assets:machines.`);
  } else await writeFile(new URL(file, out), bytes);
  manifest.files.push({
    file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    parts: report,
  });
  console.log(
    `${verifyOnly ? "Verified" : "Generated"} ${file}: ${(bytes.length / 1024).toFixed(0)} KB, ${report.reduce((n, p) => n + p.triangles, 0)} triangles`,
  );
}
const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
if (verifyOnly) {
  if ((await readFile(new URL("manifest.json", out), "utf8")) !== manifestBytes)
    throw new Error("Stale asset manifest");
} else await writeFile(new URL("manifest.json", out), manifestBytes);
