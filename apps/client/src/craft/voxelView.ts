import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { BLOCKS, blockById, textureUrl, type BlockDef } from "./blocks.js";
import { loadTexture } from "../render/textures.js";
import { WORLD_X, WORLD_Y, WORLD_Z, type VoxelWorld } from "./voxelWorld.js";

/**
 * Renders the island as one InstancedMesh per block kind, EXPOSED cells only
 * (interior voxels never reach the GPU). A full rebuild scans the 64k grid in
 * well under a millisecond, so any edit just marks the view dirty.
 *
 * Identity: LEGO/Roblox toy-brick look — softly ROUNDED cubes plus a single
 * stud on every top-exposed brick, tinted per block. Crayon-doodle textures
 * on rounded studded bricks = CraftYap, not raw Minecraft.
 */
export class VoxelView {
  // slightly oversized so neighbours overlap and the rounded edges don't leave
  // grooves between bricks — only exposed corners keep the soft LEGO bevel
  private readonly geometry = new RoundedBoxGeometry(1.1, 1.1, 1.1, 1, 0.07);
  private readonly studGeometry: THREE.CylinderGeometry;
  private readonly studMeshes = new Map<number, THREE.InstancedMesh>();
  private readonly meshes = new Map<number, THREE.InstancedMesh>();
  private readonly materials = new Map<number, THREE.Material>();
  private readonly highlight: THREE.LineSegments;
  private dirty = true;

  constructor(private readonly scene: THREE.Scene) {
    for (const def of BLOCKS) this.materials.set(def.id, this.makeMaterial(def));
    // a centered stud that carries the SAME crayon texture as its brick, so it
    // reads as moulded from the block rather than a flat cap floating on top.
    // Top cap UV samples the tile too (openEnded:false), sides wrap it.
    this.studGeometry = new THREE.CylinderGeometry(0.18, 0.2, 0.14, 10);
    this.studGeometry.translate(0, 0.05, 0); // base overlaps the brick top a hair
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
    this.highlight = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x1f1f1f, linewidth: 2 }),
    );
    this.highlight.visible = false;
    scene.add(this.highlight);
  }

  private makeMaterial(def: BlockDef): THREE.Material {
    const material = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      transparent: def.key === "glass" || def.key === "oak-leaves",
      opacity: def.key === "glass" ? 0.75 : 1,
    });
    if (def.emissive) {
      material.emissive = new THREE.Color(0xffdf8a);
      material.emissiveIntensity = 0.55;
    }
    void loadTexture(textureUrl(def)).then((tex) => {
      if (!tex) return;
      material.map = tex;
      if (def.emissive) material.emissiveMap = tex;
      material.needsUpdate = true;
    });
    return material;
  }

  markDirty(): void {
    this.dirty = true;
  }

  setHighlight(voxel: [number, number, number] | null): void {
    if (!voxel) {
      this.highlight.visible = false;
      return;
    }
    this.highlight.visible = true;
    this.highlight.position.set(voxel[0] + 0.5, voxel[1] + 0.5, voxel[2] + 0.5);
  }

  /** Rebuild instance lists if an edit happened since the last frame. */
  update(world: VoxelWorld): void {
    if (!this.dirty) return;
    this.dirty = false;

    const positions = new Map<number, number[]>();
    const studPositions = new Map<number, number[]>(); // per block id: top-exposed
    for (let y = 0; y < WORLD_Y; y++) {
      for (let z = 0; z < WORLD_Z; z++) {
        for (let x = 0; x < WORLD_X; x++) {
          const id = world.get(x, y, z);
          if (id === 0 || !world.isExposed(x, y, z)) continue;
          let list = positions.get(id);
          if (!list) positions.set(id, (list = []));
          list.push(x, y, z);
          const def = blockById(id);
          if (def && !def.noStud && !world.isSolid(x, y + 1, z)) {
            let studs = studPositions.get(id);
            if (!studs) studPositions.set(id, (studs = []));
            studs.push(x, y, z);
          }
        }
      }
    }

    const matrix = new THREE.Matrix4();
    for (const def of BLOCKS) {
      const list = positions.get(def.id) ?? [];
      const count = list.length / 3;
      let mesh = this.meshes.get(def.id);
      if (!mesh || mesh.instanceMatrix.count < count) {
        // grow with headroom so steady building doesn't reallocate every edit
        if (mesh) {
          this.scene.remove(mesh);
          mesh.dispose();
        }
        const material = this.materials.get(def.id);
        if (!material) continue;
        mesh = new THREE.InstancedMesh(this.geometry, material, count + 256);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (def.key === "glass") mesh.renderOrder = 2;
        this.scene.add(mesh);
        this.meshes.set(def.id, mesh);
      }
      for (let i = 0; i < count; i++) {
        matrix.makeTranslation(list[i * 3]! + 0.5, list[i * 3 + 1]! + 0.5, list[i * 3 + 2]! + 0.5);
        mesh.setMatrixAt(i, matrix);
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      // instance bounds are NOT tracked automatically — without this the
      // stale sphere gets frustum-culled once the camera drops into a dig
      // hole and the whole block type vanishes mid-frame
      mesh.computeBoundingSphere();
    }

    for (const def of BLOCKS) {
      const list = studPositions.get(def.id) ?? [];
      const count = list.length / 3;
      let mesh = this.studMeshes.get(def.id);
      if (!mesh || mesh.instanceMatrix.count < count) {
        if (mesh) {
          this.scene.remove(mesh);
          mesh.dispose();
        }
        const material = this.materials.get(def.id);
        if (!material) continue;
        // studs share the brick's textured material → the crayon pattern
        // continues onto them (no flat floating caps)
        mesh = new THREE.InstancedMesh(this.studGeometry, material, count + 512);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        this.studMeshes.set(def.id, mesh);
      }
      for (let i = 0; i < count; i++) {
        matrix.makeTranslation(list[i * 3]! + 0.5, list[i * 3 + 1]! + 1, list[i * 3 + 2]! + 0.5);
        mesh.setMatrixAt(i, matrix);
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    for (const mesh of this.studMeshes.values()) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.studGeometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.scene.remove(this.highlight);
    this.highlight.geometry.dispose();
    (this.highlight.material as THREE.Material).dispose();
    this.geometry.dispose();
  }
}
