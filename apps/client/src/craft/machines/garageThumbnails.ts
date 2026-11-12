import * as THREE from "three";
import { usesSkylarkModel, type Blueprint } from "./blueprint.js";
import { MachineAssets, MachineVisual } from "./machineVisual.js";

const WIDTH = 192;
const HEIGHT = 144;
const MAX_PENDING = 12;
const TO_SRGB = Uint8Array.from({ length: 256 }, (_, byte) => {
  const linear = byte / 255;
  return Math.round(255 * (linear <= .0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - .055));
});

interface ThumbnailJob {
  key: string;
  blueprint: Blueprint;
  index?: number;
  result: Promise<string | null>;
  resolve: (image: string | null) => void;
}

/** Generate cached stills on the game renderer, one asynchronous readback at a time. */
export class GarageThumbnails {
  private visual: MachineVisual | null = null;
  private target: THREE.WebGLRenderTarget | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 1000);
  private readonly cache = new Map<string, string>();
  private readonly queue: ThumbnailJob[] = [];
  private current: ThumbnailJob | null = null;
  private frame = 0;
  private disposed = false;

  constructor(private readonly assets: MachineAssets, private readonly renderer: THREE.WebGLRenderer) {
    this.scene.add(new THREE.HemisphereLight(0xfffaf0, 0x60748e, 1.1));
    const key = new THREE.DirectionalLight(0xfff3df, 1.5);
    key.position.set(-3, 7, 5);
    const rim = new THREE.DirectionalLight(0xb3dbff, .8);
    rim.position.set(5, 3, -4);
    this.scene.add(key, rim);
  }

  render(blueprint: Blueprint, index?: number): Promise<string | null> {
    if (index === undefined && usesSkylarkModel(blueprint)) return Promise.resolve("/ui/machines/skylark.webp");
    if (!this.assets.loaded || this.disposed || !blueprint.parts.length) return Promise.resolve(null);
    const key = JSON.stringify([blueprint.parts, index]);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const existing = this.current?.key === key ? this.current : this.queue.find(job => job.key === key);
    if (existing) return existing.result;
    if (this.queue.length >= MAX_PENDING) this.queue.shift()!.resolve(null);
    let resolve!: ThumbnailJob["resolve"];
    const result = new Promise<string | null>(done => { resolve = done; });
    this.queue.push({ key, blueprint, index, result, resolve });
    this.schedule();
    return result;
  }

  private schedule(): void {
    if (this.frame || this.current || !this.queue.length || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const job = this.current = this.queue.shift()!;
      void this.capture(job).catch(() => null).then(image => {
        if (image && !this.disposed) {
          this.cache.set(job.key, image);
          if (this.cache.size > 48) this.cache.delete(this.cache.keys().next().value!);
        }
        this.current = null;
        job.resolve(this.disposed ? null : image);
        this.schedule();
      });
    });
  }

  private async capture({ blueprint, index }: ThumbnailJob): Promise<string | null> {
    if (!this.visual) {
      this.visual = new MachineVisual(this.assets);
      this.scene.add(this.visual.root);
    }
    const visual = this.visual;
    visual.rebuild(blueprint, index);
    const bounds = new THREE.Box3();
    for (const mesh of visual.meshes) {
      mesh.computeBoundingBox();
      if (mesh.boundingBox) bounds.union(mesh.boundingBox);
    }
    if (bounds.isEmpty()) return null;
    this.fit(bounds);
    const target = this.target ??= new THREE.WebGLRenderTarget(WIDTH, HEIGHT);
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousColor = renderer.getClearColor(new THREE.Color());
    const previousAlpha = renderer.getClearAlpha();
    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0, 0);
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousColor, previousAlpha);
    }
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    const readback = await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT, pixels);
    if (this.disposed || this.target !== target || !readback) return null;
    return this.encode(pixels);
  }

  private fit(bounds: THREE.Box3): void {
    const centre = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const direction = new THREE.Vector3(3, 2.2, 4).normalize();
    const right = new THREE.Vector3(direction.z, 0, -direction.x).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    const corner = new THREE.Vector3();
    let radius = .1;
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z]) {
          corner.set(x, y, z).sub(centre);
          radius = Math.max(radius, Math.abs(corner.dot(up)), Math.abs(corner.dot(right)) * HEIGHT / WIDTH);
        }
    radius *= 1.12;
    this.camera.left = -radius * WIDTH / HEIGHT;
    this.camera.right = -this.camera.left;
    this.camera.top = radius;
    this.camera.bottom = -radius;
    this.camera.position.copy(centre).addScaledVector(direction, Math.max(5, size.length() * 2));
    this.camera.lookAt(centre);
    this.camera.updateProjectionMatrix();
  }

  private encode(pixels: Uint8Array): string | null {
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.width = WIDTH;
      this.canvas.height = HEIGHT;
    }
    const context = this.canvas.getContext("2d");
    if (!context) return null;
    const image = context.createImageData(WIDTH, HEIGHT);
    const stride = WIDTH * 4;
    for (let row = 0; row < HEIGHT; row++) {
      const source = (HEIGHT - 1 - row) * stride;
      image.data.set(pixels.subarray(source, source + stride), row * stride);
    }
    // The offscreen target contains linear, premultiplied colour. Canvas expects sRGB and straight alpha.
    for (let i = 0; i < image.data.length; i += 4) {
      const alpha = image.data[i + 3]!;
      if (!alpha) continue;
      for (let channel = 0; channel < 3; channel++) {
        const byte = Math.min(255, Math.round(image.data[i + channel]! * 255 / alpha));
        image.data[i + channel] = TO_SRGB[byte]!;
      }
    }
    context.putImageData(image, 0, 0);
    return this.canvas.toDataURL("image/webp", .88);
  }

  /** Keep only encoded thumbnails between workshop visits. */
  release(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const job of this.queue.splice(0)) job.resolve(null);
    this.visual?.dispose();
    this.visual?.root.removeFromParent();
    this.visual = null;
    this.target?.dispose();
    this.target = null;
    this.canvas = null;
  }

  dispose(): void {
    this.disposed = true;
    this.release();
    this.cache.clear();
    this.scene.clear();
  }
}
