import * as THREE from "three";
import { BLOCKS, blockById, type BlockDef } from "./blocks.js";
import { crayonGrain } from "../render/crayonGrain.js";
import { WORLD_X, WORLD_Y, WORLD_Z, type VoxelWorld } from "./voxelWorld.js";
import { ROUND, isSlope, slopeYaw, slopeTilt } from "./shapes.js";
import {
  brickOrientation,
  cubeBrickGeometry,
  roundBrickGeometry,
  slopeBrickGeometry,
  studGeometry,
} from "./brickGeometry.js";

/**
 * Renders the island as InstancedMeshes, EXPOSED cells only (interior voxels
 * never reach the GPU). Batching key is (block id × brick shape): a cube uses a
 * softly rounded box, a round brick a cylinder, a slope a wedge — each tinted by
 * the block's solid crayon colour and (cube/round) capped with a stud. That mix
 * of real LEGO silhouettes on a studded grid is what reads as toy bricks, not a
 * Minecraft tile. A full rebuild scans the 256k grid in well under a ms.
 */
export class VoxelView {
  private readonly cubeGeo = cubeBrickGeometry();
  private readonly roundGeo = roundBrickGeometry();
  private readonly slopeGeo = slopeBrickGeometry();
  private readonly studGeometry = studGeometry();
  private readonly studMeshes = new Map<number, THREE.InstancedMesh>();
  private readonly meshes = new Map<string, THREE.InstancedMesh>(); // key: `${id}:${shape}`
  private readonly materials = new Map<number, THREE.Material>();
  private readonly highlight: THREE.LineSegments;
  private dirty = true;

  constructor(private readonly scene: THREE.Scene) {
    for (const def of BLOCKS) this.materials.set(def.id, this.makeMaterial(def));
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
    this.highlight = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x1f1f1f, linewidth: 2 }),
    );
    this.highlight.visible = false;
    scene.add(this.highlight);
  }

  private geometryFor(shape: number): THREE.BufferGeometry {
    return shape === ROUND ? this.roundGeo : isSlope(shape) ? this.slopeGeo : this.cubeGeo;
  }

  /**
   * Solid crayon LEGO brick, matched to the tower's `brickMaterial`:
   * MeshStandard with the SAME roughness/metalness so craft/battle bricks catch
   * light exactly like the jump-map platforms, one flat colour per block + a
   * faint shared grain (also on the characters). No per-block photo tile.
   */
  private makeMaterial(def: BlockDef): THREE.Material {
    const isGlass = def.key === "glass";
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(def.color),
      roughness: 0.75,
      metalness: 0.05,
      map: crayonGrain() ?? undefined,
      transparent: isGlass,
      opacity: isGlass ? 0.55 : 1,
    });
    if (def.emissive) {
      material.emissive = new THREE.Color(def.color);
      material.emissiveIntensity = 0.7;
    }
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

    const positions = new Map<string, number[]>(); // `${id}:${shape}` → xyz…
    const studPositions = new Map<number, number[]>(); // per id: top-exposed cube/round
    for (let y = 0; y < WORLD_Y; y++) {
      for (let z = 0; z < WORLD_Z; z++) {
        for (let x = 0; x < WORLD_X; x++) {
          const id = world.get(x, y, z);
          if (id === 0 || !world.isExposed(x, y, z)) continue;
          const shape = world.getShape(x, y, z);
          const key = `${id}:${shape}`;
          let list = positions.get(key);
          if (!list) positions.set(key, (list = []));
          list.push(x, y, z);
          const def = blockById(id);
          // studs only cap flat-topped bricks (cube/round), never a slope
          if (def && !def.noStud && (shape === 0 || shape === ROUND) && !world.isSolid(x, y + 1, z)) {
            let studs = studPositions.get(id);
            if (!studs) studPositions.set(id, (studs = []));
            studs.push(x, y, z);
          }
        }
      }
    }

    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    // every (id,shape) mesh that exists now OR existed last frame is revisited,
    // so a shape that vanished this edit gets its instance count zeroed
    const keys = new Set([...this.meshes.keys(), ...positions.keys()]);
    for (const key of keys) {
      const list = positions.get(key) ?? [];
      const count = list.length / 3;
      let mesh = this.meshes.get(key);
      if (count === 0) {
        if (mesh) mesh.count = 0;
        continue;
      }
      const sep = key.indexOf(":");
      const id = Number(key.slice(0, sep));
      const shape = Number(key.slice(sep + 1));
      if (!mesh || mesh.instanceMatrix.count < count) {
        if (mesh) {
          this.scene.remove(mesh);
          mesh.dispose();
        }
        const material = this.materials.get(id);
        if (!material) continue;
        mesh = new THREE.InstancedMesh(this.geometryFor(shape), material, count + 256);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (blockById(id)?.key === "glass") mesh.renderOrder = 2;
        this.scene.add(mesh);
        this.meshes.set(key, mesh);
      }
      if (isSlope(shape)) brickOrientation(slopeYaw(shape), slopeTilt(shape), q);
      else q.identity();
      for (let i = 0; i < count; i++) {
        pos.set(list[i * 3]! + 0.5, list[i * 3 + 1]! + 0.5, list[i * 3 + 2]! + 0.5);
        matrix.compose(pos, q, scl);
        mesh.setMatrixAt(i, matrix);
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      // instance bounds are NOT tracked automatically — without this the stale
      // sphere gets frustum-culled once the camera drops into a dig hole
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
    this.cubeGeo.dispose();
    this.roundGeo.dispose();
    this.slopeGeo.dispose();
  }
}
