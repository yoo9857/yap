/**
 * What a running plant looks like besides its turning rotor: a cable from the wire terminal down
 * to the ground, and sparks of light travelling the energy's path — from the generator down the
 * tower, out of the terminal and along the cable. Plus a beacon (a tall soft light) that marks a
 * plant picked on the status board, so it can be found on an endless field.
 *
 * Everything is in a site's LOCAL frame at rotation 0 (+z front), placed by the caller each time
 * the site or the field window moves. Shared geometry/materials; one Points cloud per site.
 */
import * as THREE from "three";

/** The energy's way out, local to the site at rotation 0 (cell centres + the cable). */
const PATH: ReadonlyArray<[number, number, number]> = [
  [0.5, 7.5, 0.5], // generator
  [0.5, 1.6, 0.5], // down the tower
  [1.5, 1.35, 0.5], // into the wire terminal
  [2.15, 1.0, 0.5], // over the foundation's edge
  [2.6, 0.12, 0.5], // down to the grass
  [5.5, 0.08, 0.5], // along the ground, off toward the village
];
/** The cable is the path from the terminal on. */
const CABLE_FROM = 2;
const SPARKS = 14;
const SPARK_SPEED = 3.2; // m/s along the path

function sparkTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,240,150,0.95)");
  grad.addColorStop(0.6, "rgba(255,200,60,0.35)");
  grad.addColorStop(1, "rgba(255,200,60,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Rig {
  root: THREE.Group;
  cable: THREE.Mesh;
  sparks: THREE.Points;
  phase: number;
}

export class PlantEffects {
  private readonly rigs = new Map<number, Rig>();
  private readonly tex = sparkTexture();
  private readonly sparkMat = new THREE.PointsMaterial({
    map: this.tex,
    size: 0.55,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  private readonly cableMat = new THREE.MeshStandardMaterial({ color: 0x2f3440, roughness: 0.7 });
  private readonly cableGeo: THREE.TubeGeometry;
  private readonly lengths: number[] = [];
  private readonly total: number;
  private readonly beacon: THREE.Mesh;
  private beaconUntil = 0;
  private beaconId = -1;

  constructor(private readonly scene: THREE.Scene) {
    const pts = PATH.slice(CABLE_FROM).map(([x, y, z]) => new THREE.Vector3(x, y, z));
    this.cableGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.2), 40, 0.06, 8, false);
    let sum = 0;
    for (let i = 1; i < PATH.length; i++) {
      const [ax, ay, az] = PATH[i - 1]!;
      const [bx, by, bz] = PATH[i]!;
      sum += Math.hypot(bx - ax, by - ay, bz - az);
      this.lengths.push(sum);
    }
    this.total = sum;
    // a soft vertical shaft of light, open at both ends, fading upward
    const geo = new THREE.CylinderGeometry(0.9, 0.9, 60, 24, 1, true);
    geo.translate(0, 30, 0);
    const colors: number[] = [];
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const k = 1 - pos.getY(i) / 60;
      colors.push(k, k, k);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    this.beacon = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0xffd34a, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }),
    );
    this.beacon.visible = false;
    this.beacon.frustumCulled = false;
    this.beacon.raycast = () => {};
    scene.add(this.beacon);
  }

  /** Boot warm-up: a spark cloud and the beacon drawn once, far below the world. */
  setWarm(on: boolean): void {
    const id = -999;
    if (on) {
      this.sync(id, true, true);
      this.place(id, 0, -1000, 0, 0);
      this.beacon.position.set(0, -1000, 0);
      this.beacon.visible = true;
      (this.beacon.material as THREE.MeshBasicMaterial).opacity = 0.01;
    } else {
      this.drop(id);
      if (this.beaconId !== id && this.beaconUntil === 0) this.beacon.visible = false;
    }
  }

  /** Make a site's rig match its state: the cable once the terminal is in, sparks while running. */
  sync(id: number, hasTerminal: boolean, running: boolean): void {
    let rig = this.rigs.get(id);
    if (!hasTerminal) {
      if (rig) this.drop(id);
      return;
    }
    if (!rig) {
      const root = new THREE.Group();
      const cable = new THREE.Mesh(this.cableGeo, this.cableMat);
      cable.castShadow = true;
      cable.raycast = () => {};
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(SPARKS * 3), 3));
      const sparks = new THREE.Points(geo, this.sparkMat);
      sparks.frustumCulled = false;
      sparks.raycast = () => {};
      root.add(cable, sparks);
      this.scene.add(root);
      rig = { root, cable, sparks, phase: Math.random() };
      this.rigs.set(id, rig);
    }
    rig.sparks.visible = running;
  }

  /** Place a site's rig: its anchor's GRID corner (x - 0.5 … the foundation centre cell) and turn. */
  place(id: number, gx: number, gy: number, gz: number, rot: number): void {
    const rig = this.rigs.get(id);
    if (!rig) return;
    // local (0.5, *, 0.5) is the anchor cell's centre: rotate about it
    rig.root.position.set(gx + 0.5, gy, gz + 0.5);
    rig.root.rotation.y = (-rot * Math.PI) / 2;
    rig.root.children.forEach((c) => c.position.set(-0.5, 0, -0.5));
  }

  drop(id: number): void {
    const rig = this.rigs.get(id);
    if (!rig) return;
    this.scene.remove(rig.root);
    rig.sparks.geometry.dispose();
    this.rigs.delete(id);
    if (this.beaconId === id) this.beaconUntil = 0;
  }

  /** Light a beacon over a site (GRID position of its anchor centre) for a few seconds. */
  showBeacon(id: number, gx: number, gy: number, gz: number, seconds = 10): void {
    this.beaconId = id;
    this.beaconUntil = performance.now() / 1000 + seconds;
    this.beacon.position.set(gx + 0.5, gy, gz + 0.5);
    this.beacon.visible = true;
  }

  moveBeacon(id: number, gx: number, gy: number, gz: number): void {
    if (id === this.beaconId) this.beacon.position.set(gx + 0.5, gy, gz + 0.5);
  }

  /** The beacon's world position while lit (for the screen-edge arrow), else null. */
  beaconTarget(): { id: number; pos: THREE.Vector3 } | null {
    return this.beacon.visible ? { id: this.beaconId, pos: this.beacon.position } : null;
  }

  update(dt: number, now: number): void {
    for (const rig of this.rigs.values()) {
      if (!rig.sparks.visible) continue;
      rig.phase = (rig.phase + (dt * SPARK_SPEED) / this.total) % 1;
      const attr = rig.sparks.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < SPARKS; i++) {
        const d = (((rig.phase + i / SPARKS) % 1) * this.total);
        let seg = 0;
        while (seg < this.lengths.length - 1 && this.lengths[seg]! < d) seg++;
        const start = seg === 0 ? 0 : this.lengths[seg - 1]!;
        const k = (d - start) / (this.lengths[seg]! - start);
        const [ax, ay, az] = PATH[seg]!;
        const [bx, by, bz] = PATH[seg + 1]!;
        attr.setXYZ(i, ax + (bx - ax) * k, ay + (by - ay) * k + 0.08, az + (bz - az) * k);
      }
      attr.needsUpdate = true;
    }
    if (this.beacon.visible) {
      const left = this.beaconUntil - now;
      const mat = this.beacon.material as THREE.MeshBasicMaterial;
      if (left <= 0) {
        this.beacon.visible = false;
        mat.opacity = 0;
      } else {
        // fade in, breathe, fade out
        mat.opacity = Math.min(1, left / 1.5, (10 - left) / 0.4 + 0.2) * (0.42 + 0.12 * Math.sin(now * 5));
      }
    }
  }

  dispose(): void {
    for (const id of [...this.rigs.keys()]) this.drop(id);
    this.scene.remove(this.beacon);
    this.beacon.geometry.dispose();
    (this.beacon.material as THREE.Material).dispose();
    this.cableGeo.dispose();
    this.cableMat.dispose();
    this.sparkMat.dispose();
    this.tex.dispose();
  }
}
