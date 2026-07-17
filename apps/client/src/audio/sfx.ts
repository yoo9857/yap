/**
 * Tiny WebAudio synth blips — no assets to load, nothing to fail. The
 * AudioContext is created lazily and resumed on the first user gesture;
 * until then every play call is a silent no-op (browser autoplay policy).
 */
type SfxName = "jump" | "land" | "checkpoint" | "crumble" | "oof" | "clear" | "click";

export class Sfx {
  private ctx: AudioContext | null = null;
  private unlocked = false;

  constructor() {
    const unlock = () => {
      this.ensureContext();
      if (this.ctx && this.ctx.state === "suspended") {
        void this.ctx.resume();
      }
      this.unlocked = true;
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
  }

  private ensureContext(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
    } catch {
      this.ctx = null; // no audio support — game plays silently
    }
  }

  play(name: SfxName): void {
    if (!this.unlocked) return;
    this.ensureContext();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;

    switch (name) {
      case "jump":
        this.beep(ctx, 340, 0.12, "square", 0.05, 520);
        break;
      case "land":
        this.beep(ctx, 160, 0.08, "triangle", 0.06, 110);
        break;
      case "checkpoint":
        this.beep(ctx, 520, 0.1, "sine", 0.07, 780);
        this.beep(ctx, 780, 0.16, "sine", 0.06, 1040, 0.08);
        break;
      case "crumble":
        this.noise(ctx, 0.25, 0.05);
        break;
      case "oof":
        this.beep(ctx, 220, 0.25, "sawtooth", 0.08, 70);
        break;
      case "clear":
        [523, 659, 784, 1047].forEach((f, i) => this.beep(ctx, f, 0.18, "square", 0.05, f, i * 0.12));
        break;
      case "click":
        this.beep(ctx, 700, 0.04, "square", 0.04, 700);
        break;
    }
  }

  private beep(
    ctx: AudioContext,
    freq: number,
    dur: number,
    type: OscillatorType,
    vol: number,
    slideTo: number,
    delay = 0,
  ): void {
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(slideTo, 1), t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(ctx: AudioContext, dur: number, vol: number): void {
    const frames = Math.ceil(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = vol;
    src.connect(gain).connect(ctx.destination);
    src.start();
  }
}
