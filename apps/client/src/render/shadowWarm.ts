import * as THREE from "three";

/**
 * Start the compile of the SHADOW pass's programs, so the boot's parallel compile has them.
 *
 * `renderer.compile(scene)` knows each object's own material. The shadow pass draws every caster
 * with a depth material three picks itself (plain / instanced / skinned, single or double sided,
 * with the caster's map; a distance material for point lights), so those programs were made at the
 * first frame's first use, one after another with the loading screen standing still (seven of
 * them, ~190 ms: tools/profile-fire-boot.mjs, 2026-11-14).
 *
 * Nothing here guesses what three will pick: the shadow pass itself is run once with the draw call
 * replaced by a note of what it was about to draw. Each distinct (depth material state, kind of
 * object) is then compiled on a stand-in, under what the shadow pass has when it asks for its
 * program: a render target bound (not the canvas), no fog (it draws with an empty scene), the
 * scene's own lights. A program is shared by its parameters, so the real pass finds these.
 *
 * Returns what to call once the first frames are drawn (the stand-ins' materials hold the
 * programs until the real ones do). Nothing waits here: the warm-up polls for completion.
 */
export function compileShadowPrograms(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): () => void {
  const lights: THREE.Light[] = [];
  scene.traverseVisible((o) => { if ((o as THREE.Light).isLight && o.castShadow) lights.push(o as THREE.Light); });
  const shadowMap = renderer.shadowMap;
  if (!shadowMap.enabled || lights.length === 0 || renderer.xr?.isPresenting) return () => {};

  const standIns = new THREE.Scene(), made: THREE.Material[] = [], seen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- a closure the renderer sets on itself, not a prototype method
  const draw = renderer.renderBufferDirect;
  const prevTarget = renderer.getRenderTarget(), prevFog = scene.fog;
  try {
    renderer.renderBufferDirect = (_camera, _scene, geometry, material, object) => {
      const m = material as THREE.MeshDepthMaterial, o = object as THREE.InstancedMesh & { isSkinnedMesh?: boolean };
      const a = geometry.attributes;
      const key = [m.type, m.side, m.map ? 1 : 0, m.alphaMap ? 1 : 0, m.alphaTest > 0 ? 1 : 0, m.displacementMap ? 1 : 0, m.wireframe ? 1 : 0,
        m.clippingPlanes?.length ?? 0, o.isInstancedMesh ? (o.instanceColor ? 2 : 1) : 0, o.isSkinnedMesh ? 1 : 0, o.morphTexture ? 1 : 0,
        Object.keys(geometry.morphAttributes).join("+"), a.uv ? 1 : 0, a.uv1 ? 1 : 0, a.color ? 1 : 0].join("|");
      if (seen.has(key)) return;
      seen.add(key);
      // three changes its shared depth material from one caster to the next: a copy as it is NOW
      const copy = m.clone();
      made.push(copy);
      const standIn = new THREE.Mesh(geometry, copy) as unknown as THREE.Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean; instanceColor?: unknown; morphTexture?: unknown };
      // the program depends on these flags of the object, not on its class
      if (o.isInstancedMesh) { standIn.isInstancedMesh = true; standIn.instanceColor = o.instanceColor; standIn.morphTexture = o.morphTexture; }
      if (o.isSkinnedMesh) standIn.isSkinnedMesh = true;
      standIn.frustumCulled = false;
      standIns.add(standIn);
    };
    shadowMap.needsUpdate = true;
    shadowMap.render(lights, scene, camera); // sets up every light's shadow map; draws nothing
    const target = lights.map((l) => l.shadow?.map).find((map) => !!map);
    if (target && standIns.children.length > 0) {
      scene.fog = null;
      renderer.setRenderTarget(target);
      renderer.compile(standIns, camera, scene);
    }
  } catch {
    // a three.js that does this differently: the programs are made at first use, as before
  } finally {
    renderer.renderBufferDirect = draw;
    scene.fog = prevFog;
    renderer.setRenderTarget(prevTarget);
    shadowMap.needsUpdate = true; // the maps were cleared and not drawn: the next frame draws them
  }
  return () => { for (const m of made) m.dispose(); };
}
