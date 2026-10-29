import * as THREE from "three";

interface Bit {
  mesh: THREE.Mesh;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  spin: number;
}

const COLORS = [0xfff6e4, 0xff7d72, 0xffe14a];

/**
 * A short spray of crayon chips where a tap lands. One geometry, three
 * materials, no per-frame material edits — the chip shrinks as it fades.
 */
export class BonkFx {
  private readonly root = new THREE.Group();
  private readonly pool: Bit[] = [];
  private cursor = 0;
  private disposed = false;

  constructor(scene: THREE.Scene) {
    this.root.name = "CraftYap bonk";
    scene.add(this.root);
    const geometry = new THREE.OctahedronGeometry(0.09, 0);
    const materials = COLORS.map((color) => new THREE.MeshBasicMaterial({ color, fog: true }));
    for (let i = 0; i < 28; i++) {
      const mesh = new THREE.Mesh(geometry, materials[i % materials.length]);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.root.add(mesh);
      this.pool.push({ mesh, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, spin: 0 });
    }
  }

  /** `dirX/dirZ` is the shove, so the chips fly with the tap. Grid metres. */
  burst(x: number, y: number, z: number, dirX: number, dirZ: number): void {
    if (this.disposed) return;
    const len = Math.hypot(dirX, dirZ) || 1;
    const fx = dirX / len;
    const fz = dirZ / len;
    const sideX = -fz;
    const sideZ = fx;
    for (let i = 0; i < 7; i++) {
      const bit = this.pool[this.cursor++ % this.pool.length]!;
      const side = (i - 3) * 0.55;
      bit.x = x;
      bit.y = y;
      bit.z = z;
      bit.vx = fx * 2.4 + sideX * side;
      bit.vy = 1.4 + (i % 3) * 0.55;
      bit.vz = fz * 2.4 + sideZ * side;
      bit.life = bit.max = 0.34;
      bit.spin = (i - 3) * 6;
      bit.mesh.visible = true;
      bit.mesh.scale.setScalar(0.65 + (i % 2) * 0.35);
      bit.mesh.position.set(x, y, z);
    }
  }

  update(dt: number): void {
    if (this.disposed || dt <= 0) return;
    const step = Math.min(dt, 0.05);
    for (const bit of this.pool) {
      if (bit.life <= 0) continue;
      bit.life -= step;
      if (bit.life <= 0) {
        bit.mesh.visible = false;
        continue;
      }
      bit.vy -= 8 * step;
      bit.x += bit.vx * step;
      bit.y += bit.vy * step;
      bit.z += bit.vz * step;
      const k = bit.life / bit.max;
      bit.mesh.position.set(bit.x, bit.y, bit.z);
      bit.mesh.scale.setScalar((0.65 + (bit.spin > 0 ? 0.2 : 0)) * k);
      bit.mesh.rotation.x += bit.spin * step;
      bit.mesh.rotation.y += bit.spin * 0.6 * step;
    }
  }

  /** The field window scrolled; grid-space chips move with it. */
  shift(dx: number, dz: number): void {
    for (const bit of this.pool) {
      bit.x -= dx;
      bit.z -= dz;
      if (bit.life > 0) bit.mesh.position.set(bit.x, bit.y, bit.z);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const geometry = this.pool[0]?.mesh.geometry;
    const materials = new Set(this.pool.map((bit) => bit.mesh.material));
    this.root.removeFromParent();
    geometry?.dispose();
    for (const material of materials) (material as THREE.Material).dispose();
    this.pool.length = 0;
  }
}
