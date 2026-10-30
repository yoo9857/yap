import { settings } from "../ui/settings.js";
import { collectSound, materialSound, sampleBank, stepBank, type SampleBankId, type SoundKind, type SoundLayer } from "./materialSounds.js";

/**
 * Tiny WebAudio synth blips — no assets to load, nothing to fail. The
 * AudioContext is created lazily and resumed on the first user gesture;
 * until then every play call is a silent no-op (browser autoplay policy).
 */
type SfxName =
  | "jump"
  | "land"
  | "checkpoint"
  | "crumble"
  | "oof"
  | "clear"
  | "click"
  | "place"
  | "pickup"
  | "doorOpen"
  | "doorClose"
  | "sit"
  | "undo"
  | "splash"
  | "pour"
  | "tap"
  | "bonk";

/** A decoded recording with where its sound actually starts and where it is loudest (seconds). */
export interface Clip {
  buffer: AudioBuffer;
  onset: number;
  peak: number;
}

/** Measure a clip once at load: attack = first 1.5 ms window reaching 20% of the loudest window. */
export function clipOf(buffer: AudioBuffer): Clip {
  const data = buffer.getChannelData(0);
  const win = Math.max(1, Math.round(buffer.sampleRate * 0.0015));
  let best = 0, bestAt = 0;
  const levels: number[] = [];
  for (let i = 0; i < data.length; i += win) {
    let sum = 0;
    const end = Math.min(data.length, i + win);
    for (let j = i; j < end; j++) sum += Math.abs(data[j]!);
    const level = sum / (end - i);
    levels.push(level);
    if (level > best) { best = level; bestAt = i; }
  }
  const first = levels.findIndex((l) => l >= best * 0.2);
  const onset = Math.max(0, first * win - win) / buffer.sampleRate;
  return { buffer, onset, peak: Math.max(onset, bestAt / buffer.sampleRate) };
}

/**
 * How a sound at (x, y, z) reaches the listener: full within 2 m, gone by ~22 m
 * (an eased fall-off), and panned by which side of the view it is on. The view
 * looks along (sin yaw, cos yaw) with yaw 0 = +z, so its right hand is
 * (-cos yaw, sin yaw).
 */
export function placeSound(l: { x: number; y: number; z: number; yaw: number }, x: number, y: number, z: number): { gain: number; pan: number } {
  const dx = x - l.x, dy = y - l.y, dz = z - l.z;
  const d = Math.hypot(dx, dy, dz);
  const gain = Math.pow(Math.max(0, 1 - Math.max(0, d - 2) / 20), 1.6);
  const right = (-Math.cos(l.yaw) * dx + Math.sin(l.yaw) * dz) / Math.max(1, Math.hypot(dx, dz));
  return { gain, pan: Math.max(-0.8, Math.min(0.8, right * 0.8)) };
}

export class Sfx {
  private readonly events = new AbortController();
  private disposed = false;
  private ctx: AudioContext | null = null;
  private unlocked = false;
  /** Everything goes through one gentle compressor, so stacked debris never clips. */
  private out: AudioNode | null = null;
  /** One shared second of white noise; each noise layer plays a random slice of it (no per-play buffer). */
  private noiseBuffer: AudioBuffer | null = null;
  /** Recorded CC0 sounds (public/audio/sfx), decoded in the background after the first gesture. Until they arrive, the synth recipes play. */
  private banks = new Map<string, Clip[]>();
  private banksLoading = false;
  /** The last two variants each bank played: neither is picked next, so steps never stutter on one recording. */
  private readonly lastPick = new Map<string, number[]>();
  /** Where the ears are (the camera) and which way they face, for classmates' sounds. */
  private readonly listener = { x: 0, y: 0, z: 0, yaw: 0 };
  /** Set only for the duration of one positioned sound: every layer of it goes through this gain + pan. */
  private bus: AudioNode | null = null;
  /** Live layers. Past the cap new layers are dropped: a sand avalanche must not become a wall of sound. */
  private voices = 0;

  constructor() {
    const unlock = () => {
      this.ensureContext();
      if (this.ctx && this.ctx.state === "suspended") {
        void this.ctx.resume();
      }
      this.unlocked = true;
      void this.loadBanks();
    };
    window.addEventListener("pointerdown", unlock, { passive: true, signal: this.events.signal });
    window.addEventListener("keydown", unlock, { signal: this.events.signal });
  }

  private ensureContext(): void {
    if (this.disposed) return;
    if (this.ctx) return;
    try {
      // "interactive": the smallest output buffer the device allows — a hit must not trail its frame
      this.ctx = new AudioContext({ latencyHint: "interactive" });
    } catch {
      this.ctx = null; // no audio support — game plays silently
      return;
    }
    // The graph is an extra: a context without it still plays straight to the speakers.
    try {
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.connect(this.ctx.destination);
      this.out = comp;
      const frames = this.ctx.sampleRate;
      this.noiseBuffer = this.ctx.createBuffer(1, frames, frames);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.out = null;
      this.noiseBuffer = null;
    }
  }

  /**
   * A block's own sound: `family` is its surface family (blockMaterials.surfaceStyle).
   * A recorded sample where we have one, the synth recipe otherwise; a break
   * keeps the synth debris under the recording, then the little collect pop.
   */
  material(kind: SoundKind, family: string): void {
    const ctx = this.ready();
    if (!ctx) return;
    const bank = sampleBank(kind, family);
    const played = bank ? this.sample(ctx, bank.id, bank.vol) : false;
    if (!played) this.layers(ctx, materialSound(kind, family));
    else if (kind === "break") this.layers(ctx, materialSound(kind, family).map((l) => ({ ...l, vol: l.vol * 0.45 })));
    // the "into my bag" pop is ours alone, not a classmate's
    if (kind === "break" && !this.bus) this.layers(ctx, collectSound());
  }

  /** The camera, each frame: classmates' sounds are placed against it. */
  setListener(x: number, y: number, z: number, yaw: number): void {
    this.listener.x = x; this.listener.y = y; this.listener.z = z; this.listener.yaw = yaw;
  }

  /**
   * A classmate's sound at grid position (x, y, z): full within 2 m, gone by
   * ~22 m, panned left/right by where it is relative to the way we face.
   * `play` emits the sound; everything it plays is routed through the bus.
   */
  at(x: number, y: number, z: number, play: () => void): void {
    const ctx = this.ready();
    if (!ctx) return;
    const { gain, pan: side } = placeSound(this.listener, x, y, z);
    if (gain < 0.03) return;
    const g = ctx.createGain();
    g.gain.value = gain;
    let node: AudioNode = g;
    if (typeof ctx.createStereoPanner === "function") {
      const pan = ctx.createStereoPanner();
      pan.pan.value = side;
      g.connect(pan);
      node = pan;
    }
    node.connect(this.out ?? ctx.destination);
    this.bus = g;
    try { play(); } finally { this.bus = null; }
    setTimeout(() => { g.disconnect(); node.disconnect(); }, 2500);
  }

  /** One footstep on a block of this surface family (`wet`: in shallow water). Played on the frame the foot lands. */
  step(family: string, wet = false, quiet = 1, rate = 1): void {
    const ctx = this.ready();
    if (!ctx) return;
    const bank = stepBank(family, wet);
    // steps go through a gentle low-pass: their recorded clicks (2-6 kHz) are what made
    // them sound loud and close; rounded off they sit under the game like soft pats
    const soft = ctx.createBiquadFilter();
    soft.type = "lowpass";
    soft.frequency.value = 2400;
    soft.Q.value = 0.5;
    soft.connect(this.bus ?? this.out ?? ctx.destination);
    const outer = this.bus;
    this.bus = soft;
    try {
      if (!this.sample(ctx, bank.id, bank.vol * quiet, { rate })) this.beep(ctx, 120, 0.05, "triangle", 0.012 * quiet, 80);
    } finally { this.bus = outer; }
    setTimeout(() => soft.disconnect(), 1500);
  }

  /**
   * The whoosh of a swing, timed so its loudest moment comes `impactIn`
   * seconds from now minus a hair — a whoosh peaking after the hit sounds late.
   */
  swing(impactIn = 0): void {
    const ctx = this.ready();
    if (!ctx) return;
    const at = Math.max(0, impactIn - 0.03);
    if (!this.sample(ctx, "swing", 0.32, { at, align: "peak" })) this.filtered(ctx, "bandpass", 900, 2600, 1.2, 0.16, 0.06, Math.max(0, at - 0.08));
  }

  /** A body hit whose impact lands `in` seconds from now (0: now). */
  punch(inSeconds = 0): void {
    const ctx = this.ready();
    if (!ctx) return;
    if (!this.sample(ctx, "punch", 0.45, { at: inSeconds, align: "peak" })) {
      this.beep(ctx, 520, 0.05, "triangle", 0.055, 160, inSeconds);
      this.filtered(ctx, "lowpass", 1400, 500, 1, 0.06, 0.05, inSeconds);
    }
  }

  private async loadBanks(): Promise<void> {
    if (this.banksLoading || this.disposed || typeof fetch === "undefined") return;
    this.banksLoading = true;
    try {
      const res = await fetch("/audio/sfx/manifest.json");
      if (!res.ok) return;
      const manifest = (await res.json()) as Record<string, string[]>;
      // every file at once (they are a few KB each): one round trip instead of 115 in a row,
      // so the recordings replace the synth fallback within a moment of the first click
      const ctx = this.ctx;
      if (!ctx || this.disposed) return;
      const load = async (file: string): Promise<Clip | null> => {
        try {
          const data = await (await fetch("/audio/sfx/" + file)).arrayBuffer();
          return this.disposed ? null : clipOf(await ctx.decodeAudioData(data));
        } catch { return null; } // one bad file only thins its bank
      };
      await Promise.all(Object.entries(manifest).map(async ([id, files]) => {
        const clips = (await Promise.all(files.map(load))).filter((c): c is Clip => c !== null);
        if (clips.length && !this.disposed) this.banks.set(id, clips);
      }));
    } catch { /* offline or blocked: the synth recipes keep playing */ }
  }

  /**
   * A random variant (never the same one twice running) at a slightly varied
   * pitch. Every clip starts at its measured attack, so nothing waits on a
   * decoder's leading silence. `align: "peak"` puts the clip's loudest moment
   * at `at` seconds from now, skipping into the clip when it would be late.
   */
  private sample(ctx: AudioContext, id: SampleBankId, vol: number, opts: { at?: number; align?: "start" | "peak"; rate?: number } = {}): boolean {
    const bank = this.banks.get(id);
    if (!bank?.length || !this.claim()) return false;
    const recent = this.lastPick.get(id) ?? [];
    const fresh = bank.map((_, i) => i).filter((i) => !recent.includes(i));
    const pool = fresh.length ? fresh : bank.map((_, i) => i);
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    this.lastPick.set(id, [pick, ...recent].slice(0, Math.min(2, bank.length - 1)));
    const clip = bank[pick]!;
    const rate = (opts.rate ?? 1) * (0.94 + Math.random() * 0.12);
    const at = opts.at ?? 0;
    // seconds of clip (at playback rate) between its attack and the moment we want on the beat
    const lead = opts.align === "peak" ? (clip.peak - clip.onset) / rate : 0;
    const skip = Math.max(0, lead - at) * rate;
    const when = ctx.currentTime + Math.max(0, at - lead);
    const src = ctx.createBufferSource();
    src.buffer = clip.buffer;
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = vol * settings.sfx * (0.85 + Math.random() * 0.15);
    src.connect(gain).connect(this.bus ?? this.out ?? ctx.destination);
    src.onended = () => this.voices--;
    src.start(when, clip.onset + skip);
    return true;
  }

  private ready(): AudioContext | null {
    if (!this.unlocked || settings.sfx === 0) return null;
    this.ensureContext();
    const ctx = this.ctx;
    return ctx && ctx.state === "running" ? ctx : null;
  }

  private layers(ctx: AudioContext, layers: readonly SoundLayer[]): void {
    for (const l of layers) {
      if (l.t === "tone") this.beep(ctx, l.f0, l.dur, l.wave, l.vol, l.f1, l.delay);
      else this.filtered(ctx, l.filter, l.f0, l.f1, l.q, l.dur, l.vol, l.delay);
    }
  }

  play(name: SfxName): void {
    const ctx = this.ready();
    if (!ctx) return;

    switch (name) {
      case "jump": // a springy toy hop
        this.beep(ctx, 260, 0.13, "triangle", 0.07, 620);
        this.beep(ctx, 520, 0.06, "square", 0.018, 900, 0.02);
        break;
      case "land": // a soft thump on studs
        if (this.sample(ctx, "land", 0.28, { rate: 0.8 })) break;
        this.beep(ctx, 150, 0.09, "triangle", 0.08, 70);
        this.filtered(ctx, "lowpass", 700, 300, 1, 0.07, 0.07);
        break;
      case "checkpoint":
        this.beep(ctx, 520, 0.1, "sine", 0.07, 780);
        this.beep(ctx, 780, 0.16, "sine", 0.06, 1040, 0.08);
        break;
      case "crumble": // tower platforms shaking loose
        this.layers(ctx, materialSound("break", "stone"));
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
      // furniture: soft and woody, so a room furnished piece by piece does not
      // sound like a building site (they used to borrow land/crumble)
      case "place":
        this.beep(ctx, 240, 0.07, "triangle", 0.07, 150);
        this.beep(ctx, 180, 0.09, "triangle", 0.05, 120, 0.05);
        break;
      case "pickup":
        this.beep(ctx, 300, 0.1, "sine", 0.06, 620);
        break;
      case "doorOpen":
        this.beep(ctx, 110, 0.32, "sawtooth", 0.025, 190); // a little creak
        this.beep(ctx, 520, 0.05, "square", 0.025, 520); // the latch
        break;
      case "doorClose":
        this.beep(ctx, 150, 0.12, "triangle", 0.08, 70); // the thud
        this.beep(ctx, 620, 0.04, "square", 0.025, 620, 0.06); // the latch
        break;
      case "sit":
        this.beep(ctx, 200, 0.14, "sine", 0.06, 120);
        break;
      case "undo":
        this.beep(ctx, 660, 0.06, "sine", 0.045, 440);
        break;
      case "splash":
        if (this.sample(ctx, "splash", 0.55)) break;
        this.noise(ctx, 0.35, 0.08);
        this.beep(ctx, 380, 0.2, "sine", 0.04, 140);
        break;
      case "pour":
        if (this.sample(ctx, "bubble", 0.4)) break;
        this.beep(ctx, 540, 0.14, "sine", 0.035, 300);
        this.noise(ctx, 0.16, 0.03);
        break;
      case "tap":
        if (this.sample(ctx, "swing", 0.3)) break;
        this.beep(ctx, 880, 0.04, "square", 0.03, 420);
        break;
      case "bonk":
        if (this.sample(ctx, "punch", 0.45, { align: "peak" })) break;
        this.beep(ctx, 520, 0.05, "triangle", 0.055, 160);
        this.noise(ctx, 0.04, 0.02);
        break;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.events.abort(); this.unlocked = false;
    if (this.ctx) void this.ctx.close().catch(() => {});
    this.ctx = null;
    this.out = null;
    this.noiseBuffer = null;
    this.banks.clear();
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
    // a 4 ms attack: starting at full level clicks on every note
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(vol * settings.sfx, 0.0001), t0 + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    if (!this.claim()) return;
    osc.connect(gain).connect(this.bus ?? this.out ?? ctx.destination);
    osc.onended = () => this.voices--;
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private static readonly MAX_VOICES = 40;

  private claim(): boolean {
    if (this.voices >= Sfx.MAX_VOICES) return false;
    this.voices++;
    return true;
  }

  /** Unfiltered noise that fades out (splash, pour). */
  private noise(ctx: AudioContext, dur: number, vol: number): void {
    this.filtered(ctx, "allpass", 1000, 1000, 1, dur, vol, 0);
  }

  /** A slice of the shared noise through a sweeping filter: cracks, crunches, rustles. */
  private filtered(ctx: AudioContext, type: BiquadFilterType, f0: number, f1: number, q: number, dur: number, vol: number, delay = 0): void {
    if (!this.noiseBuffer || !this.claim()) return;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t0 + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(vol * settings.sfx, 0.0001), t0 + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(this.bus ?? this.out ?? ctx.destination);
    src.onended = () => this.voices--;
    const offset = Math.random() * Math.max(0, this.noiseBuffer.duration - dur - 0.05);
    src.start(t0, offset, dur + 0.03);
  }
}
