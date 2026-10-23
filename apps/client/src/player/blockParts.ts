import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { HULL_LAYER, INK_LAYER } from "../render/inkOutline.js";

/**
 * The shared toy-brick toolkit every CraftYap creature is drawn with: soft
 * rounded boxes, a constant-width ink outline, and one faint crayon grain.
 *
 * It lives apart from `rig.ts` so the biped mascots and the quadruped pet are
 * literally the same material and the same line weight — a second copy would
 * mean a second grain canvas uploaded to the GPU and a second material cache,
 * and the two casts would quietly drift apart in look.
 */

// ---- shared geometry (soft rounded boxes, cached by size) ------------------
const geoCache = new Map<string, RoundedBoxGeometry>();

export function box(w: number, h: number, d: number, soft = 0.24): RoundedBoxGeometry {
  const key = `${w.toFixed(2)},${h.toFixed(2)},${d.toFixed(2)},${soft}`;
  let g = geoCache.get(key);
  if (!g) {
    g = new RoundedBoxGeometry(w, h, d, 4, Math.min(w, h, d) * soft);
    geoCache.set(key, g);
  }
  return g;
}

export const STUD_GEO = new THREE.CylinderGeometry(0.1, 0.105, 0.08, 18);

/**
 * Ink outline: an inverted hull pushed out along the normal in the vertex
 * shader.
 *
 * The offset SCALES WITH THE PART. It used to be a flat 2 cm on everything,
 * which is right for a 1 m body and catastrophic for a 6 cm eye or a 2 cm
 * mouth: the hull was wider than the brick inside it, so every facial feature
 * rendered as a black blob and the animals looked like they were wearing
 * stickers. Big shapes still get exactly 2 cm, so nothing already approved
 * changes; small ones get a line that reads as drawn rather than as a border.
 *
 * Widths are quantised to the nearest 0.5 mm so the material cache stays at a
 * handful of entries instead of one per distinct brick size.
 */
const OUTLINE_MAX = 0.016;
const OUTLINE_MIN = 0.0035;
const OUTLINE_RATIO = 0.085;

export function outlineWidth(minDimension: number): number {
  return Math.min(OUTLINE_MAX, Math.max(OUTLINE_MIN, minDimension * OUTLINE_RATIO));
}

const outlineMats = new Map<number, THREE.ShaderMaterial>();

export function outlineMaterial(width: number): THREE.ShaderMaterial {
  const key = Math.max(1, Math.round(width * 2000)); // 0.5 mm buckets
  let m = outlineMats.get(key);
  if (!m) {
    m = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { t: { value: key / 2000 } },
      vertexShader:
        "uniform float t; void main(){ vec3 p = position + normalize(normal) * t; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }",
      fragmentShader: "void main(){ gl_FragColor = vec4(0.09, 0.09, 0.12, 1.0); }",
    });
    outlineMats.set(key, m);
  }
  return m;
}

// ---- crayon grain (faint hand-drawn strokes, tinted by body colour) --------
let grainTex: THREE.Texture | null = null;

export function crayonGrain(): THREE.Texture | null {
  if (grainTex) return grainTex;
  if (typeof document === "undefined") return null;
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, S, S);
  ctx.lineWidth = 2;
  for (let i = 0; i < 55; i++) {
    ctx.strokeStyle = "rgba(0,0,0,0.045)";
    ctx.beginPath();
    const x = Math.random() * S, y = Math.random() * S;
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 40, y + (Math.random() - 0.5) * 40);
    ctx.stroke();
  }
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.035})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 1.5, 1.5);
  }
  grainTex = new THREE.CanvasTexture(c);
  grainTex.wrapS = grainTex.wrapT = THREE.RepeatWrapping;
  grainTex.colorSpace = THREE.SRGBColorSpace;
  return grainTex;
}

const matCache = new Map<number, THREE.MeshStandardMaterial>();

export function bodyMat(color: number): THREE.MeshStandardMaterial {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.02, map: crayonGrain() });
    matCache.set(color, m);
  }
  return m;
}

/**
 * Add an ink outline shell to a mesh (rides its transform).
 *
 * The shell goes on `HULL_LAYER` and nothing else, so the screen-space ink
 * pass can hide every one of them with a single camera-layer toggle. They stay
 * in the scene because they are the fallback: WebXR cannot render through the
 * render targets that pass needs.
 */
export function outline(mesh: THREE.Mesh, width = OUTLINE_MAX): THREE.Mesh {
  const shell = new THREE.Mesh(mesh.geometry, outlineMaterial(width));
  shell.layers.set(HULL_LAYER);
  mesh.add(shell);
  return mesh;
}

/** Tag a solid mesh so it appears in the ink pass's silhouette mask. */
function inkable(mesh: THREE.Mesh): THREE.Mesh {
  mesh.layers.enable(INK_LAYER);
  return mesh;
}

/** A soft rounded part (outlined in proportion to its size), parented to `p`. */
export function part(
  p: THREE.Object3D,
  color: number,
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  soft = 0.24,
): THREE.Mesh {
  const mesh = new THREE.Mesh(box(w, h, d, soft), bodyMat(color));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  p.add(mesh);
  outline(mesh, outlineWidth(Math.min(w, h, d)));
  return inkable(mesh);
}

/** Unit sphere, shared and scaled per use — see `blob`. Exported for code
 *  that merges parts itself (furniture) and must match the creatures' look. */
export const BLOB_GEO = new THREE.SphereGeometry(0.5, 20, 14);

/**
 * A smooth, un-outlined lump: a unit sphere scaled to w/h/d.
 *
 * Noses, pupils and highlights are the one place the brick language has to
 * give. A rounded box at this size still shows its corners and its ink border,
 * so a muzzle ends up wearing a small black crate; a sphere just reads as a
 * nose. They skip the outline for the same reason the pupil does — at 5 cm the
 * line is the shape.
 */
export function blob(
  p: THREE.Object3D,
  color: number,
  w: number, h: number, d: number,
  x: number, y: number, z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(BLOB_GEO, bodyMat(color));
  mesh.scale.set(w, h, d);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  p.add(mesh);
  return inkable(mesh);
}

export function stud(p: THREE.Object3D, color: number, x: number, y: number, z: number): void {
  const s = new THREE.Mesh(STUD_GEO, bodyMat(color));
  s.position.set(x, y, z);
  s.castShadow = true;
  p.add(s);
  outline(s, outlineWidth(0.08)); // the stud's height, its smallest dimension
  inkable(s);
}
