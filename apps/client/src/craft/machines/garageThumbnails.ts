import * as THREE from "three";
import type { Blueprint } from "./blueprint.js";
import { MachineAssets, MachineVisual } from "./machineVisual.js";

/** Small, cached stills of the same geometry and customization as the live machine. */
export class GarageThumbnails {
  private renderer: THREE.WebGLRenderer | null = null;
  private visual: MachineVisual | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 1000);
  private readonly cache = new Map<string, string>();
  private unavailable = false;

  constructor(private readonly assets: MachineAssets) {
    this.scene.add(new THREE.HemisphereLight(0xfffaf0, 0x60748e, 2.7));
    const key = new THREE.DirectionalLight(0xfff3df, 3.2);
    key.position.set(-3, 7, 5);
    const rim = new THREE.DirectionalLight(0xb3dbff, 2);
    rim.position.set(5, 3, -4);
    this.scene.add(key, rim);
  }

  render(blueprint: Blueprint, index?: number): string | null {
    if (!this.assets.loaded || this.unavailable || !blueprint.parts.length) return null;
    const key = JSON.stringify([blueprint.parts, index]);
    const cached = this.cache.get(key);
    if (cached) return cached;
    try {
      if (!this.renderer) {
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(192, 144);
        this.renderer.setClearColor(0, 0);
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.2;
        this.visual = new MachineVisual(this.assets);
        this.scene.add(this.visual.root);
      }
      const visual = this.visual!;
      visual.rebuild(blueprint);
      const bounds = new THREE.Box3(), matrix = new THREE.Matrix4(), colour = new THREE.Color();
      visual.root.updateMatrixWorld(true);
      for (const mesh of visual.meshes) {
        // Keep the whole blueprint's wheel mounts while isolating the chosen part.
        if (index !== undefined) {
          const slot = (mesh.userData.partIndices as number[]).indexOf(index);
          mesh.visible = slot >= 0;
          if (slot < 0) continue;
          mesh.getMatrixAt(slot, matrix);
          mesh.getColorAt(slot, colour);
          mesh.setMatrixAt(0, matrix);
          mesh.setColorAt(0, colour);
          mesh.count = 1;
          mesh.instanceMatrix.needsUpdate = true;
          mesh.instanceColor!.needsUpdate = true;
        }
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        if (mesh.boundingBox) bounds.union(mesh.boundingBox);
      }
      if (bounds.isEmpty()) return null;
      const centre = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
      const direction = new THREE.Vector3(3, 2.2, 4).normalize();
      const right = new THREE.Vector3(direction.z, 0, -direction.x).normalize();
      const up = new THREE.Vector3().crossVectors(direction, right);
      const corner = new THREE.Vector3();
      let radius = .1;
      for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
          for (const z of [bounds.min.z, bounds.max.z]) {
            corner.set(x, y, z).sub(centre);
            radius = Math.max(radius, Math.abs(corner.dot(up)), Math.abs(corner.dot(right)) * 3 / 4);
          }
      radius *= 1.12;
      this.camera.left = -radius * 4 / 3;
      this.camera.right = radius * 4 / 3;
      this.camera.top = radius;
      this.camera.bottom = -radius;
      this.camera.position.copy(centre).addScaledVector(direction, Math.max(5, size.length() * 2));
      this.camera.lookAt(centre);
      this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);
      const image = this.renderer.domElement.toDataURL("image/webp", .88);
      this.cache.set(key, image);
      if (this.cache.size > 48) this.cache.delete(this.cache.keys().next().value!);
      return image;
    } catch {
      // Existing static art remains usable if an extra graphics context is unavailable.
      this.unavailable = true;
      this.release();
      return null;
    }
  }

  private release(): void {
    this.visual?.dispose();
    this.visual?.root.removeFromParent();
    this.visual = null;
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
  }

  dispose(): void {
    this.release();
    this.cache.clear();
    this.scene.clear();
    this.unavailable = true;
  }
}
