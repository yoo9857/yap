import * as THREE from "three";

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  gravity: number;
  spin: number;
  active: boolean;
}

const POOL_SIZE = 160;

/**
 * Fixed-size pooled particle system — box debris & poofs, zero allocation
 * after construction. Update runs on render frames (visual-only).
 */
export class Effects {
  private readonly pool: Particle[] = [];
  private readonly materials = new Map<number, THREE.MeshLambertMaterial>();

  constructor(private readonly scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(geo, this.material(0xffffff));
      mesh.visible = false;
      scene.add(mesh);
      this.pool.push({
        mesh,
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        gravity: 25,
        spin: 0,
        active: false,
      });
    }
  }

  private material(color: number): THREE.MeshLambertMaterial {
    let m = this.materials.get(color);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color, transparent: true });
      this.materials.set(color, m);
    }
    return m;
  }

  private spawn(
    pos: THREE.Vector3,
    color: number,
    count: number,
    speed: number,
    up: number,
    size: number,
    life: number,
    gravity = 25,
  ): void {
    for (let i = 0; i < count; i++) {
      const p = this.pool.find((q) => !q.active);
      if (!p) return; // pool exhausted — drop, never allocate
      p.active = true;
      p.mesh.visible = true;
      p.mesh.material = this.material(color);
      p.mesh.position.copy(pos);
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * speed;
      p.vel.set(Math.cos(angle) * r, up * (0.5 + Math.random() * 0.8), Math.sin(angle) * r);
      const s = size * (0.5 + Math.random());
      p.mesh.scale.set(s, s, s);
      p.life = 0;
      p.maxLife = life * (0.7 + Math.random() * 0.6);
      p.gravity = gravity;
      p.spin = (Math.random() - 0.5) * 10;
    }
  }

  jumpDust(pos: THREE.Vector3): void {
    this.spawn(pos, 0xffffff, 6, 2, 1.5, 0.12, 0.4, 6);
  }

  landPoof(pos: THREE.Vector3): void {
    this.spawn(pos, 0xffffff, 8, 2.5, 1, 0.14, 0.45, 5);
  }

  crumbleDebris(pos: THREE.Vector3, color: number): void {
    this.spawn(pos, color, 14, 2.5, 3, 0.3, 1.1, 25);
  }

  deathBurst(pos: THREE.Vector3): void {
    this.spawn(pos, 0xe2231a, 16, 4, 5, 0.22, 0.9, 25);
    this.spawn(pos, 0xf9d71c, 10, 3, 4, 0.18, 0.9, 25);
  }

  checkpointBurst(pos: THREE.Vector3): void {
    this.spawn(pos, 0x3ddc64, 14, 2, 4.5, 0.16, 0.8, 12);
  }

  goalConfetti(pos: THREE.Vector3): void {
    for (const c of [0xe2231a, 0xf9d71c, 0x4bb54a, 0x0f6cbd, 0xe5418f]) {
      this.spawn(pos, c, 8, 4, 7, 0.16, 1.6, 14);
    }
  }

  update(dt: number): void {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life += dt;
      if (p.life >= p.maxLife) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.spin * dt;
      p.mesh.rotation.z += p.spin * dt;
      (p.mesh.material as THREE.MeshLambertMaterial).opacity = 1 - p.life / p.maxLife;
    }
  }
}
