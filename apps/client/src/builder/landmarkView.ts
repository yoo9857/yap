import * as THREE from "three";
import { loadTexture } from "../render/textures.js";
import type { BlueprintBlock, Landmark } from "./landmarks.js";

/** Semi-transparent overdraw is expensive, so the ghost samples the blueprint. */
// All current blueprints stay below 80k blocks. Showing every ghost voxel keeps
// the unbuilt landmark continuous instead of turning large silhouettes into dots.
const GHOST_CAP = 80_000;
type Surface = BlueprintBlock["surface"];


/**
 * Monument renderer. Blocks stay in bottom-up build order, but are batched by
 * architectural finish so stone, metal, glazing and practical lights respond
 * differently to the same scene lighting.
 */
export class LandmarkView {
  private readonly solids = new Map<Surface, THREE.InstancedMesh>();
  private readonly visible = new Map<Surface, number>();
  private ghost: THREE.InstancedMesh | null = null;
  private blockGeo: THREE.BoxGeometry | null = null;
  private ghostGeo: THREE.BoxGeometry | null = null;
  private landmarkId: string | null = null;
  private displayed = 0;
  private pourCarry = 0;
  private blockSurfaces: Surface[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  /** Has the pour animation caught up with the full blueprint? */
  isFullyPoured(landmark: Landmark): boolean {
    return this.landmarkId === landmark.id && this.displayed >= landmark.blocks.length;
  }

  /** World position of the Nth blueprint block (effects anchor). */
  blockPosition(landmark: Landmark, index: number): THREE.Vector3 {
    const u = landmark.voxelSizeM;
    const b = landmark.blocks[Math.max(0, Math.min(index, landmark.blocks.length - 1))]!;
    return new THREE.Vector3(b.x * u, b.y * u + u / 2, b.z * u);
  }

  /** Pour blocks CONTINUOUSLY: live growth runs at the crew's real voxel
   *  rate (steady construction, no bursts); a big catch-up (load / switch)
   *  recaps evenly bottom-up over ~8 s. */
  update(landmark: Landmark, placed: number, dt = 1, pourRatePerSec = 0): void {
    if (landmark.id !== this.landmarkId) {
      this.rebuild(landmark);
      this.displayed = 0;
    }
    if (this.solids.size === 0) return;

    const target = Math.min(placed, landmark.blocks.length);
    let next = target;
    if (this.displayed < target) {
      const gap = target - this.displayed;
      let rate: number;
      if (gap <= landmark.deliverySize * 3) {
        // live: match the economy's voxels/sec (slightly faster so the
        // display never falls behind), at least a visible trickle
        rate = Math.max(pourRatePerSec * 1.25, 12);
      } else {
        // recap: even bottom-up over ~8 s
        rate = landmark.blocks.length / 8;
      }
      this.pourCarry += rate * dt;
      const step = Math.floor(this.pourCarry);
      this.pourCarry -= step;
      next = Math.min(target, this.displayed + step);
    }

    if (next >= this.displayed) {
      for (let i = this.displayed; i < next; i++) {
        const surface = this.blockSurfaces[i]!;
        this.visible.set(surface, (this.visible.get(surface) ?? 0) + 1);
      }
    } else {
      this.visible.clear();
      for (let i = 0; i < next; i++) {
        const surface = this.blockSurfaces[i]!;
        this.visible.set(surface, (this.visible.get(surface) ?? 0) + 1);
      }
    }
    this.displayed = next;
    for (const [surface, mesh] of this.solids) mesh.count = this.visible.get(surface) ?? 0;
  }

  private rebuild(landmark: Landmark): void {
    this.dispose();
    this.landmarkId = landmark.id;
    const u = landmark.voxelSizeM;

    // Blocks almost touch: enough edge definition for lighting, without visible cracks.
    this.blockGeo = new THREE.BoxGeometry(u, u, u);
    // ghost voxels are slightly LARGER so their faces never share a plane
    // with solid ones — coplanar faces z-fight (visible shimmering)
    this.ghostGeo = new THREE.BoxGeometry(u * 1.03, u * 1.03, u * 1.03);
    const n = landmark.blocks.length;
    const materials = this.makeMaterials(u);

    const totals = new Map<Surface, number>();
    this.blockSurfaces = landmark.blocks.map((block) => {
      totals.set(block.surface, (totals.get(block.surface) ?? 0) + 1);
      return block.surface;
    });

    for (const [surface, count] of totals) {
      const mesh = new THREE.InstancedMesh(this.blockGeo, materials[surface], count);
      mesh.castShadow = surface !== "glass";
      mesh.receiveShadow = true;
      mesh.count = 0;
      if (surface === "glass") mesh.renderOrder = 2;
      this.solids.set(surface, mesh);
      this.scene.add(mesh);
    }
    for (const [surface, material] of Object.entries(materials)) {
      if (!totals.has(surface as Surface)) material.dispose();
    }

    // uniform hologram blue — stacked transparent voxels must read as an
    // UNBUILT blueprint, never as a nearly-finished monument
    const ghostMaterial = new THREE.MeshStandardMaterial({
      color: 0x7fd4ff,
      transparent: true,
      opacity: 0.05,
      depthWrite: false,
      roughness: 1,
    });
    const ghostStride = Math.max(1, Math.ceil(n / GHOST_CAP));
    const ghostCount = Math.ceil(n / ghostStride);
    this.ghost = new THREE.InstancedMesh(this.ghostGeo, ghostMaterial, ghostCount);

    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const localIndex = new Map<Surface, number>();
    let ghostIndex = 0;
    for (let i = 0; i < n; i++) {
      const block = landmark.blocks[i]!;
      matrix.makeTranslation(block.x * u, block.y * u + u / 2, block.z * u);
      color.set(block.color);

      const mesh = this.solids.get(block.surface)!;
      const slot = localIndex.get(block.surface) ?? 0;
      mesh.setMatrixAt(slot, matrix);
      mesh.setColorAt(slot, color);
      localIndex.set(block.surface, slot + 1);

      if (i % ghostStride === 0 && ghostIndex < ghostCount) {
        this.ghost.setMatrixAt(ghostIndex, matrix);
        // no per-instance color: the blueprint stays uniform hologram blue
        ghostIndex++;
      }
    }

    for (const mesh of this.solids.values()) {
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.ghost.count = ghostIndex;
    this.ghost.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.ghost.instanceMatrix.needsUpdate = true;
    if (this.ghost.instanceColor) this.ghost.instanceColor.needsUpdate = true;
    this.scene.add(this.ghost);

    this.displayed = 0;
    this.visible.clear();
  }

  /** Crayon-doodle grain per finish (lightened variants so the per-instance
   *  palette colors, which MULTIPLY the map, stay on tone). Attached async
   *  via the shared texture registry; the flat material stands in until the
   *  file arrives. */
  private attachSurfaceMap(material: THREE.MeshStandardMaterial, name: string): void {
    void loadTexture(`/textures/surface/${name}.png`).then((tex) => {
      if (!tex) return;
      material.map = tex;
      material.needsUpdate = true;
    });
  }

  private makeMaterials(u: number): Record<Surface, THREE.Material> {
    const masonry = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.02 });
    this.attachSurfaceMap(masonry, "masonry");
    const metal = new THREE.MeshStandardMaterial({ roughness: 0.31, metalness: 0.78 });
    this.attachSurfaceMap(metal, "metal");
    const glass = new THREE.MeshPhysicalMaterial({
      transparent: true,
      opacity: 0.72,
      transmission: 0.34,
      thickness: Math.max(0.12, u * 0.22),
      ior: 1.48,
      roughness: 0.08,
      metalness: 0.04,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      emissive: 0x071b2a,
      emissiveIntensity: 0.32,
    });
    this.attachSurfaceMap(glass, "glass");
    const emissive = new THREE.MeshStandardMaterial({
      roughness: 0.24,
      metalness: 0.42,
      emissive: 0x8a3b08,
      emissiveIntensity: 0.7,
    });
    this.attachSurfaceMap(emissive, "emissive");
    return { masonry, metal, glass, emissive };
  }

  dispose(): void {
    for (const mesh of [...this.solids.values(), this.ghost]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.blockGeo?.dispose();
    this.blockGeo = null;
    this.ghostGeo?.dispose();
    this.ghostGeo = null;
    this.solids.clear();
    this.ghost = null;
    this.landmarkId = null;
    this.blockSurfaces = [];
    this.visible.clear();
  }
}
