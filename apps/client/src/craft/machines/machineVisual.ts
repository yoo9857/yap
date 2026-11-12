import {PART_COLORS,BASE_PART_COLOR,wheelRadius,wingArea,thrustForce} from "./customization.js";
import {AIR} from "./aero.js";
import * as THREE from "three";
import { AimOutline } from "../aimOutline.js";
import { castsInstancedShadow } from "../../render/instancedDepth.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { settings } from "../../ui/settings.js";
import {
  DIRECTIONS,
  PARTS,
  PART_ORDER,
  type Blueprint,
  type PartKind,
} from "./blueprint.js";
import { PHYSICS_RULES } from "./physicsRules.js";

const WHITE = new THREE.Color(1, 1, 1);

export type MachineRole="body"|"studs"|"wheel-fixed"|"wheel-strut"|"wheel-hub";
interface Template {
  role?:MachineRole;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}
/** Shared immutable GLB resources; each machine batches repeated parts with instancing. */
export class MachineAssets {
  readonly templates = new Map<PartKind, Template[]>();
  loaded = false;
  private disposed = false;
  private promise: Promise<void> | null = null;

  /**
   * Lazy on purpose. The detailed kit is about 2.4 MB (mobile LOD about 1.3 MB) and most Craft Island sessions
   * never open the machine lab, so the download starts the first time
   * something actually awaits it rather than during island boot.
   */
  get ready(): Promise<void> {
    return this.promise ??= this.load().catch(error => {
      this.release();
      this.promise = null;
      throw error;
    });
  }

  private load(): Promise<void> {
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const limitedDevice = navigator.hardwareConcurrency <= 4 || (memory !== undefined && memory <= 4);
    const low = window.matchMedia("(max-width: 700px)").matches || settings.graphics === "low" ||
      (settings.graphics === "auto" && limitedDevice);
    return new GLTFLoader()
      .loadAsync(`/models/machines/machine-kit${low ? "-lod1" : ""}.glb?v=2.0.0`)
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
                role:(o.userData.machineRole??"body") as MachineRole,
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
      materials = new Set<THREE.Material>(),
      textures = new Set<THREE.Texture>();
    for (const templates of this.templates.values())
      for (const t of templates) {
        geometries.add(t.geometry);
        materials.add(t.material);
      }
    for (const g of geometries) g.dispose();
    for (const m of materials) {
      for (const value of Object.values(m))
        if (value instanceof THREE.Texture) textures.add(value);
      m.dispose();
    }
    for (const texture of textures) {
      const image: unknown = texture.image;
      texture.dispose();
      if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) image.close();
    }
    this.templates.clear();
    this.loaded = false;
  }
  dispose(): void {
    this.disposed = true;
    this.release();
  }
}

/** A wheel bracket points inward to an adjacent structural cell. */
export function wheelMountSide(blueprint:Blueprint,cell:readonly number[]):number {
  const preferred=cell[0]!<0?1:-1;
  for(const dx of [preferred,-preferred])if(blueprint.parts.some(p=>p.kind!=="wheel"&&p.cell[0]===cell[0]!+dx&&p.cell[1]===cell[1]&&p.cell[2]===cell[2]))return -dx;
  return 0;
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

  private readonly angles=new THREE.Euler();
  private readonly mounts=new Map<number,{side:number;fixed:THREE.Matrix4;strut:THREE.Matrix4;hub:THREE.Matrix4}>();
  constructor(private readonly assets: MachineAssets) {}
  private partMatrix(index:number,role:MachineRole):THREE.Matrix4 {
    const mount=this.mounts.get(index);
    return role==="wheel-fixed"?mount!.fixed:role==="wheel-strut"?mount!.strut:role==="wheel-hub"?mount!.hub:this.transforms[index]!;
  }
  rebuild(blueprint: Blueprint, onlyPart?: number): void {
    this.clear();
    this.blueprint = blueprint;
    const occupied=new Map(blueprint.parts.map(p=>[p.cell.join(","),p]));
    blueprint.parts.forEach((p,index)=>{
      if (onlyPart !== undefined && index !== onlyPart) return;
      this.position.fromArray(p.cell);this.rotation.identity();this.scale.set(1,1,1);
      if(PARTS[p.kind].directional)this.rotation.setFromUnitVectors(this.up,this.direction.fromArray(DIRECTIONS[p.direction]!.vector));
      if(p.kind==="wing"){const f=Math.sqrt(wingArea(p)/AIR.wingArea);this.scale.set(f,1,f);}
      this.transforms[index]=new THREE.Matrix4().compose(this.position,this.rotation,this.scale);
      if(p.kind==="wheel"){
        this.mounts.set(index,{side:wheelMountSide(blueprint,p.cell),fixed:new THREE.Matrix4(),strut:new THREE.Matrix4(),hub:new THREE.Matrix4()});
        this.wheel(index,PHYSICS_RULES.suspensionLength,0,0);
      }
    });
    for(const [kind,templates]of this.assets.templates){
      for(const template of templates){
        const role=template.role??"body";
        const indices=blueprint.parts.flatMap((p,i)=>{
          if (onlyPart !== undefined && i !== onlyPart) return [];
          if(p.kind!==kind)return [];
          if(role.startsWith("wheel-")&&!this.mounts.get(i)?.side)return [];
          if(role==="studs"){
            const d=PARTS[kind].directional?DIRECTIONS[p.direction]!.vector:[0,1,0];
            const above=occupied.get(p.cell.map((v,a)=>v+d[a]!).join(","));
            if(above&&["frame","cockpit","ballast","gyro"].includes(above.kind))return [];
          }
          return [i];
        });
        if(!indices.length)continue;
        const mesh=new THREE.InstancedMesh(template.geometry,template.material,indices.length);
        mesh.userData.partIndices=indices;mesh.userData.machineRole=role;castsInstancedShadow(mesh);
        if(template.material.transparent)mesh.castShadow=false;
        mesh.receiveShadow=true;
        const baseColors:THREE.Color[]=[];
        indices.forEach((index,i)=>{
          mesh.setMatrixAt(i,this.partMatrix(index,role));
          const part=blueprint.parts[index]!,color=part.custom?.color??BASE_PART_COLOR[part.kind],tint=new THREE.Color(1,1,1);
          if(template.material.name==="Warm enamel"){
            tint.setHex(PART_COLORS[color].hex);const base=new THREE.Color(PART_COLORS.cream.hex);
            tint.setRGB(tint.r/base.r,tint.g/base.g,tint.b/base.b);
          }
          baseColors.push(tint);mesh.setColorAt(i,tint);
        });
        mesh.userData.baseColors=baseColors;
        mesh.computeBoundingSphere();this.meshes.push(mesh);this.root.add(mesh);
      }
    }
    const count = onlyPart === undefined ? blueprint.parts.filter((p) => p.kind === "thruster").length : 0;
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
        mesh.setColorAt(slot, tint===WHITE?(mesh.userData.baseColors as THREE.Color[]|undefined)?.[slot]??WHITE:tint);
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
    const part=this.blueprint.parts[index]!;
    this.position.fromArray(part.cell);this.position.y-=length;
    this.rotation.setFromEuler(this.angles.set(spin,steer,0,"YXZ"));
    const size=radiusScale*wheelRadius(part)/PHYSICS_RULES.wheelRadius;
    this.transforms[index]!.compose(this.position,this.rotation,this.scale.set(size,size,size));
    const mount=this.mounts.get(index);if(!mount)return;
    const yaw=mount.side<0?Math.PI:0;
    this.position.fromArray(part.cell);this.rotation.setFromAxisAngle(this.up,yaw);
    mount.fixed.compose(this.position,this.rotation,this.scale.set(1,1,1));
    mount.strut.compose(this.position,this.rotation,this.scale.set(1,Math.max(.01,length)/PHYSICS_RULES.suspensionLength,1));
    this.position.y-=length;this.rotation.setFromEuler(this.angles.set(0,yaw+steer,0));
    mount.hub.compose(this.position,this.rotation,this.scale.set(1,1,1));
  }

  flushWheels(): void {
    for (const mesh of this.meshes) {
      const indices = mesh.userData.partIndices as number[];
      if (this.blueprint.parts[indices[0]!]!.kind !== "wheel") continue;
      indices.forEach((index, i) =>
        mesh.setMatrixAt(i, this.partMatrix(index,(mesh.userData.machineRole??"body") as MachineRole)),
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
      const length = (1.1 + 0.2 * Math.sin(time * 37 + n * 2))*thrustForce(p)/PHYSICS_RULES.thrustPerEngine;
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
    this.mounts.clear();
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
  /** The same two-tone, constant-width box as the world's aim (a 1 px line vanished on parts). */
  private readonly outline = new AimOutline({ size: 1.02, xray: true });
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
    this.outline.object.visible = true; // shown with the cursor (the root carries visibility)
    this.arrow.renderOrder = 12;
    this.root.add(this.outline.object, this.arrow);
  }

  set(kind: PartKind, direction: number, mountSide=1): void {
    const signature = `${kind}:${direction}:${mountSide}`;
    if (signature === this.signature) return;
    // not cached before the kit has loaded: the post-load set() must build the real part model
    if (this.assets.templates.size > 0) this.signature = signature;
    for (const mesh of this.meshes) this.root.remove(mesh);
    this.meshes.length = 0;
    for (const template of this.assets.templates.get(kind) ?? []) {
      const role=template.role??"body";
      if(role.startsWith("wheel-")&&!mountSide)continue;
      const mesh = new THREE.Mesh(template.geometry, this.material);
      mesh.userData.machineRole=role;
      if(kind==="wheel"){
        if(role==="body"||role==="wheel-hub")mesh.position.y=-PHYSICS_RULES.suspensionLength;
        if(role.startsWith("wheel-")&&mountSide<0)mesh.rotation.y=Math.PI;
      }
      this.meshes.push(mesh);
      this.root.add(mesh);
    }
    const directional = PARTS[kind].directional;
    this.direction.fromArray(DIRECTIONS[direction]!.vector);
    const rotation = new THREE.Quaternion();
    if (directional) rotation.setFromUnitVectors(this.up, this.direction);
    for (const mesh of this.meshes) if(kind!=="wheel")mesh.quaternion.copy(rotation);
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
    this.outline.dispose();
    this.arrow.geometry.dispose();
    (this.arrow.material as THREE.Material).dispose();
    this.root.clear();
    this.meshes.length = 0;
  }
}
