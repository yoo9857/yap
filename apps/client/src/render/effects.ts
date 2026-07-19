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

/** A flat, ground-hugging crayon ring that scribbles outward and fades. */
interface Ring {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  from: number;
  to: number;
  active: boolean;
}

const POOL_SIZE = 160;
const RING_POOL_SIZE = 16;

// crayon speck palette — chalky, warm, hand-drawn (not pure white)
const JUMP_SPECKS = [0xfff6e0, 0xffe9b8, 0xffffff] as const;
const LAND_SPECKS = [0xf3ede0, 0xe9dcc4, 0xd9c7a3] as const;

/**
 * A rough, hand-drawn ring on a transparent tile — a few wobbly chalk passes
 * so the poof reads as a doodle, not a clean vector circle. Built once.
 */
function makeDoodleRingTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const S = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const cx = S / 2;
  const cy = S / 2;
  const base = S * 0.36;
  ctx.strokeStyle = "#ffffff";
  ctx.lineCap = "round";
  // three overlapping passes, each a slightly wobbled circle → crayon texture
  for (let pass = 0; pass < 3; pass++) {
    ctx.lineWidth = 5 - pass;
    ctx.globalAlpha = 0.9 - pass * 0.22;
    ctx.beginPath();
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      // deterministic wobble (sin blend) — no per-frame RNG, stable texture
      const wob = 1 + 0.06 * Math.sin(a * 5 + pass * 2) + 0.04 * Math.sin(a * 9 - pass);
      const r = base * wob + pass * 1.5;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Fixed-size pooled particle system — box debris & poofs, zero allocation
 * after construction. Update runs on render frames (visual-only).
 */
export class Effects {
  private readonly pool: Particle[] = [];
  private readonly rings: Ring[] = [];
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

    const ringTex = makeDoodleRingTexture();
    const ringGeo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < RING_POOL_SIZE; i++) {
      const material = new THREE.MeshBasicMaterial({
        map: ringTex ?? undefined,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(ringGeo, material);
      mesh.rotation.x = -Math.PI / 2; // lie flat on the ground
      mesh.visible = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.rings.push({ mesh, material, life: 0, maxLife: 1, from: 1, to: 2, active: false });
    }
  }

  /** Spawn one expanding ground ring (feet position). */
  private spawnRing(pos: THREE.Vector3, color: number, from: number, to: number, life: number): void {
    const ring = this.rings.find((r) => !r.active);
    if (!ring) return;
    ring.active = true;
    ring.mesh.visible = true;
    ring.material.color.setHex(color);
    ring.mesh.position.set(pos.x, pos.y + 0.04, pos.z);
    ring.life = 0;
    ring.maxLife = life;
    ring.from = from;
    ring.to = to;
    ring.mesh.scale.setScalar(from);
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
    this.spawnRing(pos, 0xfff3d8, 0.5, 2.2, 0.34);
    for (const c of JUMP_SPECKS) this.spawn(pos, c, 2, 2, 1.6, 0.11, 0.4, 6);
  }

  /** `impact` (~0..1.5) scales the splat with fall speed. */
  landPoof(pos: THREE.Vector3, impact = 1): void {
    const k = Math.max(0.6, Math.min(1.6, impact));
    this.spawnRing(pos, 0xf1e6cf, 0.45, 1.9 + k * 0.9, 0.3 + k * 0.06);
    for (const c of LAND_SPECKS) {
      this.spawn(pos, c, Math.round(3 * k), 2.4 * k, 1.1, 0.12, 0.42, 5);
    }
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

    for (const r of this.rings) {
      if (!r.active) continue;
      r.life += dt;
      const t = r.life / r.maxLife;
      if (t >= 1) {
        r.active = false;
        r.mesh.visible = false;
        r.material.opacity = 0;
        continue;
      }
      // ease-out expansion; fade in fast then out
      const scale = r.from + (r.to - r.from) * (1 - (1 - t) * (1 - t));
      r.mesh.scale.setScalar(scale);
      r.material.opacity = (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85) * 0.85;
    }
  }
}
