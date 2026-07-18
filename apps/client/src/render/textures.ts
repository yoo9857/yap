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
