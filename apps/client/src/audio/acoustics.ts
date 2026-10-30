/**
 * The voxel world as an acoustic space, kept pure so it is unit-tested:
 * how much a wall muffles a sound, and how enclosed the listener is (which
 * drives the room echo). The world is passed in as a cell query, so this file
 * knows nothing about blocks or rendering.
 */

/** How strongly a cell blocks sound: 1 for solid bricks, ~0.35 for glass or leaves, 0 for air and water. */
export type CellDamping = (x: number, y: number, z: number) => number;

export interface Occlusion {
  /** Summed damping of the cells between the two points (0 = clear line). */
  amount: number;
  /** Linear gain to apply: each full wall costs about 6 dB, three walls or more stay audible but faint. */
  gain: number;
  /** Low-pass cutoff in Hz: through a wall you hear the thump, not the click. */
  cutoff: number;
}

const OPEN: Occlusion = { amount: 0, gain: 1, cutoff: 20000 };

/**
 * Walk the line from listener to source in 0.25 m steps and add up the
 * damping of each distinct cell it passes through. The cell the source sits in
 * (a block being broken, a classmate's own feet) and the listener's cell do not
 * count, so a sound never muffles itself.
 */
export function occlusion(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  damping: CellDamping,
): Occlusion {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.6) return OPEN;
  const steps = Math.ceil(dist / 0.25);
  const ends = new Set([cellKey(from[0], from[1], from[2]), cellKey(to[0], to[1], to[2])]);
  const seen = new Set<string>();
  let amount = 0;
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const x = from[0] + dx * f, y = from[1] + dy * f, z = from[2] + dz * f;
    const key = cellKey(x, y, z);
    if (ends.has(key) || seen.has(key)) continue;
    seen.add(key);
    amount += damping(Math.floor(x), Math.floor(y), Math.floor(z));
    if (amount >= 4) break; // past four walls nothing more changes
  }
  if (amount <= 0.01) return OPEN;
  return occlusionFor(amount);
}

/** The audible result of `amount` walls' worth of damping. */
export function occlusionFor(amount: number): Occlusion {
  const a = Math.min(4, Math.max(0, amount));
  return { amount: a, gain: Math.max(0.12, Math.pow(0.5, a)), cutoff: Math.max(350, 6000 * Math.pow(0.3, a)) };
}

function cellKey(x: number, y: number, z: number): string {
  return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
}

export interface Room {
  /** 0 out in the open .. 1 shut in on every side. */
  enclosure: number;
  /** Typical distance to the walls that were hit (m): a cave hall rings longer than a cupboard. */
  size: number;
}

/** Fourteen directions: up, the four sides, the four diagonals, and five leaning up. */
const PROBES: readonly (readonly [number, number, number])[] = [
  [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  [0.71, 0, 0.71], [-0.71, 0, 0.71], [0.71, 0, -0.71], [-0.71, 0, -0.71],
  [0.58, 0.58, 0.58], [-0.58, 0.58, 0.58], [0.58, 0.58, -0.58], [-0.58, 0.58, -0.58], [0, 0.71, 0.71],
];

/**
 * How enclosed the listener is: cast short rays and see how many meet a wall
 * within `reach`. A field under open sky scores ~0, a house ~0.7-0.9, a tunnel ~1.
 * The ground below is not probed: standing on it is not being indoors.
 */
export function measureRoom(at: readonly [number, number, number], solid: (x: number, y: number, z: number) => boolean, reach = 14): Room {
  let hits = 0, total = 0;
  for (const [ux, uy, uz] of PROBES) {
    for (let t = 0.75; t <= reach; t += 0.5) {
      if (solid(Math.floor(at[0] + ux * t), Math.floor(at[1] + uy * t), Math.floor(at[2] + uz * t))) {
        hits++;
        total += t;
        break;
      }
    }
  }
  // the roof counts double: open sides with a ceiling still ring, open sky does not
  const roofed = solidAbove(at, solid, reach);
  const enclosure = Math.min(1, (hits / PROBES.length) * (roofed ? 1.15 : 0.55));
  return { enclosure, size: hits ? total / hits : reach };
}

function solidAbove(at: readonly [number, number, number], solid: (x: number, y: number, z: number) => boolean, reach: number): boolean {
  for (let t = 1; t <= reach; t += 1) if (solid(Math.floor(at[0]), Math.floor(at[1] + t), Math.floor(at[2]))) return true;
  return false;
}

/** Echo settings for a room: how much of the sound returns, and how long the tail rings (s). */
export function roomEcho(room: Room): { wet: number; decay: number } {
  const wet = Math.pow(room.enclosure, 1.5) * 0.32;
  const decay = 0.35 + Math.min(1, room.size / 12) * 1.6;
  return { wet, decay };
}
