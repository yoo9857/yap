import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BLOB_GEO, box } from "../../player/blockParts.js";
import type { ColorRef, FurnitureDef } from "./types.js";

/**
 * Turn a catalog def into ONE vertex-coloured geometry for a given colour
 * variant. Parts use the creatures' own rounded box and sphere (`blockParts`),
 * so a sofa and the dog on it are visibly one toy set — same corner radius,
 * same crayon grain (the material adds it).
 *
 * Merging is the point: a piece drawn as a dozen brick meshes would cost a
 * draw call per brick per copy, twice over (the ink pass renders a mask too).
 */

const color = new THREE.Color();

/** Unit cylinders (height 1, the WIDER end 1 across), cached per taper. */
const cylCache = new Map<number, THREE.BufferGeometry>();
function unitCylinder(taper: number): THREE.BufferGeometry {
  const key = Math.round(Math.max(0, taper) * 100) / 100;
  let g = cylCache.get(key);
  if (!g) {
    // `taper` > 1 is a bowl: the TOP is the wide end, so it is the one at 0.5
    const top = key > 1 ? 0.5 : 0.5 * key;
    const bottom = key > 1 ? 0.5 / key : 0.5;
    g = new THREE.CylinderGeometry(top, bottom, 1, 24, 1);
    cylCache.set(key, g);
  }
  return g;
}

/** Unit dome: upper half-sphere spanning y −0.5…0.5, 1 across, with a closed
 *  base — open, a parasol seen from below would show its own inside missing. */
let domeGeo: THREE.BufferGeometry | null = null;
function unitDome(): THREE.BufferGeometry {
  if (domeGeo) return domeGeo;
  const cap = new THREE.SphereGeometry(0.5, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
  cap.scale(1, 2, 1).translate(0, -0.5, 0);
  const base = new THREE.CircleGeometry(0.5, 24).toNonIndexed();
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

export function buildFurnitureGeometry(def: FurnitureDef, variant: number, open = false): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const p of open && def.openParts ? def.openParts : def.parts) {
    const [w, h, d] = p.size;
    // A box is built at its real size (so its corner radius is right); every
    // other shape is a unit shape scaled to size.
    const source =
      p.shape === "box"
        ? box(w, h, d, p.soft ?? 0.24)
        : p.shape === "ball"
          ? BLOB_GEO
          : p.shape === "cyl"
            ? unitCylinder(p.taper ?? 1)
            : unitDome();
    // The sources are SHARED caches (the creatures draw with the box and the
    // ball too). `toNonIndexed()` hands back the original, not a copy, when it
    // is already non-indexed — so always end up with our own copy before the
    // transform below mutates it.
    const g = source.index ? source.toNonIndexed() : source.clone();
    euler.set(p.rot?.[0] ?? 0, p.rot?.[1] ?? 0, p.rot?.[2] ?? 0);
    scale.set(...(p.shape === "box" ? ([1, 1, 1] as const) : ([w, h, d] as const)));
    matrix.compose(pos.set(p.at[0], p.at[1], p.at[2]), quat.setFromEuler(euler), scale);
    for (const name of Object.keys(g.attributes)) {
      if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
    }
    g.applyMatrix4(matrix);
    const c = resolve(def, variant, p.color);
    const count = g.attributes.position!.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    parts.push(g);
  }
  const merged = mergeGeometries(parts) ?? new THREE.BufferGeometry();
  for (const g of parts) g.dispose();
  merged.computeBoundingSphere();
  return merged;
}
