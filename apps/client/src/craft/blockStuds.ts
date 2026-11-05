import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { kitConnectorGeometry } from "./kitShell.js";

/**
 * The studs on brick tops come from Blender: `assets/blocks/studs` (source BlockStuds.blend, lifted
 * from the approved soft block form), exported once as block-studs.glb, which the native client
 * reads too. Two meshes, each a whole 1 m top (2×2 studs), origin at the top face's centre:
 * - `Stud_HQ`, the original (568 triangles), drawn within STUD_HQ_DISTANCE of the focus;
 * - `Stud_LOD1`, the same silhouette without its sub-centimetre bevel rings at 8 segments
 *   (152 triangles), out to the stud range.
 * Until it arrives (or if it cannot), both are `kitConnectorGeometry()`: the code twin of
 * Stud_HQ, so the shape never changes, only the far cost.
 */
export const BLOCK_STUDS_URL = "/models/blocks/block-studs.glb?v=1";
/** assets/blocks/studs/runtime/manifest.json `lodDistance`. */
export const STUD_HQ_DISTANCE = 12;

export interface BlockStudGeometries {
  hq: THREE.BufferGeometry;
  lod: THREE.BufferGeometry;
  /** False when these are the code fallback. */
  fromBlender: boolean;
}

/** Block materials read a colour attribute (vertexColors): studs are plain white under the brick's tint. */
function prepare(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geometry.getAttribute("color")) {
    const count = geometry.getAttribute("position").count;
    geometry.setAttribute("color", new THREE.BufferAttribute(new Uint8Array(count * 3).fill(255), 3, true));
  }
  geometry.computeBoundingSphere();
  return geometry;
}

export function fallbackStuds(): BlockStudGeometries {
  return { hq: prepare(kitConnectorGeometry()), lod: prepare(kitConnectorGeometry()), fromBlender: false };
}

/** The two meshes out of a parsed GLB; null when either is missing. */
export function studsFromGltf(scene: THREE.Object3D): BlockStudGeometries | null {
  const pick = (name: string): THREE.BufferGeometry | null => {
    const node = scene.getObjectByName(name);
    return node instanceof THREE.Mesh ? prepare((node.geometry as THREE.BufferGeometry).clone()) : null;
  };
  const hq = pick("Stud_HQ"), lod = pick("Stud_LOD1");
  if (!hq || !lod) {
    hq?.dispose();
    lod?.dispose();
    return null;
  }
  return { hq, lod, fromBlender: true };
}

let pending: Promise<BlockStudGeometries> | null = null;

/** The Blender studs, loaded once per page (every view copies the geometries it keeps). */
export function loadBlockStuds(): Promise<BlockStudGeometries> {
  pending ??= new GLTFLoader()
    .loadAsync(BLOCK_STUDS_URL)
    .then((gltf) => {
      const studs = studsFromGltf(gltf.scene);
      if (!studs) throw new Error("block-studs.glb has no Stud_HQ / Stud_LOD1");
      return studs;
    })
    .catch((err: unknown) => {
      console.warn("block studs: using the code twin", err);
      return fallbackStuds();
    });
  return pending;
}
