import * as THREE from "three";

/**
 * Central texture registry — one shared, cached instance per URL, and a
 * completion barrier so boot can wait for everything before the first frame.
 *
 * Why this exists: scattered TextureLoader calls each created their own
 * texture that uploaded to the GPU (and generated mipmaps) the first time its
 * material entered the frustum — a mid-jump hitch per texture. The registry
 * lets warmup() push every pending upload into the loading screen instead.
 */

interface Entry {
  texture: THREE.Texture;
  promise: Promise<THREE.Texture | null>;
}

const cache = new Map<string, Entry>();

export interface TextureOpts {
  /** RepeatWrapping on both axes (tiles). */
  repeat?: boolean;
  srgb?: boolean;
}

/**
 * Load (or reuse) a texture. Resolves with the texture once its image data is
 * ready, or null if the fetch failed — callers attach maps in the resolution
 * so a missing file degrades to flat color, never a black mesh.
 */
export function loadTexture(url: string, opts: TextureOpts = {}): Promise<THREE.Texture | null> {
  let entry = cache.get(url);
  if (!entry) {
    let resolve!: (t: THREE.Texture | null) => void;
    const promise = new Promise<THREE.Texture | null>((r) => (resolve = r));
    const texture = new THREE.TextureLoader().load(
      url,
      (tex) => resolve(tex),
      undefined,
      () => resolve(null),
    );
    if (opts.repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    if (opts.srgb !== false) texture.colorSpace = THREE.SRGBColorSpace;
    entry = { texture, promise };
    cache.set(url, entry);
  }
  return entry.promise;
}

/** Resolves when every texture requested SO FAR has finished (or failed). */
export function texturesReady(): Promise<void> {
  return Promise.all([...cache.values()].map((e) => e.promise)).then(() => undefined);
}

/**
 * Push every loaded texture to the GPU now (upload + mipmaps) so the first
 * frame that shows it doesn't pay the cost mid-gameplay.
 */
export function uploadAllTextures(renderer: THREE.WebGLRenderer): void {
  for (const { texture } of cache.values()) {
    if (texture.image) renderer.initTexture(texture);
  }
}

/**
 * Full GPU warmup: upload textures, then synchronously compile every shader
 * program the scene can ever need (including currently-invisible objects).
 */
export function warmupGpu(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): void {
  uploadAllTextures(renderer);
  renderer.compile(scene, camera);
}

/**
 * Warm-up to run BEHIND a loading screen, before the game loop starts.
 *
 * `warmupGpu` compiles synchronously — on Windows each program is translated
 * to D3D by the driver, tens to hundreds of milliseconds apiece — and it only
 * knows the materials the camera can see: the shadow pass's depth programs,
 * the ink mask's override programs and its composite are compiled on first
 * use instead. Run once play had started, that was the "very slow at first,
 * then smooth" opening: one long freeze and a string of hitches.
 *
 * So: upload textures; compile and await the GL completion flag (the browser
 * compiles in parallel where KHR_parallel_shader_compile exists); then draw
 * `frames` complete frames through the mode's own render path, which compiles
 * and uploads whatever is left — shadow, mask, composite, render targets.
 */
export async function warmupGpuAsync(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  renderFrame: () => void,
  frames = 2,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  uploadAllTextures(renderer);
  // Three's compileAsync keeps an uncancellable polling timer over material
  // properties. A mode disposing those materials mid-compile can leave that
  // poll reading a deleted program. Poll the public GL completion flag here
  // and cancel waits before disposing the renderer instead.
  renderer.compile(scene, camera);
  const gl = renderer.getContext(), parallel = gl.getExtension("KHR_parallel_shader_compile");
  if (parallel) while (!signal?.aborted && !gl.isContextLost()) {
    const ready = (renderer.info.programs ?? []).every((p) => {
      const program = p.program as WebGLProgram | undefined;
      return !program || gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR) === true;
    });
    if (ready) break;
    await warmupYield(false, signal);
  }
  for (let i = 0; i < frames; i++) {
    if (signal?.aborted || gl.isContextLost()) return;
    renderFrame();
    // let the browser present, so GPU-side work lands now, not in play
    await warmupYield(true, signal);
  }
}

function warmupYield(frame: boolean, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    let cancel = () => {};
    const done = () => { cancel(); signal?.removeEventListener("abort", done); resolve(); };
    if (frame) { const id = requestAnimationFrame(done); cancel = () => cancelAnimationFrame(id); }
    else { const id = setTimeout(done, 10); cancel = () => clearTimeout(id); }
    signal?.addEventListener("abort", done, { once: true });
  });
}
