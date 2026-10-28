import * as THREE from "three";
import { settings } from "../../ui/settings.js";

/**
 * Test-drive feedback: dust under the wheels and a continuous engine/thruster
 * voice. Both are decoration — nothing here feeds back into the simulation —
 * but without them a machine that is clearly moving still reads as a diagram.
 */

const MAX_PUFFS = 96;

export class DustField {
  readonly points: THREE.Points;
  private readonly position: Float32Array;
  private readonly color: Float32Array;
  private readonly velocity = new Float32Array(MAX_PUFFS * 3);
  private readonly life = new Float32Array(MAX_PUFFS);
  private readonly texture: THREE.Texture;
  private next = 0;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    this.position = new Float32Array(MAX_PUFFS * 3);
    this.color = new Float32Array(MAX_PUFFS * 4);
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.position, 3),
    );
    geometry.setAttribute("color", new THREE.BufferAttribute(this.color, 4));
    this.texture = puffTexture();
    this.points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 1.1,
        map: this.texture,
        transparent: true,
        depthWrite: false,
        vertexColors: true,
        sizeAttenuation: true,
      }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  /** Spawn one puff; `strength` 0‒1 scales how long and far it drifts. */
  spawn(x: number, y: number, z: number, strength: number): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX_PUFFS;
    this.position.set([x, y, z], i * 3);
    this.velocity.set(
      [
        (Math.random() - 0.5) * 1.6,
        0.5 + Math.random() * 1.1,
        (Math.random() - 0.5) * 1.6,
      ],
      i * 3,
    );
    this.life[i] = 0.35 + strength * 0.65;
  }

  update(dt: number): void {
    let alive = false;
    for (let i = 0; i < MAX_PUFFS; i++) {
      if (this.life[i]! <= 0) {
        this.color[i * 4 + 3] = 0;
        continue;
      }
      alive = true;
      this.life[i]! -= dt;
      const fade = Math.max(0, this.life[i]!);
      for (let axis = 0; axis < 3; axis++) {
        this.position[i * 3 + axis]! += this.velocity[i * 3 + axis]! * dt;
        this.velocity[i * 3 + axis]! *= 1 - dt * 1.8;
      }
      this.color.set([0.86, 0.82, 0.7, Math.min(0.55, fade * 0.75)], i * 4);
    }
    const geometry = this.points.geometry;
    geometry.attributes.position!.needsUpdate = true;
    geometry.attributes.color!.needsUpdate = true;
    this.points.visible = alive;
  }

  clear(): void {
    this.life.fill(0);
    this.color.fill(0);
    this.points.geometry.attributes.color!.needsUpdate = true;
    this.points.visible = false;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.texture.dispose();
  }
}

function puffTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.55, "rgba(255,255,255,0.55)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Engine voice. One sawtooth for the drive motor, one noise bed for thrusters,
 * both continuously re-tuned instead of retriggered, so there is no click.
 * Every call is a no-op when the browser denies audio.
 */
export class MachineAudio {
  private ctx: AudioContext | null = null;
  private engine: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private thrustSource: AudioBufferSourceNode | null = null;
  private thrustGain: GainNode | null = null;
  private failed = false;

  private ensure(): boolean {
    if (this.ctx) return true;
    if (this.failed) return false;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) throw new Error("no AudioContext");
      this.ctx = new Ctor();
    } catch {
      this.failed = true;
      return false;
    }
    return true;
  }

  start(): void {
    if (!this.ensure() || this.engine) return;
    const ctx = this.ctx!;
    void ctx.resume();
    this.engine = ctx.createOscillator();
    this.engine.type = "sawtooth";
    this.engine.frequency.value = 60;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 420;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engine
      .connect(this.engineFilter)
      .connect(this.engineGain)
      .connect(ctx.destination);
    this.engine.start();

    const frames = Math.floor(ctx.sampleRate * 0.5);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
    this.thrustSource = ctx.createBufferSource();
    this.thrustSource.buffer = buffer;
    this.thrustSource.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 700;
    band.Q.value = 0.8;
    this.thrustGain = ctx.createGain();
    this.thrustGain.gain.value = 0;
    this.thrustSource
      .connect(band)
      .connect(this.thrustGain)
      .connect(ctx.destination);
    this.thrustSource.start();
  }

  /** `load` 0‒1 drive effort, `speed` m/s, `thrust` 0‒1 rocket activation. */
  update(load: number, speed: number, thrust: number): void {
    if (!this.ctx || !this.engine) return;
    const now = this.ctx.currentTime;
    const target = (Math.min(1, Math.abs(load)) * 0.055 + (speed > 0.6 ? 0.012 : 0)) * settings.sfx;
    this.engine.frequency.setTargetAtTime(58 + speed * 7.5, now, 0.08);
    this.engineFilter?.frequency.setTargetAtTime(360 + speed * 48, now, 0.12);
    this.engineGain?.gain.setTargetAtTime(target, now, 0.09);
    this.thrustGain?.gain.setTargetAtTime(
      Math.min(1, thrust) * 0.045 * settings.sfx,
      now,
      0.06,
    );
  }

  /** One-shot thud; `force` 0‒1. */
  impact(force: number): void {
    if (!this.ctx || force <= 0.05 || settings.sfx === 0) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(150, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(48, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(Math.min(0.14, force * 0.14) * settings.sfx, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.26);
  }

  /** Short rising chime for a cleared mission. */
  fanfare(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    [523, 659, 880].forEach((hz, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      const at = ctx.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.09 * settings.sfx, 0.0001), at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.24);
    });
  }

  stop(): void {
    try {
      this.engine?.stop();
      this.thrustSource?.stop();
    } catch {
      /* already stopped */
    }
    this.engine = null;
    this.engineGain = null;
    this.engineFilter = null;
    this.thrustSource = null;
    this.thrustGain = null;
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
