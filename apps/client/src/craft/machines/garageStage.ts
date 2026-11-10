import * as THREE from "three";
import { wheelRadius } from "./customization.js";
import { usesSkylarkModel, type Blueprint } from "./blueprint.js";
import { PHYSICS_RULES } from "./physicsRules.js";

export const GARAGE_LAYER = 10;

/** Visual-only studio. Test drives still use the actual world and terrain. */
export class GarageStage {
  readonly root = new THREE.Group();
  private readonly floor = new THREE.Mesh(
    new THREE.PlaneGeometry(500, 500),
    new THREE.MeshStandardMaterial({ color: 0x152942, roughness: .92 }),
  );
  private readonly podium = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1.025, .24, 80),
    new THREE.MeshStandardMaterial({ color: 0x294461, roughness: .75, metalness: .15 }),
  );
  private readonly rim = new THREE.Mesh(
    new THREE.TorusGeometry(1, .006, 4, 96),
    new THREE.MeshBasicMaterial({ color: 0x6da9d4 }),
  );
  private readonly backdrop = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.MeshBasicMaterial({ color: 0x142c49, side: THREE.BackSide }),
  );
  private readonly grid = new THREE.GridHelper(100, 50, 0x3d6586, 0x254763);

  constructor() {
    this.floor.rotation.x = this.rim.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = this.podium.receiveShadow = true;
    const hemisphere = new THREE.HemisphereLight(0xe3f4ff, 0x637b94, 1.4);
    const key = new THREE.DirectionalLight(0xe3f3ff, 2.4);
    key.position.set(-4, 8, 5);
    this.root.add(this.backdrop, this.floor, this.grid, this.podium, this.rim, hemisphere, key, key.target);
    this.root.traverse(object => object.layers.set(GARAGE_LAYER));
    this.root.visible = false;
  }

  fit(blueprint: Blueprint): void {
    const bottom = Math.min(...blueprint.parts.map(part => part.cell[1] -
      (part.kind === "wheel" ? PHYSICS_RULES.suspensionLength + wheelRadius(part) : .51)));
    const radius = Math.max(4.5, ...blueprint.parts.map(part => Math.hypot(part.cell[0], part.cell[2]) + 1.6));
    this.podium.scale.set(radius, 1, radius);
    this.podium.position.y = bottom - .14;
    this.rim.scale.setScalar(radius);
    this.rim.position.y = bottom - .012;
    this.floor.position.y = this.grid.position.y = bottom - .27;
    this.grid.position.y += .005;
    // The long rotor and tail require a wider camera fit than the block kit.
    this.backdrop.scale.setScalar(Math.max(usesSkylarkModel(blueprint) ? 44 : 12, radius * 1.8));
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const mesh of [this.floor, this.podium, this.rim, this.backdrop]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.grid.geometry.dispose();
    const gridMaterial = this.grid.material as THREE.Material | THREE.Material[];
    const materials = Array.isArray(gridMaterial) ? gridMaterial : [gridMaterial];
    materials.forEach(material => material.dispose());
  }
}
