/**
 * The three fitting mini-games (pure rules, no DOM). Fitting the foundation centre, the generator or
 * the wire terminal opens one of them; the piece goes in only when it is done.
 *
 * - grounding (기초 중심): drive the earth rod into the ground (taps), then clip the green-yellow
 *   earth wire onto it — leftover electricity and lightning run safely into the ground.
 * - generator (발전기): turn the magnet inside the copper coil — the meter only moves WHILE it turns
 *   (a changing magnetic field makes electricity); enough turning charges it up.
 * - wiring (전선 단자): connect red to +, black to −, green-yellow to earth (the colour code).
 * - rotor (날개): mount three blades on the hub's six sockets, tighten each bolt, then test spin —
 *   it only runs smoothly when the blades are evenly spaced (120°); bunched blades wobble.
 */
import type { SocketItem } from "./plants.js";

export type MiniGameKind = "grounding" | "generator" | "wiring" | "rotor";

/** Which fitted items open which game. */
export const MINI_GAMES: Partial<Record<SocketItem, MiniGameKind>> = {
  "frame-foundation-center": "grounding",
  "part-generator": "generator",
  "part-wire-terminal": "wiring",
  "part-blades": "rotor",
};

// ------------------------------------------------------------------ grounding

/** Taps it takes to drive the rod all the way in. */
export const ROD_HITS = 4;

export interface GroundingState {
  hits: number;
  connected: boolean;
}

export const grounding = {
  start: (): GroundingState => ({ hits: 0, connected: false }),
  /** One hammer tap (ignored once the rod is in). */
  hit: (s: GroundingState): GroundingState => ({ ...s, hits: Math.min(ROD_HITS, s.hits + 1) }),
  /** 0 → 1: how deep the rod is. */
  depth: (s: GroundingState): number => s.hits / ROD_HITS,
  /** The wire's clip dropped at a distance (px) from the rod's clamp: it holds only once the rod is in. */
  drop: (s: GroundingState, distance: number): { state: GroundingState; result: "ok" | "rod-first" | "miss" } => {
    if (s.hits < ROD_HITS) return { state: s, result: "rod-first" };
    if (distance > 42) return { state: s, result: "miss" };
    return { state: { ...s, connected: true }, result: "ok" };
  },
  done: (s: GroundingState): boolean => s.hits >= ROD_HITS && s.connected,
};

// ------------------------------------------------------------------ generator

/** Turns of the magnet that fill the charge. */
export const TURNS_NEEDED = 3;
/** How fast the meter falls back when the magnet stops (per second, of the reading). */
const METER_DECAY = 3.2;

export interface GeneratorState {
  /** The magnet's angle (radians). */
  angle: number;
  /** The meter's reading 0–1: the current right now, which follows how fast it turns. */
  meter: number;
  /** 0–1: the charge made so far. */
  charge: number;
}

export const generator = {
  start: (): GeneratorState => ({ angle: 0, meter: 0, charge: 0 }),
  /** The player turned the magnet by `dAngle` (either way) over `dt` seconds. */
  turn: (s: GeneratorState, dAngle: number, dt: number): GeneratorState => {
    const turned = Math.abs(dAngle);
    // speed in turns per second → a reading that saturates around 1.5 turns/s
    const speed = dt > 0 ? turned / (2 * Math.PI) / dt : 0;
    const reading = Math.min(1, speed / 1.5);
    return {
      angle: s.angle + dAngle,
      meter: Math.max(s.meter, reading),
      charge: Math.min(1, s.charge + turned / (2 * Math.PI * TURNS_NEEDED)),
    };
  },
  /** Time passing with no turn: the reading drops to zero — no turning, no electricity. */
  idle: (s: GeneratorState, dt: number): GeneratorState => ({ ...s, meter: Math.max(0, s.meter - METER_DECAY * dt * Math.max(0.25, s.meter)) }),
  done: (s: GeneratorState): boolean => s.charge >= 1,
};

// ------------------------------------------------------------------ wiring

export type WireColour = "red" | "black" | "earth";
export type Terminal = "plus" | "minus" | "ground";

/** The colour code every electrician uses. */
export const WIRE_TO: Readonly<Record<WireColour, Terminal>> = { red: "plus", black: "minus", earth: "ground" };

export interface WiringState {
  /** Wires top to bottom on the left, terminals top to bottom on the right (shuffled per game). */
  wires: WireColour[];
  terminals: Terminal[];
  connected: Partial<Record<WireColour, Terminal>>;
  mistakes: number;
}

/** A game with both columns shuffled by `rand` (0 ≤ rand() < 1), never already in matching rows. */
export function startWiring(rand: () => number = Math.random): WiringState {
  const shuffle = <T>(xs: T[]): T[] => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };
  const wires = shuffle<WireColour>(["red", "black", "earth"]);
  // straight-across lines would teach nothing: each terminal row belongs to the wire one or two
  // rows away (a cyclic shift by 1 or 2 has no fixed point), so no row ever starts matched
  const k = rand() < 0.5 ? 1 : 2;
  const terminals = wires.map((_, i) => WIRE_TO[wires[(i + k) % 3]!]);
  return { wires, terminals, connected: {}, mistakes: 0 };
}

export const wiring = {
  connect: (s: WiringState, wire: WireColour, terminal: Terminal): { state: WiringState; result: "ok" | "wrong" | "taken" } => {
    if (s.connected[wire] || Object.values(s.connected).includes(terminal)) return { state: s, result: "taken" };
    if (WIRE_TO[wire] !== terminal) return { state: { ...s, mistakes: s.mistakes + 1 }, result: "wrong" };
    return { state: { ...s, connected: { ...s.connected, [wire]: terminal } }, result: "ok" };
  },
  done: (s: WiringState): boolean => (["red", "black", "earth"] as WireColour[]).every((w) => s.connected[w] === WIRE_TO[w]),
};

// ------------------------------------------------------------------ rotor (blade assembly)

/** Mounting sockets around the hub (every 60°) and the blades a rotor takes. */
export const HUB_MOUNTS = 6;
export const BLADES = 3;

export interface RotorState {
  /** Mount index of each blade on the hub (0 … HUB_MOUNTS−1). */
  mounted: number[];
  /** Mounts whose bolt is tightened. */
  tight: number[];
  /** The last test spin's verdict: null = not tried yet. */
  test: "smooth" | "wobble" | null;
}

export const rotor = {
  start: (): RotorState => ({ mounted: [], tight: [], test: null }),
  attach: (s: RotorState, mount: number): { state: RotorState; result: "ok" | "taken" | "full" } => {
    if (s.mounted.includes(mount)) return { state: s, result: "taken" };
    if (s.mounted.length >= BLADES) return { state: s, result: "full" };
    return { state: { ...s, mounted: [...s.mounted, mount], test: null }, result: "ok" };
  },
  /** Take a blade back off (its bolt comes loose with it). */
  detach: (s: RotorState, mount: number): RotorState => ({ mounted: s.mounted.filter((m) => m !== mount), tight: s.tight.filter((m) => m !== mount), test: null }),
  tighten: (s: RotorState, mount: number): { state: RotorState; result: "ok" | "no-blade" | "already" } => {
    if (!s.mounted.includes(mount)) return { state: s, result: "no-blade" };
    if (s.tight.includes(mount)) return { state: s, result: "already" };
    return { state: { ...s, tight: [...s.tight, mount] }, result: "ok" };
  },
  /** Every blade on and every bolt tight: ready for a test spin. */
  ready: (s: RotorState): boolean => s.mounted.length === BLADES && s.tight.length === BLADES,
  /** Evenly spaced: the gaps between neighbouring blades are all equal (here 2 sockets = 120°). */
  balanced: (s: RotorState): boolean => {
    if (s.mounted.length !== BLADES) return false;
    const m = [...s.mounted].sort((a, b) => a - b);
    const gaps = m.map((v, i) => ((m[(i + 1) % m.length]! - v + HUB_MOUNTS) % HUB_MOUNTS));
    return gaps.every((g) => g === HUB_MOUNTS / BLADES);
  },
  spin: (s: RotorState): RotorState => ({ ...s, test: rotor.ready(s) ? (rotor.balanced(s) ? "smooth" : "wobble") : null }),
  done: (s: RotorState): boolean => s.test === "smooth",
};
