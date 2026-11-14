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
  targets: readonly (THREE.WebGLRenderTarget | null)[] = [null],
): void {
  uploadAllTextures(renderer);
  compileFor(renderer, scene, camera, targets);
}

/** `renderer.compile` once per target the game draws into (see `GameRenderer.compileTargets`). */
export function compileFor(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  targets: readonly (THREE.WebGLRenderTarget | null)[],
): void {
  if (targets.length === 1 && targets[0] === null && renderer.getRenderTarget?.() == null) {
    renderer.compile(scene, camera); // the canvas only, already bound
    return;
  }
  const prev = renderer.getRenderTarget();
  try {
    for (const target of targets) {
      renderer.setRenderTarget(target);
      renderer.compile(scene, camera);
    }
  } finally {
    renderer.setRenderTarget(prev);
  }
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
  targets: readonly (THREE.WebGLRenderTarget | null)[] = [null],
): Promise<void> {
  if (signal?.aborted) return;
  // Textures a few at a time, the browser allowed to draw in between: all of them in one go held
  // the loading screen for 0.4 s (texSubImage2D, tools/profile-fire-boot.mjs 2026-11-14).
  let uploaded = performance.now();
  for (const { texture } of [...cache.values()]) {
    if (signal?.aborted) return;
    if (texture.image) renderer.initTexture(texture);
    if (performance.now() - uploaded > 8) { await warmupYield(true, signal); uploaded = performance.now(); }
  }
  // Three's compileAsync keeps an uncancellable polling timer over material
  // properties. A mode disposing those materials mid-compile can leave that
  // poll reading a deleted program. Poll the public GL completion flag here
  // and cancel waits before disposing the renderer instead.
  compileFor(renderer, scene, camera, targets);
  const gl = renderer.getContext(), parallel = gl.getExtension("KHR_parallel_shader_compile");
  if (parallel) while (!signal?.aborted && !gl.isContextLost()) {
    const ready = (renderer.info.programs ?? []).every((p) => {
      const program = p.program as WebGLProgram | undefined;
      return !program || gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR) === true;
    });
    if (ready) break;
    await warmupYield(false, signal);
  }
  // A program's first use reads every uniform and attribute it has back from the driver: hundreds
  // of small synchronous calls, ~20 ms a program. Left to the first frame below, sixty programs
  // did that in ONE frame and the loading screen stood still for over a second
  // (tools/profile-fire-boot.mjs, 2026-11-13). Asked for here, a few at a time with the browser
  // allowed to draw in between, it is the same work without the freeze.
  let slice = performance.now();
  for (const p of renderer.info?.programs ?? []) {
    if (signal?.aborted || gl.isContextLost()) return;
    const program = p as unknown as { program?: WebGLProgram; getUniforms?(): unknown; getAttributes?(): unknown };
    if (!program.program) continue; // destroyed meanwhile
    program.getUniforms?.();
    program.getAttributes?.();
    if (performance.now() - slice > 10) { await warmupYield(true, signal); slice = performance.now(); }
  }
  for (let i = 0; i < frames; i++) {
    if (signal?.aborted || gl.isContextLost()) return;
    renderFrame();
    // let the browser present, so GPU-side work lands now, not in play
    await warmupYield(true, signal);
  }
}

/** Give the browser a turn behind the loading screen: until its next frame, or 10 ms. */
export function warmupYield(frame: boolean, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    let cancel = () => {};
    const done = () => { cancel(); signal?.removeEventListener("abort", done); resolve(); };
    if (frame) { const id = requestAnimationFrame(done); cancel = () => cancelAnimationFrame(id); }
    else { const id = setTimeout(done, 10); cancel = () => clearTimeout(id); }
    signal?.addEventListener("abort", done, { once: true });
  });
}
