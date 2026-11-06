import * as THREE from "three";
import { PLOT_INSET, plotCorners } from "@robo/shared";
import { t } from "../ui/i18n.js";

/** One student's plot spot (absolute field coordinates; `yaw` faces the teacher). */
export interface SeatSign {
  name: string;
  pos: [number, number, number];
  yaw: number;
}

const FENCE = { height: 0.75, rail: 0.08, thick: 0.08, postEvery: 5, post: 0.14 };
const SIGN = { w: 1.7, h: 0.66, d: 0.07, post: 1.25 };
/** Soft ground tints, one per plot in turn, so neighbouring plots read apart at a glance. */
const TINTS = [0xffe28a, 0xa8e6cf, 0xa0c4ff, 0xffb5a7, 0xcdb4db, 0xb9fbc0];

/**
 * The classroom plots drawn in the world (F2 → 자리 배치): every student's 15 × 20 plot fenced off
 * (neighbours share one fence), a soft ground tint per plot, and a name sign at the middle of its
 * front fence ("민지의 자리"), readable from the teacher's side and from inside the plot. Look only:
 * nothing here is solid.
 *
 * Built relative to the first plot's spot; the group is placed each frame from that ABSOLUTE spot,
 * so the field window scrolling under the player never moves a fence. Fence boards, posts and sign
 * posts are one InstancedMesh each; a sign is a small box whose front and back faces carry the name.
 */
export class SeatingView {
  private readonly group = new THREE.Group();
  private anchor: [number, number, number] | null = null;
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly plane = new THREE.PlaneGeometry(1, 1);
  private readonly signGeo = new THREE.BoxGeometry(SIGN.w, SIGN.h, SIGN.d);
  private readonly wood = new THREE.MeshStandardMaterial({ color: 0xe8d3ad, roughness: 0.85 });
  private readonly rail = new THREE.MeshStandardMaterial({ color: 0x8fb8e6, roughness: 0.7 });
  private owned: { dispose(): void }[] = [];
  private plots = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.group.name = "class-plots";
    this.group.visible = false;
    // joins the scene only while plots stand (set), and leaves it again when they go (clear)
  }

  /** Plots drawn right now (0 when there are none). */
  get count(): number {
    return this.group.visible ? this.plots : 0;
  }

  /** Replace the plots (an empty list takes them away). */
  set(seats: readonly SeatSign[]): void {
    this.clear();
    if (seats.length === 0) return;
    this.plots = seats.length;
    const a = seats[0]!.pos;
    this.anchor = [a[0], a[1], a[2]];
    const [ox, oy, oz] = this.anchor;
    const q = new THREE.Quaternion();
    const up = THREE.Object3D.DEFAULT_UP;
    const m4 = (x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number) =>
      new THREE.Matrix4().compose(new THREE.Vector3(x - ox, y - oy, z - oz), q.setFromAxisAngle(up, yaw), new THREE.Vector3(sx, sy, sz));

    // fences: each plot edge once (neighbours share theirs), as boards between posts
    const boards: THREE.Matrix4[] = [];
    const rails: THREE.Matrix4[] = [];
    const posts: THREE.Matrix4[] = [];
    const edges = new Set<string>();
    const postAt = new Set<string>();
    const k = (x: number, z: number) => `${Math.round(x * 2)},${Math.round(z * 2)}`;
    const post = (x: number, z: number, y: number) => {
      if (postAt.has(k(x, z))) return;
      postAt.add(k(x, z));
      posts.push(m4(x, y + (FENCE.height + 0.12) / 2, z, 0, FENCE.post, FENCE.height + 0.12, FENCE.post));
    };
    for (const seat of seats) {
      const y = seat.pos[1];
      const c = plotCorners(seat);
      for (let i = 0; i < 4; i++) {
        const [x1, z1] = c[i]!;
        const [x2, z2] = c[(i + 1) % 4]!;
        const key = [k(x1, z1), k(x2, z2)].sort().join("|");
        if (edges.has(key)) continue;
        edges.add(key);
        const len = Math.hypot(x2 - x1, z2 - z1);
        const yaw = Math.atan2(x2 - x1, z2 - z1); // boards run along local z
        boards.push(m4((x1 + x2) / 2, y + FENCE.height * 0.45, (z1 + z2) / 2, yaw, FENCE.thick, FENCE.height * 0.7, len));
        rails.push(m4((x1 + x2) / 2, y + FENCE.height, (z1 + z2) / 2, yaw, FENCE.thick + 0.05, FENCE.rail, len + 0.05));
        const n = Math.round(len / FENCE.postEvery);
        for (let j = 0; j <= n; j++) post(x1 + ((x2 - x1) * j) / n, z1 + ((z2 - z1) * j) / n, y);
      }
    }

    // a soft tint on each plot's ground, so the plots read apart
    seats.forEach((seat, i) => {
      const c = plotCorners(seat);
      const cx = (c[0]![0] + c[2]![0]) / 2;
      const cz = (c[0]![1] + c[2]![1]) / 2;
      const w = Math.abs(c[2]![0] - c[0]![0]);
      const d = Math.abs(c[2]![1] - c[0]![1]);
      const mat = new THREE.MeshBasicMaterial({ color: TINTS[i % TINTS.length], transparent: true, opacity: 0.34, depthWrite: false });
      this.owned.push(mat);
      const tint = new THREE.Mesh(this.plane, mat);
      tint.rotation.x = -Math.PI / 2;
      tint.scale.set(w - 0.2, d - 0.2, 1);
      tint.position.set(cx - ox, seat.pos[1] - oy + 0.07, cz - oz); // above the floor's studs
      // first among the see-through things (renderOrder beats distance sorting): drawn after a
      // faded robot, a ground-sized plane sorted by its far-away centre could paint over it
      tint.renderOrder = -1;
      this.group.add(tint);
    });

    // name signs: at the middle of each plot's front fence, facing the teacher (both faces read)
    const signPosts: THREE.Matrix4[] = [];
    for (const seat of seats) {
      const [x, y, z] = seat.pos;
      const fx = Math.sin(seat.yaw);
      const fz = Math.cos(seat.yaw);
      const sx = x + fx * (PLOT_INSET - 0.35);
      const sz = z + fz * (PLOT_INSET - 0.35);
      signPosts.push(m4(sx, y + SIGN.post / 2, sz, seat.yaw, 0.09, SIGN.post, 0.09));
      const face = this.nameMaterial(seat.name);
      const sign = new THREE.Mesh(this.signGeo, [this.wood, this.wood, this.wood, this.wood, face, face]);
      sign.position.set(sx - ox, y - oy + SIGN.post + SIGN.h / 2 - 0.08, sz - oz);
      sign.rotation.y = seat.yaw;
      this.group.add(sign);
    }

    const instanced = (mat: THREE.Material, list: THREE.Matrix4[]) => {
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(this.box, mat, list.length);
      list.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    };
    instanced(this.wood, boards);
    instanced(this.rail, rails);
    instanced(this.rail, posts);
    instanced(this.rail, signPosts);
    this.group.visible = true;
    if (!this.group.parent) this.scene.add(this.group);
  }

  /** Place the plots under the current field window (absolute → grid). */
  update(toGrid: (ax: number, az: number) => [number, number]): void {
    if (!this.anchor || !this.group.visible) return;
    const [x, z] = toGrid(this.anchor[0], this.anchor[2]);
    this.group.position.set(x, this.anchor[1], z);
  }

  private nameMaterial(name: string): THREE.MeshStandardMaterial {
    const canvas = document.createElement("canvas");
    canvas.width = 420;
    canvas.height = 164;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fffaf0";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f2c94c";
    ctx.fillRect(0, 0, canvas.width, 16);
    ctx.fillStyle = "#2b2f3a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let size = 76;
    do {
      ctx.font = `800 ${size}px system-ui, sans-serif`;
      size -= 4;
    } while (ctx.measureText(name).width > canvas.width - 40 && size > 24);
    ctx.fillText(name, canvas.width / 2, 68, canvas.width - 24);
    ctx.fillStyle = "#6f7a8c";
    ctx.font = "800 40px system-ui, sans-serif";
    ctx.fillText(t("의 자리", "'s plot"), canvas.width / 2, 130);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    // a little self-light from its own picture: a sign must read even on the shaded side
    const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8, emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: 0.45 });
    this.owned.push(texture, mat);
    return mat;
  }

  private clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child instanceof THREE.InstancedMesh) child.dispose();
    }
    for (const o of this.owned) o.dispose();
    this.owned = [];
    this.anchor = null;
    this.plots = 0;
    this.group.visible = false;
    this.scene.remove(this.group);
  }

  dispose(): void {
    this.clear();
    this.box.dispose();
    this.plane.dispose();
    this.signGeo.dispose();
    this.wood.dispose();
    this.rail.dispose();
    this.scene.remove(this.group);
  }
}
