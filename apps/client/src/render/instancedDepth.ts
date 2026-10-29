import * as THREE from "three";

/**
 * The shadow-pass depth material for every InstancedMesh that casts shadows.
 *
 * three's shadow map draws every caster with ONE shared depth material. When
 * plain and instanced meshes are mixed — merged far chunks and instanced near
 * bricks, a robot and a row of instanced sofas — that material needs a
 * different shader for each kind, and three re-derives the program (its
 * parameters, its cache-key string) on every switch: every object, every
 * frame, a steady stream of CPU work and garbage that surfaces as GC hitches.
 * Giving instanced casters their own depth material (`customDepthMaterial`)
 * lets each material keep one program.
 *
 * Same packing as three's own default, so the shadow maps read back the same.
 */
let shared: THREE.MeshDepthMaterial | null = null;

export function instancedDepthMaterial(): THREE.MeshDepthMaterial {
  shared ??= new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  return shared;
}

let skinned: THREE.MeshDepthMaterial | null = null;

/**
 * The same split for SKINNED casters (the HOME/TT characters): a skinned mesh
 * drawn with the shared depth material flips it between the skinning and the
 * plain variant every frame, exactly like an instanced one.
 */
export function castsSkinnedShadow(mesh: THREE.SkinnedMesh): void {
  skinned ??= new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mesh.castShadow = true;
  mesh.customDepthMaterial = skinned;
}

/** Make an instanced mesh cast shadows without thrashing the shared depth material. */
export function castsInstancedShadow(mesh: THREE.InstancedMesh): void {
  mesh.castShadow = true;
  mesh.customDepthMaterial = instancedDepthMaterial();
}
