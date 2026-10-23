import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ColorRef, FurnitureDef } from "./types.js";

/**
 * Turn a catalog def into ONE vertex-coloured geometry for a given colour
 * variant. Merging is the point: a piece drawn as a dozen brick meshes would
 * cost a draw call per brick per copy, twice over (the ink pass renders a mask
 * too).
 *
 * The parts are built here at FURNITURE detail, not the creatures' (whose
 * `blockParts.box` uses 4 corner segments for a body seen close up), and the
 * merge keeps them INDEXED. Both matter, measured: un-indexed 4-segment boxes
 * came to ~2 900 vertices per brick — a bookshelf of books was ~175 000, a
 * curtain ~50 000 — drawn three times a frame (scene, ink mask, shadow) for
 * every copy, and the first sight of each new look built megabytes on the main
 * thread: the frame drops people saw when placing and looking at curtains.
 * At this detail a typical piece is a few thousand vertices; the outline and
 * the crayon grain carry the look, not the corner tessellation.
 */

const color = new THREE.Color();

/** Corner segments: one for small parts (knobs, books, legs), two otherwise. */
const segmentsFor = (smallest: number): number => (smallest < 0.12 ? 1 : 2);

const boxCache = new Map<string, THREE.BufferGeometry>();
function roundedBox(w: number, h: number, d: number, soft: number): THREE.BufferGeometry {
  const key = `${w.toFixed(3)},${h.toFixed(3)},${d.toFixed(3)},${soft}`;
  let g = boxCache.get(key);
  if (!g) {
    const smallest = Math.min(w, h, d);
    g = new RoundedBoxGeometry(w, h, d, segmentsFor(smallest), smallest * soft);
    // RoundedBoxGeometry un-indexes itself in its constructor (above one
    // segment), repeating every shared vertex per triangle; weld them back,
    // once per size, so the merged furniture stays indexed and small.
    if (!g.index) g = mergeVertices(g);
    boxCache.set(key, g);
  }
  return g;
}

/** Unit sphere for balls (eyes, leaves, bulbs, cushions' puff). */
const BALL = new THREE.SphereGeometry(0.5, 14, 10);

/** Unit cylinders (height 1, the WIDER end 1 across), cached per taper. */
const cylCache = new Map<number, THREE.BufferGeometry>();
function unitCylinder(taper: number): THREE.BufferGeometry {
  const key = Math.round(Math.max(0, taper) * 100) / 100;
  let g = cylCache.get(key);
  if (!g) {
    // `taper` > 1 is a bowl: the TOP is the wide end, so it is the one at 0.5
    const top = key > 1 ? 0.5 : 0.5 * key;
    const bottom = key > 1 ? 0.5 / key : 0.5;
    g = new THREE.CylinderGeometry(top, bottom, 1, 16, 1);
    cylCache.set(key, g);
  }
  return g;
}

/** Unit dome: upper half-sphere spanning y −0.5…0.5, 1 across, with a closed
 *  base — open, a parasol seen from below would show its own inside missing. */
let domeGeo: THREE.BufferGeometry | null = null;
function unitDome(): THREE.BufferGeometry {
  if (domeGeo) return domeGeo;
  const cap = new THREE.SphereGeometry(0.5, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 2, 1).translate(0, -0.5, 0);
  const base = new THREE.CircleGeometry(0.5, 16);
  base.rotateX(Math.PI / 2).translate(0, -0.5, 0); // faces down
  domeGeo = mergeGeometries([cap, base]) ?? cap;
  return domeGeo;
}

const matrix = new THREE.Matrix4();
const euler = new THREE.Euler();
const quat = new THREE.Quaternion();
const pos = new THREE.Vector3();
const scale = new THREE.Vector3();

/** Resolve a part's colour (literal, or a slot in the variant's palette) to
 *  LINEAR rgb — what a vertex colour attribute must hold. `Color.setHex`
 *  converts from sRGB under three's colour management. */
function resolve(def: FurnitureDef, variant: number, ref: ColorRef): THREE.Color {
  if (typeof ref === "number") return color.setHex(ref);
  const palette = def.palettes?.[variant] ?? def.palettes?.[0];
  const hex = palette?.colors[ref];
  // The catalog test guarantees every slot resolves; magenta makes a slip
  // impossible to miss in a screenshot rather than silently black.
  return color.setHex(hex ?? 0xff00ff);
}

/** A piece's SHAPE (one per kind and open/closed): every part merged, no colour. */
export interface FurnitureShape {
  geometry: THREE.BufferGeometry;
  /** Vertices per part, in parts order — what `paintFurniture` colours by. */
  partVertices: number[];
}

export function buildFurnitureShape(def: FurnitureDef, open = false): FurnitureShape {
  const parts: THREE.BufferGeometry[] = [];
  const partVertices: number[] = [];
  for (const p of open && def.openParts ? def.openParts : def.parts) {
    const [w, h, d] = p.size;
    // A box is built at its real size (so its corner radius is right); every
    // other shape is a unit shape scaled to size.
    const source =
      p.shape === "box"
        ? roundedBox(w, h, d, p.soft ?? 0.24)
        : p.shape === "ball"
          ? BALL
          : p.shape === "cyl"
            ? unitCylinder(p.taper ?? 1)
            : unitDome();
    // The sources are shared caches: always transform our own copy. Every
    // source is indexed, so the merged result is indexed too.
    const g = source.clone();
    euler.set(p.rot?.[0] ?? 0, p.rot?.[1] ?? 0, p.rot?.[2] ?? 0);
    scale.set(...(p.shape === "box" ? ([1, 1, 1] as const) : ([w, h, d] as const)));
    matrix.compose(pos.set(p.at[0], p.at[1], p.at[2]), quat.setFromEuler(euler), scale);
    for (const name of Object.keys(g.attributes)) {
      if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
    }
    g.applyMatrix4(matrix);
    partVertices.push(g.attributes.position!.count);
    parts.push(g);
  }
  const geometry = mergeGeometries(parts) ?? new THREE.BufferGeometry();
  for (const g of parts) g.dispose();
  geometry.computeBoundingSphere();
  return { geometry, partVertices };
}

/**
 * One colour variant of a shape. The new geometry SHARES the shape's index,
 * position, normal and uv attributes — only the colour attribute is its own —
 * so a second colour of a sofa costs one small buffer, not a second sofa
 * (three uploads a shared attribute to the GPU once).
 *
 * Because the buffers are shared, never `dispose()` one look on its own: that
 * frees the shared buffers under its siblings. FurnitureView only disposes
 * them all together.
 */
export function paintFurniture(def: FurnitureDef, variant: number, open: boolean, shape: FurnitureShape): THREE.BufferGeometry {
  const base = shape.geometry;
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(base.index);
  for (const name of ["position", "normal", "uv"] as const) {
    const attribute = base.getAttribute(name);
    if (attribute) geometry.setAttribute(name, attribute);
  }
  const partList = open && def.openParts ? def.openParts : def.parts;
  const colors = new Float32Array(base.attributes.position!.count * 3);
  let at = 0;
  shape.partVertices.forEach((count, i) => {
    const c = resolve(def, variant, partList[i]!.color);
    for (let k = 0; k < count; k++, at++) {
      colors[at * 3] = c.r;
      colors[at * 3 + 1] = c.g;
      colors[at * 3 + 2] = c.b;
    }
  });
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.boundingSphere = base.boundingSphere?.clone() ?? null;
  return geometry;
}
