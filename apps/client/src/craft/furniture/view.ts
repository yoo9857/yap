import * as THREE from "three";
import { crayonGrain } from "../../player/blockParts.js";
import { INK_INSTANCED_LAYER } from "../../render/inkOutline.js";
import { castsInstancedShadow } from "../../render/instancedDepth.js";
import { CATALOG, furnitureDef } from "./catalog/index.js";
import { footprintCenter } from "./footprint.js";
import type { FurnitureLayout } from "./layout.js";
import { buildFurnitureGeometry } from "./model.js";
import type { PlacedFurniture } from "./types.js";

/**
 * Draws every placed piece: ONE instanced mesh per (kind, colour variant) in
 * use, so the cost is a draw call per distinct look on the field, however much
 * furniture there is. Geometries are built lazily the first time a look is
 * needed (a ~50-piece catalog × variants would be a long boot otherwise) and
 * kept until the mode is torn down.
 *
 * Instances are on `INK_INSTANCED_LAYER` (the ink pass's mask layer for
 * instanced meshes — see inkOutline.ts for why it is not `INK_LAYER`), so each
 * piece gets the same single outline the
 * pets do. They carry no inverted-hull shells — those exist only as the WebXR
 * fallback, and the voxel modes have no VR.
 */
export class FurnitureView {
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly meshes = new Map<string, THREE.InstancedMesh>();
  private readonly material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.68,
    metalness: 0.02,
    map: crayonGrain(),
  });
  private readonly ghost: THREE.Mesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private drawnVersion = -1;
  private drawnOriginX = Number.NaN;
  private drawnOriginZ = Number.NaN;

  constructor(private readonly scene: THREE.Scene) {
    this.ghost = new THREE.Mesh();
    this.ghost.visible = false;
    this.ghost.renderOrder = 2;
    scene.add(this.ghost);
    // One empty instanced mesh from the start, so the boot-time `warmupGpu`
    // compiles the instanced vertex-colour program — otherwise the first piece
    // a child places pays a shader compile, a visible hitch.
    this.mesh(CATALOG[0]!.key, 0, false, 1);
  }

  /** A "look": kind + colour + open/closed. Each is one geometry, one mesh. */
  private static lookKey = (kind: string, variant: number, open: boolean): string => `${kind}#${variant}${open ? "o" : ""}`;

  private geometry(kind: string, variant: number, open: boolean): THREE.BufferGeometry {
    const key = FurnitureView.lookKey(kind, variant, open);
    let geo = this.geometries.get(key);
    if (!geo) this.geometries.set(key, (geo = buildFurnitureGeometry(furnitureDef(kind), variant, open)));
    return geo;
  }

  /** The instanced mesh for a look, grown (by doubling) to hold `needed`. */
  private mesh(kind: string, variant: number, open: boolean, needed: number): THREE.InstancedMesh {
    const key = FurnitureView.lookKey(kind, variant, open);
    let mesh = this.meshes.get(key);
    if (mesh && mesh.instanceMatrix.count >= needed) return mesh;
    const capacity = Math.max(8, 2 ** Math.ceil(Math.log2(Math.max(1, needed))));
    if (mesh) {
      this.scene.remove(mesh);
      mesh.dispose(); // instance buffers only; the geometry is shared and cached
    }
    mesh = new THREE.InstancedMesh(this.geometry(kind, variant, open), this.material, capacity);
    mesh.count = 0;
    castsInstancedShadow(mesh);
    mesh.receiveShadow = true;
    // instances are spread over the whole field; one bounding sphere for all
    // of them would cull the lot whenever its centre left the view
    mesh.frustumCulled = false;
    mesh.layers.enable(INK_INSTANCED_LAYER);
    this.scene.add(mesh);
    this.meshes.set(key, mesh);
    return mesh;
  }

  private placeMatrix(p: Pick<PlacedFurniture, "kind" | "rot">, gx: number, gy: number, gz: number): THREE.Matrix4 {
    const [cx, cz] = footprintCenter(furnitureDef(p.kind), p.rot);
    this.pos.set(gx + cx, gy, gz + cz);
    this.quat.setFromAxisAngle(this.up, (p.rot * Math.PI) / 2);
    return this.matrix.compose(this.pos, this.quat, this.one);
  }

  /**
   * Bring the instances in line with the layout. Cheap to call every frame:
   * it only rewrites matrices when something was placed/removed or the
   * field's window scrolled (`originX/Z` = absolute coords of grid cell 0,0).
   */
  sync(layout: FurnitureLayout, originX = 0, originZ = 0): void {
    if (layout.version === this.drawnVersion && originX === this.drawnOriginX && originZ === this.drawnOriginZ) return;
    this.drawnVersion = layout.version;
    this.drawnOriginX = originX;
    this.drawnOriginZ = originZ;
    const byLook = new Map<string, PlacedFurniture[]>();
    for (const item of layout.all()) {
      const key = FurnitureView.lookKey(item.kind, item.variant, item.state === 1);
      let list = byLook.get(key);
      if (!list) byLook.set(key, (list = []));
      list.push(item);
    }
    for (const [key, mesh] of this.meshes) {
      if (!byLook.has(key)) mesh.count = 0;
    }
    for (const items of byLook.values()) {
      const first = items[0]!;
      const mesh = this.mesh(first.kind, first.variant, first.state === 1, items.length);
      items.forEach((p, i) => mesh.setMatrixAt(i, this.placeMatrix(p, p.x - originX, p.y + layout.elevation(p), p.z - originZ)));
      mesh.count = items.length;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** The translucent preview of a piece about to be placed (grid coords). */
  showGhost(p: Pick<PlacedFurniture, "kind" | "rot" | "variant">, gx: number, gy: number, gz: number, material: THREE.Material): void {
    this.ghost.geometry = this.geometry(p.kind, p.variant, false);
    this.ghost.material = material;
    this.placeMatrix(p, gx, gy, gz).decompose(this.ghost.position, this.ghost.quaternion, this.ghost.scale);
    this.ghost.visible = true;
  }

  hideGhost(): void {
    this.ghost.visible = false;
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.scene.remove(this.ghost);
    for (const geo of this.geometries.values()) geo.dispose();
    this.material.dispose();
  }
}
