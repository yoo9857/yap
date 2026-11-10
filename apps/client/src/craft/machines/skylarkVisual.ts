import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GARAGE_LAYER } from "./garageStage.js";
import { SKYLARK_PART_ORDER, type SkylarkComponent, type SkylarkPart } from "./skylarkParts.js";

const URL = "/models/machines/skylark.glb?v=1";
const AXIS = new THREE.Vector3(0, 1, 0); // Blender local +Z after the glTF axis conversion
const OPEN = THREE.MathUtils.degToRad(-98);
// Blender frame 42 spread offsets, expressed as GLB world-space vectors.
// Each child inherits its host's spread in addition to the offset below.
const SPREAD: Record<SkylarkPart, readonly [number, number, number]> = {
  PART_Airframe: [0, 0, 0],
  PART_Canopy: [-1.04, .58, .70],
  PART_Powerpack: [.95, .77, -.11],
  PART_Mast: [.28, .53, -.22],
  PART_MainRotor: [.08, .63, 0],
  PART_TailBoom: [0, .18, -1.02],
  PART_TailRotor: [.61, .09, -.12],
  PART_Skid_L: [-1.05, .095, .08],
  PART_Skid_R: [1.05, .095, .08],
  PART_Searchlight: [0, -.28, .80],
};

interface MountedPart extends SkylarkComponent {
  node: THREE.Object3D;
  position: THREE.Vector3;
  spread: THREE.Vector3;
  meshes: THREE.Mesh[];
}

function isMesh(object: THREE.Object3D): object is THREE.Mesh {
  return object instanceof THREE.Mesh;
}

function readParts(scene: THREE.Group): MountedPart[] | null {
  scene.updateMatrixWorld(true);
  const parts: MountedPart[] = [];
  for (const key of SKYLARK_PART_ORDER) {
    const node = scene.getObjectByName(key);
    const partId: unknown = node?.userData.part_id;
    if (node?.userData.role !== "part" || typeof partId !== "string" || !node.parent) return null;
    const socket = node.parent;
    let connection = null;
    if (key !== "PART_Airframe") {
      const host = socket.parent?.name as SkylarkPart;
      const plug = node.children.find(child => child.userData.role === "plug");
      const profile: unknown = socket.userData.profile_id;
      if (socket.userData.role !== "socket" || !SKYLARK_PART_ORDER.includes(host) ||
          typeof profile !== "string" || !plug || plug.userData.profile_id !== profile ||
          plug.userData.connector_id !== socket.userData.connector_id ||
          plug.getWorldPosition(new THREE.Vector3()).distanceTo(socket.getWorldPosition(new THREE.Vector3())) > .001 ||
          plug.getWorldQuaternion(new THREE.Quaternion()).angleTo(socket.getWorldQuaternion(new THREE.Quaternion())) > THREE.MathUtils.degToRad(.25))
        return null;
      connection = { host, socket: socket.name, profile };
    }
    const position = node.position.clone();
    const spread = socket.worldToLocal(node.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(...SPREAD[key])))
      .sub(position);
    parts.push({ key, partId, connection, node, position, spread, meshes: [] });
  }
  // Every visible mesh belongs to its closest part root, including the HOME
  // rig and glazing under the cockpit. Nested mounted parts remain distinct.
  const roots = new Map(parts.map(part => [part.node, part]));
  scene.traverse(object => {
    if (!isMesh(object)) return;
    for (let owner = object.parent; owner; owner = owner.parent) {
      const part = roots.get(owner);
      if (part) {
        part.meshes.push(object);
        return;
      }
    }
  });
  return parts.every(part => part.meshes.length) ? parts : null;
}

function meshBounds(mesh: THREE.Mesh): THREE.Box3 | null {
  if (mesh instanceof THREE.SkinnedMesh) {
    if (!mesh.boundingBox) mesh.computeBoundingBox();
    return mesh.boundingBox;
  }
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox;
}

function release(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse(object => {
    if (!isMesh(object)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
    if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  textures.forEach(texture => texture.dispose());
}

export class SkylarkVisual {
  readonly root = new THREE.Group();
  private loading?: Promise<void>;
  private model?: THREE.Group;
  private parts: MountedPart[] = [];
  private readonly owners = new Map<THREE.Object3D, SkylarkPart>();
  private readonly outline = new THREE.Box3Helper(new THREE.Box3(), 0xffd37a);
  private mode?: { running: boolean; exploded: boolean; selected: SkylarkPart | null };
  private mainRotor?: THREE.Object3D;
  private tailRotor?: THREE.Object3D;
  private door?: THREE.Object3D;
  private disposed = false;
  private rpm = 0;

  constructor() {
    this.root.visible = false;
    this.root.position.y = -.5; // Skid soles line up with the test-drive landing colliders.
    this.outline.visible = false;
    this.outline.layers.set(GARAGE_LAYER);
    this.root.add(this.outline);
  }

  get loaded(): boolean {
    return !!this.model;
  }

  get components(): readonly SkylarkComponent[] {
    return this.parts;
  }

  get ready(): Promise<void> {
    return this.loading ??= this.load().catch(error => {
      this.loading = undefined;
      throw error;
    });
  }

  private async load(): Promise<void> {
    const { scene } = await new GLTFLoader().loadAsync(URL);
    if (this.disposed) {
      release(scene);
      return;
    }
    const door = scene.getObjectByName("DOOR_Hinge_R");
    const mainRotor = scene.getObjectByName("PART_MainRotor");
    const tailRotor = scene.getObjectByName("PART_TailRotor");
    const parts = readParts(scene);
    if (!parts || !door || !mainRotor || !tailRotor ||
        !(scene.getObjectByName("HOMESET_Mesh") instanceof THREE.SkinnedMesh)) {
      release(scene);
      throw new Error("Invalid Skylark model");
    }
    this.model = scene;
    this.parts = parts;
    for (const part of parts) for (const mesh of part.meshes) this.owners.set(mesh, part.key);
    this.door = door;
    this.mainRotor = mainRotor;
    this.tailRotor = tailRotor;
    scene.traverse(object => object.layers.enable(GARAGE_LAYER));
    this.root.add(scene);
  }

  setMode(running: boolean, exploded: boolean, selected: SkylarkPart | null): boolean {
    if (!this.loaded || (this.mode?.running === running && this.mode.exploded === exploded &&
        this.mode.selected === selected)) return false;
    const layoutChanged = this.mode?.running !== running || this.mode.exploded !== exploded;
    this.mode = { running, exploded, selected };
    if (layoutChanged) {
      for (const part of this.parts) part.node.position.copy(part.position).addScaledVector(part.spread, exploded ? 1 : 0);
      this.door?.quaternion.setFromAxisAngle(AXIS, running || exploded ? 0 : OPEN);
      if (!running) {
        this.mainRotor?.quaternion.identity();
        this.tailRotor?.quaternion.identity();
        this.rpm = 0;
      }
    }
    this.outlinePart(selected);
    return layoutChanged;
  }

  measure(bounds: THREE.Box3, corners: THREE.Vector3[]): void {
    for (const part of this.parts) for (const mesh of part.meshes) {
      const box = meshBounds(mesh);
      if (!box || box.isEmpty()) continue;
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z]) {
            const point = new THREE.Vector3(x, y, z).applyMatrix4(mesh.matrixWorld);
            bounds.expandByPoint(point);
            corners.push(point);
          }
    }
  }

  pick(ray: THREE.Raycaster): SkylarkPart | null {
    const hit = ray.intersectObjects([...this.owners.keys()], false)[0];
    return hit ? this.owners.get(hit.object) ?? null : null;
  }

  private outlinePart(key: SkylarkPart | null): void {
    this.outline.box.makeEmpty();
    const part = this.parts.find(component => component.key === key);
    if (part) {
      this.root.updateWorldMatrix(true, true);
      const inverse = this.root.matrixWorld.clone().invert();
      const transform = new THREE.Matrix4();
      const bounds = new THREE.Box3();
      for (const mesh of part.meshes) {
        const box = meshBounds(mesh);
        if (box) this.outline.box.union(bounds.copy(box).applyMatrix4(transform.multiplyMatrices(inverse, mesh.matrixWorld)));
      }
    }
    this.outline.visible = !this.outline.box.isEmpty();
  }

  step(dt: number, lift: number): void {
    this.rpm = THREE.MathUtils.damp(this.rpm, 2 + 11 * Math.min(1, lift), 3, dt);
    this.mainRotor?.rotateOnAxis(AXIS, this.rpm * dt);
    this.tailRotor?.rotateOnAxis(AXIS, -this.rpm * dt * 2.75);
  }

  dispose(): void {
    this.disposed = true;
    if (this.model) release(this.model);
    this.outline.dispose();
    this.owners.clear();
    this.root.clear();
  }
}
