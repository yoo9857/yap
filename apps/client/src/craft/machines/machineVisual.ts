import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  DIRECTIONS,
  PARTS,
  PART_ORDER,
  type Blueprint,
  type PartKind,
} from "./blueprint.js";
import { PHYSICS_RULES } from "./physicsRules.js";

const WHITE = new THREE.Color(1, 1, 1);

interface Template {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}
/** Shared immutable GLB resources; each machine batches repeated parts with instancing. */
export class MachineAssets {
  readonly ready: Promise<void>;
  readonly templates = new Map<PartKind, Template[]>();
  loaded = false;
  private disposed = false;
  constructor() {
    const low = window.matchMedia("(max-width: 700px)").matches;
    this.ready = new GLTFLoader()
      .loadAsync(`/models/machines/machine-kit${low ? "-lod1" : ""}.glb`)
      .then((gltf) => {
        for (const part of gltf.scene.children) {
          const meshes: Template[] = [];
          part.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              if (Array.isArray(o.material))
                throw new Error("Unsupported machine asset material group");
              meshes.push({
                geometry: o.geometry as THREE.BufferGeometry,
                material: o.material as THREE.Material,
              });
            }
          });
          this.templates.set(part.name as PartKind, meshes);
        }
        for (const name of PART_ORDER)
          if (!this.templates.get(name)?.length)
            throw new Error(`Missing machine asset: ${name}`);
        this.loaded = true;
        if (this.disposed) this.release();
      });
  }
  private release(): void {
    const geometries = new Set<THREE.BufferGeometry>(),
      materials = new Set<THREE.Material>();
    for (const templates of this.templates.values())
      for (const t of templates) {
        geometries.add(t.geometry);
        materials.add(t.material);
      }
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    this.templates.clear();
  }
  dispose(): void {
    this.disposed = true;
    this.release();
  }
}

export class MachineVisual {
  readonly root = new THREE.Group();
  readonly meshes: THREE.InstancedMesh[] = [];
  private readonly transforms: THREE.Matrix4[] = [];
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly matrix = new THREE.Matrix4();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly direction = new THREE.Vector3();
  private readonly exhaustGeometry = new THREE.ConeGeometry(
    0.27,
    1,
    12,
    1,
    true,
  );
  private readonly exhaustMaterial = new THREE.MeshBasicMaterial({
    color: 0x73f5ef,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private exhaust: THREE.InstancedMesh | null = null;
  private highlighted = -1;
  private blueprint: Blueprint = { version: 1, name: "", parts: [] };

  constructor(private readonly assets: MachineAssets) {}
  rebuild(blueprint: Blueprint): void {
    this.clear();
    this.blueprint = blueprint;
    blueprint.parts.forEach((p, index) => {
      this.position.fromArray(p.cell);
      this.rotation.identity();
      if (p.kind === "wheel") this.position.y -= PHYSICS_RULES.suspensionLength;
      if (PARTS[p.kind].directional)
        this.rotation.setFromUnitVectors(
          this.up,
          this.direction.fromArray(DIRECTIONS[p.direction]!.vector),
        );
      this.transforms[index] = new THREE.Matrix4().compose(
        this.position,
        this.rotation,
        this.scale.set(1, 1, 1),
      );
    });
    for (const [kind, templates] of this.assets.templates) {
      const indices = blueprint.parts.flatMap((p, i) =>
        p.kind === kind ? [i] : [],
      );
      if (!indices.length) continue;
      for (const t of templates) {
        const mesh = new THREE.InstancedMesh(
          t.geometry,
          t.material,
          indices.length,
        );
        mesh.userData.partIndices = indices;
        mesh.castShadow = mesh.receiveShadow = true;
        indices.forEach((index, i) =>
          mesh.setMatrixAt(i, this.transforms[index]!),
        );
        mesh.computeBoundingSphere();
        this.meshes.push(mesh);
        this.root.add(mesh);
      }
    }
    const count = blueprint.parts.filter((p) => p.kind === "thruster").length;
    if (count) {
      this.exhaust = new THREE.InstancedMesh(
        this.exhaustGeometry,
        this.exhaustMaterial,
        count,
      );
      this.exhaust.count = 0;
      this.exhaust.frustumCulled = false;
      this.root.add(this.exhaust);
    }
  }
  partIndex(hit: THREE.Intersection): number | undefined {
    return (hit.object.userData.partIndices as number[] | undefined)?.[
      hit.instanceId ?? -1
    ];
  }
  /**
   * Tint one part (the one the cursor would remove) without rebuilding the
   * instanced batches — three allocates the instanceColor buffer on demand.
   */
  highlight(index: number, color: THREE.Color): void {
    if (index === this.highlighted) return;
    const paint = (target: number, tint: THREE.Color) => {
      if (target < 0) return;
      for (const mesh of this.meshes) {
        const slot = (mesh.userData.partIndices as number[]).indexOf(target);
        if (slot < 0) continue;
        mesh.setColorAt(slot, tint);
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    };
    paint(this.highlighted, WHITE);
    paint(index, color);
    this.highlighted = index;
  }
  wheel(
    index: number,
    length: number,
    spin: number,
    steer: number,
    radiusScale = 1,
  ): void {
    this.position.fromArray(this.blueprint.parts[index]!.cell);
    this.position.y -= length;
    this.rotation.setFromEuler(new THREE.Euler(spin, steer, 0, "YXZ"));
    this.transforms[index]!.compose(
      this.position,
      this.rotation,
      this.scale.set(radiusScale, radiusScale, radiusScale),
    );
  }
  flushWheels(): void {
    for (const mesh of this.meshes) {
      const indices = mesh.userData.partIndices as number[];
      if (this.blueprint.parts[indices[0]!]!.kind !== "wheel") continue;
      indices.forEach((index, i) =>
        mesh.setMatrixAt(i, this.transforms[index]!),
      );
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }
  thrust(lift: number, boost: boolean, time: number): void {
    if (!this.exhaust) return;
    let n = 0;
    for (const p of this.blueprint.parts) {
      if (p.kind !== "thruster" || (p.direction === 0 ? lift <= 0 : !boost))
        continue;
      const length = 1.1 + 0.2 * Math.sin(time * 37 + n * 2);
      this.direction.fromArray(DIRECTIONS[p.direction]!.vector).negate();
      this.rotation.setFromUnitVectors(this.up, this.direction);
      this.position
        .fromArray(p.cell)
        .addScaledVector(this.direction, 0.46 + length / 2);
      // Cone base is at -Y: rotate it so the widest end sits at the nozzle.
      this.matrix.compose(
        this.position,
        this.rotation,
        this.scale.set(1, length, 1),
      );
      this.exhaust.setMatrixAt(n++, this.matrix);
    }
    this.exhaust.count = n;
    this.exhaust.instanceMatrix.needsUpdate = true;
  }
  private clear(): void {
    this.highlighted = -1;
    for (const m of this.meshes) m.dispose();
    this.meshes.length = 0;
    this.transforms.length = 0;
    this.exhaust?.dispose();
    this.exhaust = null;
    this.root.clear();
  }
  dispose(): void {
    this.clear();
    this.exhaustGeometry.dispose();
    this.exhaustMaterial.dispose();
  }
}

/**
 * Translucent preview of the part about to be placed. It uses the real part
 * geometry rather than a generic cube, so the player sees which way a thruster
 * will fire or a wing will lift before committing the click.
 */
export class GhostPart {
  readonly root = new THREE.Group();
  private readonly material = new THREE.MeshBasicMaterial({
    color: 0x7fd96a,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  private readonly outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02)),
    new THREE.LineBasicMaterial({ color: 0x1f1f1f, depthTest: false }),
  );
  private readonly arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.17, 0.46, 10),
    new THREE.MeshBasicMaterial({ color: 0xffd21c, depthTest: false }),
  );
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly direction = new THREE.Vector3();
  private readonly meshes: THREE.Mesh[] = [];
  private signature = "";

  constructor(private readonly assets: MachineAssets) {
    this.root.visible = false;
    this.outline.renderOrder = 12;
    this.arrow.renderOrder = 12;
    this.root.add(this.outline, this.arrow);
  }

  set(kind: PartKind, direction: number): void {
    const signature = `${kind}:${direction}`;
    if (signature === this.signature) return;
    this.signature = signature;
    for (const mesh of this.meshes) this.root.remove(mesh);
    this.meshes.length = 0;
    for (const template of this.assets.templates.get(kind) ?? []) {
      const mesh = new THREE.Mesh(template.geometry, this.material);
      this.meshes.push(mesh);
      this.root.add(mesh);
    }
    const directional = PARTS[kind].directional;
    this.direction.fromArray(DIRECTIONS[direction]!.vector);
    const rotation = new THREE.Quaternion();
    if (directional) rotation.setFromUnitVectors(this.up, this.direction);
    for (const mesh of this.meshes) mesh.quaternion.copy(rotation);
    this.arrow.visible = directional;
    this.arrow.quaternion.copy(rotation);
    this.arrow.position.copy(this.direction).multiplyScalar(0.75);
  }

  /** Red while the cursor is set to erase, green while placing. */
  setErasing(erasing: boolean): void {
    this.material.color.setHex(erasing ? 0xef3a5d : 0x7fd96a);
  }

  dispose(): void {
    this.material.dispose();
    this.outline.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
    this.arrow.geometry.dispose();
    (this.arrow.material as THREE.Material).dispose();
    this.root.clear();
    this.meshes.length = 0;
  }
}
