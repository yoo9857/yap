import * as THREE from "three";
import { lerpAngle, vec3Lerp, type AnimState, type SnapshotPlayer, type Vec3 } from "@robo/shared";
import { CharacterRig, disposeRig } from "./rig.js";

interface Sample {
  tMs: number;
  pos: Vec3;
  yaw: number;
  anim: AnimState;
}

const BUFFER_LIMIT = 30;
const MAX_EXTRAPOLATE_MS = 250;
/** ~2.5 snapshot intervals at 15 Hz + jitter margin. */
export const INTERP_DELAY_MS = 170;

const REMOTE_TORSO_COLORS = [0xd0342c, 0x2a7d46, 0x7b4fd0, 0xb8551b, 0x00747c, 0xa8326e];

/**
 * A ghost of another player: consumes server snapshots into a ring buffer and
 * renders `INTERP_DELAY_MS` in the past, lerping between the two bracketing
 * samples. Runs entirely on the render clock — no physics involvement.
 */
export class RemotePlayer {
  readonly rig: CharacterRig;
  private readonly nameSprite: THREE.Sprite;
  private readonly buffer: Sample[] = [];
  private anim: AnimState = "idle";
  private lastSpeed = 0;
  private lastPos: Vec3 = [0, 0, 0];

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly scene: THREE.Scene,
  ) {
    const colorSeed = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
    this.rig = new CharacterRig(
      REMOTE_TORSO_COLORS[colorSeed % REMOTE_TORSO_COLORS.length],
    );
    this.rig.root.visible = false;
    scene.add(this.rig.root);

    this.nameSprite = makeNameSprite(name);
    this.nameSprite.position.set(0, 2.05, 0);
    this.rig.root.add(this.nameSprite);
  }

  push(snapshot: SnapshotPlayer, serverTimeMs: number): void {
    const last = this.buffer[this.buffer.length - 1];
    if (last && serverTimeMs <= last.tMs) return; // stale/duplicate
    this.buffer.push({ tMs: serverTimeMs, pos: snapshot.pos, yaw: snapshot.yaw, anim: snapshot.anim });
    if (this.buffer.length > BUFFER_LIMIT) this.buffer.shift();
  }

  /** `estServerNowMs` comes from ServerClock; render dt for pose animation. */
  update(estServerNowMs: number | null, frameDt: number): void {
    if (estServerNowMs === null || this.buffer.length === 0) return;
    const renderT = estServerNowMs - INTERP_DELAY_MS;

    let a: Sample | null = null;
    let b: Sample | null = null;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const s = this.buffer[i]!;
      if (s.tMs <= renderT) {
        a = s;
        b = this.buffer[i + 1] ?? null;
        break;
      }
    }

    let pos: Vec3;
    let yaw: number;
    let dimmed = false;
    if (a && b) {
      const t = (renderT - a.tMs) / (b.tMs - a.tMs);
      pos = vec3Lerp(a.pos, b.pos, t);
      yaw = lerpAngle(a.yaw, b.yaw, t);
      this.anim = b.anim;
    } else if (a) {
      // buffer dry: freeze (never extrapolate a platformer ghost far)
      dimmed = renderT - a.tMs > MAX_EXTRAPOLATE_MS;
      pos = a.pos;
      yaw = a.yaw;
      this.anim = a.anim;
    } else {
      // everything is newer than our render time — snap to oldest
      const first = this.buffer[0]!;
      pos = first.pos;
      yaw = first.yaw;
      this.anim = first.anim;
    }

    this.lastSpeed =
      frameDt > 0
        ? Math.hypot(pos[0] - this.lastPos[0], pos[2] - this.lastPos[2]) / frameDt
        : this.lastSpeed;
    this.lastPos = pos;

    this.rig.root.visible = true;
    this.rig.root.position.set(pos[0], pos[1], pos[2]);
    this.rig.root.rotation.y = yaw;
    this.rig.update(this.anim, this.lastSpeed, frameDt);
    this.nameSprite.material.opacity = dimmed ? 0.4 : 1;
  }

  setVisible(v: boolean): void {
    this.rig.root.visible = v && this.buffer.length > 0;
  }

  dispose(): void {
    this.scene.remove(this.rig.root);
    disposeRig(this.rig.root); // includes the name sprite + textures
  }
}

function makeNameSprite(name: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.font = "700 30px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(15,35,55,0.55)";
    const w = Math.min(ctx.measureText(name).width + 28, 250);
    roundRect(ctx, 128 - w / 2, 8, w, 48, 12);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(name, 128, 34);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }),
  );
  sprite.scale.set(1.6, 0.4, 1);
  return sprite;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
