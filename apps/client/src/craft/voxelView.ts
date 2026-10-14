import * as THREE from "three";
import { BLOCKS, blockById, textureUrl, type BlockDef } from "./blocks.js";
import { loadTexture } from "../render/textures.js";
import { WORLD_X, WORLD_Y, WORLD_Z, type VoxelWorld } from "./voxelWorld.js";
import { ROUND, isSlope, slopeYaw, slopeTilt } from "./shapes.js";
import {
  brickOrientation,
  cubeBrickGeometry,
  roundBrickGeometry,
  slopeBrickGeometry,
  studGeometry,
} from "./brickGeometry.js";

/** 2×2 stud layout on a 1 m brick top (0.5 m sub-cells) — dense small studs to
 *  match the jump-map bricks instead of one oversized stud. */
const STUD_OFFSETS: readonly [number, number][] = [
  [-0.25, -0.25],
  [0.25, -0.25],
  [-0.25, 0.25],
  [0.25, 0.25],
];

/** Columns per instanced batch. The island is 160x160, so one batch per block
 *  type covered the whole map and nothing could ever be frustum-culled: the
 *  GPU drew the far side of the world every frame. Batching per chunk lets
 *  three cull whole chunks that are behind the camera or off screen. */
const CHUNK = 32;
/** Studs are 9 cm caps. Past this they are sub-pixel, but they were 41% of the
 *  island's triangles, so they are only emitted near the viewer. */
const STUD_RANGE = 46;
/** How far the viewer may move before the stud ring is rebuilt. */
const STUD_STEP = 8;

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
  /** Top-exposed cells per block id, kept from the last full scan so the stud
   *  ring can be re-filtered on movement without re-walking the grid. */
  private readonly studCells = new Map<number, number[]>();
  private readonly studEye = new THREE.Vector3(Infinity, Infinity, Infinity);
  private studsDirty = true;

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
   * Matched to the tower's `brickMaterial`: MeshStandard (same roughness/
   * metalness → same lighting) carrying the SAME crayon-doodle tile as the jump
   * map (grass-top, stone, …). The tile carries the hue; the solid crayon colour
   * is only the fallback until it loads / for a block with no tile.
   */
  private makeMaterial(def: BlockDef): THREE.Material {
    const isGlass = def.key === "glass";
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(def.color),
      roughness: 0.75,
      metalness: 0.05,
      transparent: isGlass,
      opacity: isGlass ? 0.55 : 1,
    });
    if (def.emissive) {
      material.emissive = new THREE.Color(def.color);
      material.emissiveIntensity = 0.55;
    }
    void loadTexture(textureUrl(def)).then((tex) => {
      if (!tex) return; // keep the solid crayon colour
      material.map = tex;
      material.color.set(0xffffff); // the tile carries the hue, exactly like the tower
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

  /**
   * Rebuild instance lists if an edit happened, and re-ring the studs if the
   * viewer has moved far enough. `eye` is optional: without it every stud is
   * emitted, which is the old behaviour and is what a fly-through wants.
   */
  update(world: VoxelWorld, eye?: THREE.Vector3): void {
    if (eye && this.studEye.distanceToSquared(eye) > STUD_STEP * STUD_STEP) {
      this.studEye.copy(eye);
      this.studsDirty = true;
    }
    if (!this.dirty) {
      if (this.studsDirty) this.rebuildStuds(eye);
      return;
    }
    this.dirty = false;
    this.studsDirty = true;
    if (eye) this.studEye.copy(eye);

    const positions = new Map<string, number[]>(); // `${cx},${cz}:${id}:${shape}` → xyz…
    this.studCells.clear();
    for (let y = 0; y < WORLD_Y; y++) {
      for (let z = 0; z < WORLD_Z; z++) {
        for (let x = 0; x < WORLD_X; x++) {
          const id = world.get(x, y, z);
          if (id === 0 || !world.isExposed(x, y, z)) continue;
          const shape = world.getShape(x, y, z);
          const key = `${(x / CHUNK) | 0},${(z / CHUNK) | 0}:${id}:${shape}`;
          let list = positions.get(key);
          if (!list) positions.set(key, (list = []));
          list.push(x, y, z);
          const def = blockById(id);
          // studs only cap flat-topped bricks (cube/round), never a slope
          if (def && !def.noStud && (shape === 0 || shape === ROUND) && !world.isSolid(x, y + 1, z)) {
            let studs = this.studCells.get(id);
            if (!studs) this.studCells.set(id, (studs = []));
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
        if (mesh) {
          this.scene.remove(mesh);
          mesh.dispose();
          this.meshes.delete(key);
        }
        continue;
      }
      const parts = key.split(":");
      const id = Number(parts[1]);
      const shape = Number(parts[2]);
      if (!mesh || mesh.instanceMatrix.count < count) {
        if (mesh) {
          this.scene.remove(mesh);
          mesh.dispose();
        }
        const material = this.materials.get(id);
        if (!material) continue;
        // Keep a small geometric headroom.  Linear over-allocation makes every
        // edit allocate a new GPU buffer and the old buffer can linger until a
        // later renderer flush; geometric growth keeps edits amortized while
        // avoiding the huge fixed reserve that used to be paid up front.
        const capacity = Math.max(64, Math.ceil(count * 1.25));
        mesh = new THREE.InstancedMesh(this.geometryFor(shape), material, capacity);
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

    this.rebuildStuds(eye);
  }

  /**
   * 2×2 studs per top face (0.5 m sub-cells) so a 1 m voxel reads as small,
   * densely-studded LEGO like the jump-map's 0.7 m bricks — not one big cube.
   * Only cells within STUD_RANGE of the viewer are emitted: on the 160×160
   * island the full set was 128k instances and 41% of all triangles, for caps
   * that are a few pixels across beyond ~50 m.
   */
  private rebuildStuds(eye?: THREE.Vector3): void {
    this.studsDirty = false;
    const cells = STUD_OFFSETS.length;
    const matrix = new THREE.Matrix4();
    const range = STUD_RANGE * STUD_RANGE;
    for (const def of BLOCKS) {
      const list = this.studCells.get(def.id) ?? [];
      // Count what is actually in range before touching the GPU buffer.
      let near = 0;
      for (let i = 0; i < list.length; i += 3) {
        if (!eye || this.withinRange(list, i, eye, range)) near++;
      }
      const count = near * cells;
      let mesh = this.studMeshes.get(def.id);
      // Do not create a 2,048-instance GPU buffer for an unused block type.
      // This was the main memory multiplier as the palette grew.
      if (count === 0) {
        if (mesh) mesh.count = 0;
        continue;
      }
      if (!mesh || mesh.instanceMatrix.count < count) {
        if (mesh) {
          this.scene.remove(mesh);
          mesh.dispose();
        }
        const material = this.materials.get(def.id);
        if (!material) continue;
        const capacity = Math.max(256, Math.ceil(count * 1.25));
        mesh = new THREE.InstancedMesh(this.studGeometry, material, capacity);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        this.studMeshes.set(def.id, mesh);
      }
      let k = 0;
      for (let i = 0; i < list.length; i += 3) {
        if (eye && !this.withinRange(list, i, eye, range)) continue;
        const x = list[i]! + 0.5;
        const y = list[i + 1]! + 1;
        const z = list[i + 2]! + 0.5;
        for (const [ox, oz] of STUD_OFFSETS) {
          matrix.makeTranslation(x + ox, y, z + oz);
          mesh.setMatrixAt(k++, matrix);
        }
      }
      mesh.count = k;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  private withinRange(
    list: number[],
    i: number,
    eye: THREE.Vector3,
    range: number,
  ): boolean {
    const dx = list[i]! + 0.5 - eye.x;
    const dz = list[i + 2]! + 0.5 - eye.z;
    return dx * dx + dz * dz <= range;
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
