/**
 * Block sounds as data. Each sound is a few short layers — a body tone, a
 * filtered noise burst for the crack or crunch, and scattered "debris" ticks —
 * so a stone sounds like stone and glass like glass, and every play is a little
 * different (pitch, debris timing) instead of one stamped blip. Pure: the rng
 * is injected, so the recipes are unit-tested without an AudioContext.
 */

export type SoundKind = "break" | "hit" | "place";

export interface ToneLayer {
  t: "tone";
  wave: OscillatorType;
  f0: number;
  f1: number;
  dur: number;
  vol: number;
  delay: number;
}

export interface NoiseLayer {
  t: "noise";
  filter: BiquadFilterType;
  f0: number;
  f1: number;
  q: number;
  dur: number;
  vol: number;
  delay: number;
}

export type SoundLayer = ToneLayer | NoiseLayer;

const tone = (wave: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0): ToneLayer => ({ t: "tone", wave, f0, f1, dur, vol, delay });
const noise = (filter: BiquadFilterType, f0: number, f1: number, dur: number, vol: number, delay = 0, q = 1): NoiseLayer => ({ t: "noise", filter, f0, f1, q, dur, vol, delay });

/** Which recipe a block surface family uses. */
export type SoundMaterial = "stone" | "ore" | "wood" | "dirt" | "grass" | "sand" | "soft" | "glass" | "gem" | "metal";

export function soundMaterial(family: string): SoundMaterial {
  switch (family) {
    case "ore": case "wood": case "dirt": case "grass": case "sand": case "glass": case "gem": case "metal":
      return family;
    case "snow": case "wool":
      return "soft";
    default:
      return "stone"; // stone, coat, anything new
  }
}

/** n scattered debris ticks after the main crack. */
function debris(rng: () => number, n: number, from: number, to: number, f: number, spread: number, vol: number, filter: BiquadFilterType = "bandpass"): NoiseLayer[] {
  const out: NoiseLayer[] = [];
  for (let i = 0; i < n; i++) {
    const at = from + (to - from) * ((i + rng()) / n);
    const freq = f * (1 - spread / 2 + rng() * spread);
    out.push(noise(filter, freq, freq * 0.8, 0.025 + rng() * 0.03, vol * (0.6 + rng() * 0.5), at, 2.5));
  }
  return out;
}

function pings(rng: () => number, n: number, lo: number, hi: number, vol: number, from = 0, to = 0.18, wave: OscillatorType = "sine"): ToneLayer[] {
  const out: ToneLayer[] = [];
  for (let i = 0; i < n; i++) {
    const f = lo + rng() * (hi - lo);
    out.push(tone(wave, f, f * 0.985, 0.12 + rng() * 0.22, vol * (0.6 + rng() * 0.5), from + (to - from) * rng()));
  }
  return out;
}

function breakRecipe(m: SoundMaterial, rng: () => number): SoundLayer[] {
  switch (m) {
    case "stone":
      return [tone("triangle", 130, 52, 0.14, 0.11), noise("bandpass", 1900, 900, 0.09, 0.2, 0, 1.2), noise("lowpass", 500, 200, 0.26, 0.07, 0.02), ...debris(rng, 5, 0.05, 0.3, 2600, 0.6, 0.07)];
    case "ore":
      return [...breakRecipe("stone", rng), ...pings(rng, 2, 1700, 2600, 0.03, 0.04, 0.16, "triangle")];
    case "wood":
      return [tone("triangle", 270, 170, 0.08, 0.12), tone("square", 540, 400, 0.03, 0.025), noise("bandpass", 1300, 700, 0.07, 0.16, 0, 2), noise("highpass", 3200, 2600, 0.12, 0.05, 0.03), tone("sawtooth", 190, 140, 0.1, 0.018, 0.04), ...debris(rng, 3, 0.06, 0.22, 1600, 0.5, 0.05)];
    case "dirt":
      return [tone("triangle", 140, 75, 0.09, 0.08), noise("lowpass", 1100, 450, 0.18, 0.17), ...debris(rng, 4, 0.04, 0.2, 1800, 0.6, 0.045, "lowpass")];
    case "grass":
      return [...breakRecipe("dirt", rng), noise("highpass", 4200, 3600, 0.1, 0.04, 0.01)];
    case "sand":
      return [noise("lowpass", 1800, 380, 0.32, 0.14), tone("sine", 160, 90, 0.08, 0.05), ...debris(rng, 6, 0.03, 0.3, 2400, 0.8, 0.03, "lowpass")];
    case "soft":
      return [noise("lowpass", 760, 300, 0.17, 0.13), tone("sine", 310, 170, 0.11, 0.06)];
    case "glass":
      return [noise("highpass", 3600, 2800, 0.26, 0.09), noise("bandpass", 2400, 1600, 0.05, 0.1, 0, 1.5), ...pings(rng, 6, 2500, 5400, 0.03, 0, 0.2)];
    case "gem":
      return [noise("bandpass", 2200, 1400, 0.06, 0.11, 0, 1.5), ...[1320, 1760, 2640].map((f, i) => tone("triangle", f, f, 0.42, 0.034, i * 0.035)), ...pings(rng, 2, 3000, 4200, 0.022, 0.05, 0.2)];
    case "metal":
      return [tone("triangle", 150, 90, 0.08, 0.09), ...[430, 1105, 1840, 2690].map((f, i) => tone("sine", f, f * 0.995, 0.7 - i * 0.12, 0.05 - i * 0.009)), noise("bandpass", 2600, 2000, 0.04, 0.08, 0, 2)];
  }
}

function hitRecipe(m: SoundMaterial, rng: () => number): SoundLayer[] {
  switch (m) {
    case "stone": case "ore":
      return [noise("bandpass", 2300, 1500, 0.045, 0.12, 0, 1.6), tone("triangle", 190, 120, 0.045, 0.06), ...debris(rng, 1, 0.02, 0.06, 3000, 0.5, 0.03)];
    case "wood":
      return [tone("triangle", 340, 230, 0.055, 0.09), noise("bandpass", 1500, 1000, 0.035, 0.08, 0, 2)];
    case "dirt": case "grass":
      return [noise("lowpass", 1100, 600, 0.06, 0.12), tone("sine", 150, 100, 0.05, 0.04)];
    case "sand":
      return [noise("lowpass", 1900, 900, 0.07, 0.1)];
    case "soft":
      return [noise("lowpass", 650, 400, 0.05, 0.08)];
    case "glass":
      return [tone("sine", 3000, 2950, 0.07, 0.035), noise("highpass", 4000, 3500, 0.04, 0.06)];
    case "gem":
      return [tone("triangle", 2000, 1990, 0.1, 0.03), noise("bandpass", 2600, 2000, 0.03, 0.06, 0, 2)];
    case "metal":
      return [tone("sine", 900, 895, 0.16, 0.045), tone("sine", 2300, 2290, 0.1, 0.02), noise("bandpass", 3000, 2500, 0.025, 0.06, 0, 2)];
  }
}

/** A toy brick snapping on: a bright click, the body knock, then the second click. */
function placeRecipe(m: SoundMaterial): SoundLayer[] {
  const body: Record<SoundMaterial, number> = { stone: 180, ore: 180, wood: 250, dirt: 150, grass: 150, sand: 160, soft: 210, glass: 520, gem: 480, metal: 360 };
  if (m === "soft") return [noise("lowpass", 700, 400, 0.07, 0.09), tone("sine", 260, 180, 0.07, 0.05)];
  const layers: SoundLayer[] = [tone("square", 1450, 1300, 0.012, 0.035), tone("triangle", body[m], body[m] * 0.65, 0.07, 0.09), tone("square", 1750, 1600, 0.01, 0.022, 0.032)];
  if (m === "glass" || m === "gem") layers.push(tone("sine", 2600, 2590, 0.12, 0.02, 0.01));
  if (m === "metal") layers.push(tone("sine", 1100, 1095, 0.18, 0.025, 0.01));
  return layers;
}

/** The layers for one play, with this play's pitch variation applied. */
export function materialSound(kind: SoundKind, family: string, rng: () => number = Math.random): SoundLayer[] {
  const m = soundMaterial(family);
  const layers = kind === "break" ? breakRecipe(m, rng) : kind === "hit" ? hitRecipe(m, rng) : placeRecipe(m);
  const pitch = 0.92 + rng() * 0.16;
  const level = 0.88 + rng() * 0.12;
  return layers.map((l) => ({ ...l, f0: l.f0 * pitch, f1: l.f1 * pitch, vol: l.vol * level }));
}

/** The little "into the bag" pop after a block breaks. */
export function collectSound(rng: () => number = Math.random): SoundLayer[] {
  const p = 0.95 + rng() * 0.1;
  return [tone("sine", 620 * p, 980 * p, 0.07, 0.04, 0.13), tone("sine", 930 * p, 1250 * p, 0.05, 0.02, 0.16)];
}

/** Recorded banks in public/audio/sfx (built from CC0 packs, see public/audio/sfx/CREDITS.txt). */
export type SampleBankId =
  | "step-grass" | "step-stone" | "step-wood" | "step-snow" | "step-gravel" | "step-wet"
  | "hit-stone" | "break-stone" | "hit-wood" | "break-wood" | "hit-metal" | "break-metal" | "hit-glass" | "break-glass"
  | "swing" | "punch" | "land" | "splash" | "bubble";

/** Which recording a block sound uses, and how loud. Null: synth only (placing is a toy snap, not a recording). */
export function sampleBank(kind: SoundKind, family: string): { id: SampleBankId; vol: number } | null {
  if (kind === "place") return null;
  const m = soundMaterial(family);
  const hit = kind === "hit";
  switch (m) {
    case "stone": case "ore": return { id: hit ? "hit-stone" : "break-stone", vol: hit ? 0.42 : 0.55 };
    case "wood": return { id: hit ? "hit-wood" : "break-wood", vol: hit ? 0.42 : 0.5 };
    case "metal": return { id: hit ? "hit-metal" : "break-metal", vol: hit ? 0.35 : 0.45 };
    case "glass": case "gem": return { id: hit ? "hit-glass" : "break-glass", vol: hit ? 0.3 : 0.45 };
    // soft ground digs with the synth crunch: a footstep recording on every dig tap sounded like walking
    case "dirt": case "grass": return hit ? null : { id: "step-gravel", vol: 0.5 };
    case "sand": return hit ? null : { id: "step-gravel", vol: 0.42 };
    case "soft": return hit ? null : { id: "step-snow", vol: 0.4 };
  }
}

/** The footstep recording for the block under the feet. */
export function stepBank(family: string, wet = false): { id: SampleBankId; vol: number } {
  // footsteps sit far under everything else: players asked twice for them quieter
  // (about -15 dB from the first pass, plus the low-pass in Sfx.step)
  if (wet) return { id: "step-wet", vol: 0.065 };
  switch (soundMaterial(family)) {
    case "wood": return { id: "step-wood", vol: 0.05 };
    case "dirt": case "grass": case "sand": return { id: "step-grass", vol: 0.055 };
    case "soft": return { id: "step-snow", vol: family === "wool" ? 0.03 : 0.045 };
    default: return { id: "step-stone", vol: 0.045 };
  }
}
