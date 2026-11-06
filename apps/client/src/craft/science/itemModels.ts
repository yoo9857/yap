/**
 * The 3D models of everything fitted into a plant's sockets: the FRAME pieces (foundation, tower,
 * nacelle) and the working PARTS. Blender GLBs (assets/items/{frames,parts} → public/models/items),
 * with code-built stand-ins drawn to match their icons until a GLB arrives or if it fails — a filled
 * socket never shows empty.
 *
 * Every model is centred on its socket cell, its "front" along +z (the plant's front at rotation
 * 0); the caller turns the group with the site. Clones share geometry and materials (a field of
 * turbines costs one set), and `disposeItemAssets` frees the code-built ones.
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PART_KEYS, isPartKey, type PartKey } from "./parts.js";
import { FRAME_KEYS, type FrameKey } from "./frames.js";

export type ModelKey = PartKey | FrameKey;
export const MODEL_KEYS: readonly ModelKey[] = [...FRAME_KEYS, ...PART_KEYS];

/** Bump `?v=` when a GLB changes. */
export const ITEM_MODEL_URL = (key: ModelKey): string => `/models/items/${isPartKey(key) ? "parts" : "frames"}/${key}.glb?v=2`;
const gltf = new Map<ModelKey, THREE.Object3D>();
let loading: Promise<boolean> | null = null;

/** Load every item GLB once (each on its own: one missing file never hides the others).
 *  Resolves true when every model arrived. */
export function loadItemModels(): Promise<boolean> {
  loading ??= Promise.all(
    MODEL_KEYS.map(async (key) => {
      try {
        const scene = (await new GLTFLoader().loadAsync(ITEM_MODEL_URL(key))).scene;
        const root = scene.getObjectByName(key) ?? scene;
        if (key === "part-blades" && !root.getObjectByName("spin")) throw new Error("part-blades.glb has no spin node");
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.castShadow = true;
            m.receiveShadow = true;
          }
        });
        gltf.set(key, root);
        return true;
      } catch (e) {
        console.warn(`[science] ${key}: no model file, using the built-in one`, e);
        return false;
      }
    }),
  ).then((all) => all.every(Boolean));
  return loading;
}

/** Whether an item shows its Blender model (dev hook / tests). */
export function itemModelSource(key: ModelKey): "glb" | "code" {
  return gltf.has(key) ? "glb" : "code";
}

let assets: ReturnType<typeof makeAssets> | null = null;

function makeAssets() {
  const mat = (color: number, metalness = 0.05, roughness = 0.55) => new THREE.MeshStandardMaterial({ color, metalness, roughness });
  return {
    steel: mat(0xaeb8c2, 0.35, 0.45),
    steelDark: mat(0x7f8994, 0.35, 0.5),
    copper: mat(0xd98a4a, 0.55, 0.35),
    gold: mat(0xffcf3a, 0.1, 0.45),
    green: mat(0x86ad94),
    white: mat(0xf4f6f8, 0.02, 0.5),
    hubGrey: mat(0xc9cfd6, 0.1, 0.5),
    blue: mat(0x6fa8e8, 0.05, 0.4),
    navy: mat(0x4a6496, 0.05, 0.6),
    red: mat(0xe0564f),
    black: mat(0x3a3d44),
    concrete: mat(0xc9cdd3, 0.0, 0.8),
    towerWhite: mat(0xf2f4f7, 0.02, 0.45),
    padGeo: new RoundedBoxGeometry(1, 1, 1, 2, 0.05),
    tubeGeo: new THREE.CylinderGeometry(0.39, 0.39, 1, 28),
    topGeo: new THREE.CylinderGeometry(0.36, 0.39, 1, 28),
    ringGeo: new THREE.CylinderGeometry(0.43, 0.43, 0.06, 28),
    doorGeo: new RoundedBoxGeometry(0.3, 0.5, 0.06, 2, 0.02),
    shellGeo: new RoundedBoxGeometry(0.86, 0.78, 0.96, 4, 0.18),
    flangeGeo: new THREE.CylinderGeometry(0.3, 0.3, 0.06, 24).rotateX(Math.PI / 2),
    // geometries
    body: new THREE.CylinderGeometry(0.33, 0.33, 0.62, 20).rotateX(Math.PI / 2),
    endCap: new THREE.CylinderGeometry(0.36, 0.36, 0.12, 20).rotateX(Math.PI / 2),
    coil: new THREE.TorusGeometry(0.34, 0.045, 10, 28),
    shaft: new THREE.CylinderGeometry(0.07, 0.07, 0.3, 12).rotateX(Math.PI / 2),
    bolt: new THREE.BoxGeometry(0.1, 0.16, 0.03),
    base: new RoundedBoxGeometry(0.62, 0.1, 0.78, 2, 0.04),
    hub: new THREE.SphereGeometry(0.2, 18, 14),
    nose: new THREE.SphereGeometry(0.1, 14, 10),
    // a blade: long, flat, rounded, narrowing toward the tip (tapered box)
    blade: (() => {
      const g = new RoundedBoxGeometry(0.26, 2.5, 0.07, 2, 0.03);
      const p = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);
        const k = 1 - 0.55 * ((y + 1.25) / 2.5); // full width at the root, 45% at the tip
        p.setX(i, p.getX(i) * k);
      }
      g.translate(0, 1.25 + 0.12, 0); // root at the hub
      g.computeVertexNormals();
      return g;
    })(),
    box: new RoundedBoxGeometry(0.52, 0.36, 0.42, 3, 0.07),
    post: new THREE.CylinderGeometry(0.05, 0.05, 0.12, 10),
    nut: new THREE.CylinderGeometry(0.08, 0.08, 0.05, 6),
    cap: new THREE.CylinderGeometry(0.075, 0.085, 0.1, 8),
    cable: new THREE.TorusGeometry(0.11, 0.03, 8, 20),
  };
}

function shared() {
  return (assets ??= makeAssets());
}

const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
};

function generator(): THREE.Group {
  const a = shared();
  const g = new THREE.Group();
  g.add(mesh(a.base, a.green, 0, -0.4, 0));
  g.add(mesh(a.body, a.steel, 0, -0.04, 0));
  g.add(mesh(a.endCap, a.steelDark, 0, -0.04, 0.34));
  g.add(mesh(a.endCap, a.steelDark, 0, -0.04, -0.34));
  for (const z of [-0.18, -0.06, 0.06, 0.18]) g.add(mesh(a.coil, a.copper, 0, -0.04, z));
  g.add(mesh(a.shaft, a.steel, 0, -0.04, 0.5));
  const bolt = mesh(a.bolt, a.gold, 0.35, -0.04, 0);
  bolt.rotation.y = Math.PI / 2;
  g.add(bolt);
  const bolt2 = bolt.clone();
  bolt2.position.x = -0.35;
  g.add(bolt2);
  return g;
}

/** The rotor; its child "spin" is what turns while the plant runs. */
function blades(): THREE.Group {
  const a = shared();
  const g = new THREE.Group();
  const spin = new THREE.Group();
  spin.name = "spin";
  spin.position.z = -0.25; // the hub sits against the white hub block behind the slot
  spin.add(mesh(a.hub, a.hubGrey));
  spin.add(mesh(a.nose, a.blue, 0, 0, 0.17));
  for (let i = 0; i < 3; i++) {
    const b = mesh(a.blade, a.white);
    b.rotation.z = (i * Math.PI * 2) / 3;
    b.rotateY(0.3); // a little pitch, like a real blade
    spin.add(b);
  }
  g.add(spin);
  return g;
}

function terminal(): THREE.Group {
  const a = shared();
  const g = new THREE.Group();
  g.add(mesh(a.box, a.navy, 0, -0.32, 0));
  for (const [x, cap] of [[-0.12, a.red], [0.12, a.black]] as const) {
    g.add(mesh(a.nut, a.copper, x, -0.12, 0));
    g.add(mesh(a.post, a.copper, x, -0.06, 0));
    g.add(mesh(a.cap, cap, x, 0.03, 0));
  }
  const coil = mesh(a.cable, a.copper, 0.3, -0.36, 0);
  coil.rotation.y = Math.PI / 2;
  g.add(coil);
  return g;
}

/** Code-built frame stand-ins (the GLB replaces them as soon as it lands). */
function frameModel(key: FrameKey): THREE.Group {
  const a = shared();
  const g = new THREE.Group();
  switch (key) {
    case "frame-foundation":
      g.add(mesh(a.padGeo, a.concrete));
      break;
    case "frame-foundation-center":
      g.add(mesh(a.padGeo, a.concrete));
      g.add(mesh(a.ringGeo, a.steel, 0, 0.5, 0));
      break;
    case "frame-tower-base":
      g.add(mesh(a.tubeGeo, a.towerWhite));
      g.add(mesh(a.ringGeo, a.steel, 0, -0.47, 0));
      g.add(mesh(a.doorGeo, a.navy, 0, -0.18, 0.38));
      break;
    case "frame-tower":
      g.add(mesh(a.tubeGeo, a.towerWhite));
      g.add(mesh(a.ringGeo, a.steel, 0, 0.47, 0));
      break;
    case "frame-tower-top":
      g.add(mesh(a.topGeo, a.towerWhite));
      g.add(mesh(a.ringGeo, a.steelDark, 0, 0.47, 0));
      break;
    case "frame-nacelle-tail":
      g.add(mesh(a.shellGeo, a.white, 0, 0, -0.02));
      break;
    case "frame-hub":
      g.add(mesh(a.shellGeo, a.white, 0, 0, 0.02));
      g.add(mesh(a.flangeGeo, a.steel, 0, 0, 0.47));
      break;
  }
  return g;
}

/**
 * Where a model sits inside its socket beyond the cell centre (cell units, rotation-0 frame).
 * The rotor's hub must sit ON the hub block's front flange: the blades' GLB keeps its hub 0.33 m
 * behind the socket centre, i.e. 0.17 m short of the flange at −0.5, which read as a rotor floating
 * in front of the turbine.
 */
const MODEL_OFFSET: Partial<Record<ModelKey, readonly [number, number, number]>> = {
  "part-blades": [0, 0, -0.17],
};

export function itemModel(key: ModelKey): THREE.Group {
  const source = gltf.get(key);
  // a clone shares the GLB's geometry and materials: a field of turbines costs one set
  const g = source
    ? wrap(source.clone(true))
    : key === "part-generator" ? generator() : key === "part-blades" ? blades() : key === "part-wire-terminal" ? terminal() : frameModel(key);
  g.name = key;
  const off = MODEL_OFFSET[key];
  if (off) for (const c of g.children) c.position.set(c.position.x + off[0], c.position.y + off[1], c.position.z + off[2]);
  g.traverse((o) => (o.raycast = () => {})); // never a target: the aim passes through to the blocks
  return g;
}

function wrap(o: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  o.position.set(0, 0, 0);
  g.add(o);
  return g;
}

/** Free the shared geometries and materials (when the game is torn down). */
export function disposeItemAssets(): void {
  if (!assets) return;
  for (const v of Object.values(assets)) (v as { dispose?: () => void }).dispose?.();
  assets = null;
}
