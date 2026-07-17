import * as THREE from "three";

interface Flight {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  ctrl: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  duration: number;
  fromSize: number;
  toSize: number;
  active: boolean;
}

// ≤ MAX_VISUAL_WORKERS flights launch per cycle and each lives ~1.5 s, so a
// small pool covers even fully-upgraded crews; when exhausted we drop (the
// pour itself never depends on a flight landing).
const POOL_SIZE = 24;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/**
 * The visual link between a worker's delivery and the monument: the carried
 * block is TOSSED from the worker's hands to the blueprint frontier along a
 * lobbed arc, growing to voxel scale (one delivery = a whole bundle) and
 * calling back on impact so dust appears where the block actually lands.
 */
export class BlockFlights {
  private readonly pool: Flight[] = [];
  private readonly geo = new THREE.BoxGeometry(1, 1, 1);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly onLand: (pos: THREE.Vector3) => void,
  ) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(
        this.geo,
        new THREE.MeshLambertMaterial({ color: 0xffffff }),
      );
      mesh.visible = false;
      mesh.castShadow = true;
      scene.add(mesh);
      this.pool.push({
        mesh,
        from: new THREE.Vector3(),
        ctrl: new THREE.Vector3(),
        to: new THREE.Vector3(),
        t: 0,
        duration: 1,
        fromSize: 0.4,
        toSize: 1,
        active: false,
      });
    }
  }

  launch(from: THREE.Vector3, to: THREE.Vector3, color: string, toSize: number): void {
    const f = this.pool.find((q) => !q.active);
    if (!f) return; // pool exhausted — drop, never allocate
    f.active = true;
    f.from.copy(from);
    f.to.copy(to);
    // lob: control point above the higher endpoint, hump grows with distance
    const dist = from.distanceTo(to);
    f.ctrl
      .addVectors(from, to)
      .multiplyScalar(0.5)
      .setY(Math.max(from.y, to.y) + Math.max(2.5, dist * 0.12));
    f.t = 0;
    f.duration = 0.55 + Math.min(0.95, dist * 0.004);
    f.fromSize = 0.42;
    f.toSize = toSize;
    f.mesh.visible = true;
    f.mesh.position.copy(from);
    f.mesh.scale.setScalar(f.fromSize);
    f.mesh.rotation.set(0, 0, 0);
    (f.mesh.material as THREE.MeshLambertMaterial).color.set(color);
  }

  /** Blocks currently mid-air (debug/E2E). */
  activeCount(): number {
    let n = 0;
    for (const f of this.pool) if (f.active) n++;
    return n;
  }

  /** Abort all flights (the monument they target is leaving the scene). */
  clear(): void {
    for (const f of this.pool) {
      f.active = false;
      f.mesh.visible = false;
    }
  }

  update(dt: number): void {
    for (const f of this.pool) {
      if (!f.active) continue;
      f.t += dt / f.duration;
      if (f.t >= 1) {
        f.active = false;
        f.mesh.visible = false;
        this.onLand(f.to);
        continue;
      }
      // quadratic bezier through the lob control point
      const t = f.t;
      const u = 1 - t;
      _a.copy(f.from).multiplyScalar(u * u);
      _b.copy(f.ctrl).multiplyScalar(2 * u * t);
      _a.add(_b);
      _b.copy(f.to).multiplyScalar(t * t);
      f.mesh.position.copy(_a.add(_b));
      f.mesh.scale.setScalar(f.fromSize + (f.toSize - f.fromSize) * t);
      f.mesh.rotation.x += dt * 6;
      f.mesh.rotation.y += dt * 4;
    }
  }

  dispose(): void {
    for (const f of this.pool) {
      this.scene.remove(f.mesh);
      (f.mesh.material as THREE.Material).dispose();
    }
    this.geo.dispose();
    this.pool.length = 0;
  }
}
