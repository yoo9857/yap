import { FIRE_CAMPUS, fireSchool, inFireZone, type FireStationKind } from "@robo/shared";
import { StaticScene } from "../staticScene.js";

/**
 * The fire drill's rules (화재 체험), pure: what each station does at each step, how an
 * extinguisher puts a small fire out, what smoke costs, and when the drill is done. No DOM, no
 * three.js — `FireDrill` (fireDrill.ts) is the glue. Positions are ABSOLUTE field coordinates,
 * the school's own (packages/shared/src/fireSchool.ts).
 *
 * The lesson, in order:
 *   alarm    불이야! — press the fire alarm so everyone knows
 *   call     119 — say where, and what is burning
 *   grab     소화기 — pin, aim, squeeze, sweep (taught once in a panel)
 *   spray    put the SMALL fire out, aiming at its base
 *   towel    the big fire is not ours to fight: wet towel over nose and mouth
 *   escape   stay low under the smoke, follow the exit signs out
 *   assemble gather on the schoolyard
 */
export const DRILL_STEPS = ["alarm", "call", "grab", "spray", "towel", "escape", "assemble", "done"] as const;
export type DrillStep = (typeof DRILL_STEPS)[number];

export interface Drill {
  step: DrillStep;
  /** Seconds since the drill began; stops when it is done. */
  time: number;
  alarm: boolean;
  /** A charged extinguisher is in hand. */
  extinguisher: boolean;
  /** Pin – aim – squeeze – sweep has been taught: a second extinguisher is simply picked up. */
  trained: boolean;
  /** What is left in the extinguisher, 1 → 0. */
  charge: number;
  /** The small fire, 1 → 0 (out). */
  fire: number;
  towel: boolean;
  /** Breath, 1 → 0: smoke takes it, clean air gives it back. */
  air: number;
  /** Times the smoke got the better of us. */
  mistakes: number;
  /** Seconds spent breathing smoke or standing in the heat. */
  smokeTime: number;
  /** Seconds until the smoke that started spreading reaches breathing height (a moment to react). */
  smokeIn: number;
  /** Seconds the corridor has been filling with smoke: it sinks and its thick end creeps east. */
  smokeAge: number;
  /**
   * The smoke's own clock (what `smokeField`'s arrival times are read against). It runs with the
   * drill's — and hurries once the escape begins, until the smoke is over the way out: the lesson
   * of the escape is "stay low under the smoke", so by then there has to be smoke to stay under,
   * however fast the child was (owner's call 2026-11-13).
   */
  smokeClock: number;
}

export function newDrill(): Drill {
  return { step: "alarm", time: 0, alarm: false, extinguisher: false, trained: false, charge: 0, fire: 1, towel: false, air: 1, mistakes: 0, smokeTime: 0, smokeIn: 0, smokeAge: 0, smokeClock: 0 };
}

const at = (step: DrillStep): number => DRILL_STEPS.indexOf(step);
/** Has the drill reached `step` (or gone past it)? */
export const reached = (d: Drill, step: DrillStep): boolean => at(d.step) >= at(step);
/** Smoke fills the corridor from the moment the small fire is dealt with. */
export const smokeOn = (d: Drill): boolean => reached(d, "towel") && d.step !== "done";

/** Seconds a full extinguisher sprays, and seconds of spray on its base that put the small fire out. */
export const CHARGE_S = 14;
export const EXTINGUISH_S = 3.2;
/** An extinguisher reaches about this far (m). */
export const SPRAY_REACH = 5;
/** Seconds between the small fire going out and the corridor's smoke costing breath. */
export const SMOKE_GRACE_S = 4;
/**
 * Breath lost per second. Upright in smoke is survivable for a few seconds (a child has to get
 * from the fire to the sink), a towel halves it, and LOW with a towel costs nothing — the lesson.
 */
export const DRAIN = { upright: 0.14, uprightTowel: 0.07, lowBare: 0.03, thick: 0.45, heat: 0.5 } as const;
const BASE_RADIUS = 0.75;
const FLAME_RADIUS = 0.8;

// ------------------------------------------------------------------ the fire grows
// A fire left alone gets worse: the big fire catches one thing after another on its way to the
// door, the waste-bin fire grows (and takes longer to put out, and flares up again when the spray
// stops), the smoke sinks, and its thick end creeps along the corridor. All of it is a function of
// the drill's own clock, so every screen that runs the same drill shows the same fire.

let campus: StaticScene | null = null;
/**
 * Where a fire at (x, ~y, z) really stands: the top of whatever the school has under that point —
 * a bench, the bin's rim, the floor. A fire is never placed by a number alone: when the map
 * changes, the fire follows the map (a flame hanging in the air is the first thing anyone sees).
 */
export function fireFoot(x: number, y: number, z: number): number {
  const top = school3d().floorBelow(x, y + 0.15, z);
  return Number.isFinite(top) ? top : y;
}
/**
 * How far the surface a fire stands on (at x, y, z) goes on all round it, up to `max` metres: a
 * flame wider than what carries it hangs over the edge — fire in mid-air beside a bench. The
 * effects size every flame by this (and use a narrow one where there is little room).
 */
export function supportRadius(x: number, y: number, z: number, max: number): number {
  const scene = school3d();
  for (let r = 0.15; r <= max + 1e-6; r += 0.15) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4, top = scene.floorBelow(x + Math.cos(a) * r, y + 0.15, z + Math.sin(a) * r);
      if (!(Math.abs(top - y) <= 0.1)) return r - 0.15; // a step down (the bench's edge) or up (something standing there)
    }
  }
  return max;
}
function school3d(): StaticScene {
  return (campus ??= new StaticScene([...FIRE_CAMPUS.boxes, ...fireSchool().obstacles], FIRE_CAMPUS.ramps));
}

/**
 * Fire does not stop at a wall or a cupboard: it CLIMBS what it reaches. A climbing place is a
 * spot on an upright face of the school (a wall, the side of a cabinet or a bench) inside the
 * burning room, found by looking sideways from the room's air until something solid is met — so
 * it follows the map, whatever is put in the room. A spot is the FOOT of its face (where the face
 * meets the floor or what stands before it): the fire catches there when the floor fire arrives,
 * and grows up the face from it at `CLIMB_S_PER_M`, as far as the face goes (`rise`). Fire never
 * starts half-way up a wall.
 */
export interface ClimbSpot {
  /** The foot of the face (absolute). */
  at: [number, number, number];
  /** Out of the face, level (unit x, z). */
  normal: [number, number];
  /** Seconds after the floor under it catches. */
  delay: number;
  /** How far up the face goes from the foot (m): the fire climbs this far and no further. */
  rise: number;
}
/** Seconds after the floor fire arrives that a face's foot catches. */
export const CLIMB_DELAY_S = 2;
/** Seconds the fire takes to climb a metre. */
export const CLIMB_S_PER_M = 7;
/** A face must be at least this wide to carry a flame (a chair leg does not). */
const CLIMB_FACE = 0.7;

export function climbSpots(count: number, rand: () => number): ClimbSpot[] {
  const scene = school3d(), school = fireSchool();
  const [x0, floor, z0, x1, top, z1] = school.heat;
  const ceiling = Math.min(top, school.corridor[4]);
  const solid = (x: number, y: number, z: number): boolean => scene.intersects([x - 0.02, y - 0.02, z - 0.02], [x + 0.02, y + 0.02, z + 0.02]);
  const spots: ClimbSpot[] = [];
  for (let tries = 0; spots.length < count && tries < count * 60; tries++) {
    const x = x0 + 0.2 + rand() * (x1 - x0 - 0.4), z = z0 + 0.2 + rand() * (z1 - z0 - 0.4);
    const y = floor + 0.08 + rand() * rand() * (ceiling - floor - 1.2); // mostly low: fire starts at the foot
    const turn = Math.floor(rand() * 4), dx = turn === 0 ? 1 : turn === 1 ? -1 : 0, dz = turn === 2 ? 1 : turn === 3 ? -1 : 0;
    if (solid(x, y, z)) continue;
    const hit = scene.raycast([x, y, z], [dx, 0, dz], 5);
    if (!hit || Math.abs(hit.normal[1]) > 0.5) continue;
    const [hx, hy, hz] = hit.point, nx = hit.normal[0], nz = hit.normal[2];
    if (hx < x0 - 0.2 || hx > x1 + 0.2 || hz < z0 - 0.2 || hz > z1 + 0.2) continue; // seen through the door or a window
    // the face has to be there to both sides (wide enough), and the air in front of it free
    const tx = nz, tz = -nx, half = CLIMB_FACE / 2;
    if (!solid(hx - nx * 0.06 + tx * half, hy, hz - nz * 0.06 + tz * half) || !solid(hx - nx * 0.06 - tx * half, hy, hz - nz * 0.06 - tz * half)) continue;
    // down to the face's foot, then up it as far as it stays a face
    const foot = fireFoot(hx + nx * 0.12, hy, hz + nz * 0.12);
    if (!Number.isFinite(foot) || foot < floor - 0.05 || !solid(hx - nx * 0.06, foot + 0.12, hz - nz * 0.06)) continue;
    let rise = 0.25;
    while (foot + rise + 0.25 < ceiling - 0.1 && solid(hx - nx * 0.06, foot + rise + 0.25, hz - nz * 0.06) && !solid(hx + nx * 0.12, foot + rise + 0.25, hz + nz * 0.12)) rise += 0.25;
    if (rise < 0.5) continue; // a kerb, not a face
    // one fire per stretch of face: a second foot beside this one adds nothing
    if (spots.some((s) => s.normal[0] === nx && s.normal[1] === nz && Math.hypot(s.at[0] - hx, s.at[2] - hz) < 0.55 && Math.abs(s.at[1] - foot) < 0.3)) continue;
    spots.push({ at: [hx, foot, hz], normal: [nx, nz], delay: CLIMB_DELAY_S, rise });
  }
  return spots;
}

/**
 * The big fire is ONE burning area, not a list of fires: a map of the burning room's floor that
 * says WHEN each spot catches. The fire starts where the school says it started and its edge
 * creeps outward — faster here, slower there, so the front is ragged like a real one — until the
 * whole room burns. Everything that shows or sounds the fire reads this map.
 */
export interface BurnField {
  /** The map's corner (absolute x, z), its cell size (m) and its size in cells. */
  x0: number; z0: number; cell: number; w: number; h: number;
  /** Seconds into the drill when each cell catches (row by row along z; negative: burning at the start). */
  ignite: Float32Array;
  /** How much there is to burn there: 1 on the bare floor, more round the school's own fires. */
  fuel: Float32Array;
}
const BURN_CELL = 0.25;
/** Seconds of drill before which the first patch was already burning, and when the last corner catches. */
export const BURN_HEAD_S = 22;
export const BURN_SPREAD_S = 170;
/** Seconds from a spot catching to burning at full height. */
export const BURN_GROW_S = 14;

/** Smooth value noise in [0, 1], the same on every machine. */
function noise2(x: number, z: number): number {
  const hash = (i: number, j: number): number => {
    let n = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const i = Math.floor(x), j = Math.floor(z), u = smooth(x - i), v = smooth(z - j);
  return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v;
}

let field: BurnField | null = null;
export function burnField(): BurnField {
  if (field) return field;
  const school = fireSchool();
  const [x0, , z0, x1, , z1] = school.heat;
  const w = Math.ceil((x1 - x0) / BURN_CELL), h = Math.ceil((z1 - z0) / BURN_CELL), n = w * h;
  const big = school.fires.filter((f) => !f.small);
  const origin = big.find((f) => f.id === "corner") ?? big[0]!;
  const cx = (i: number): number => x0 + (i + 0.5) * BURN_CELL, cz = (j: number): number => z0 + (j + 0.5) * BURN_CELL;

  // how fast the edge moves through each cell: patchy, so the front is never a circle
  const pace = new Float32Array(n), fuel = new Float32Array(n);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, x = cx(i), z = cz(j);
    pace[k] = 0.45 + noise2(x / 1.7, z / 1.7) * 0.8 + noise2(x / 0.6 + 40, z / 0.6) * 0.35;
    let more = 0;
    for (const f of big) more = Math.max(more, (f.size / 2.6) * (1 - smooth(Math.hypot(x - f.at[0], z - f.at[2]) / 2.2)));
    fuel[k] = 1 + 0.55 * more;
    pace[k] *= 1 + 0.5 * more; // and it runs along what burns well
  }
  // the time the edge takes to reach every cell from where the fire started (Dijkstra; the map is small)
  const reach = new Float32Array(n).fill(Infinity), done = new Uint8Array(n);
  const start = Math.min(h - 1, Math.max(0, Math.floor((origin.at[2] - z0) / BURN_CELL))) * w + Math.min(w - 1, Math.max(0, Math.floor((origin.at[0] - x0) / BURN_CELL)));
  reach[start] = 0;
  for (let round = 0; round < n; round++) {
    let k = -1, best = Infinity;
    for (let m = 0; m < n; m++) if (!done[m] && reach[m]! < best) { best = reach[m]!; k = m; }
    if (k < 0) break;
    done[k] = 1;
    const i = k % w, j = (k - i) / w;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ni = i + di, nj = j + dj;
      if ((di === 0 && dj === 0) || ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
      const m = nj * w + ni, t = best + Math.hypot(di, dj) * 2 / (pace[k]! + pace[m]!);
      if (t < reach[m]!) reach[m] = t;
    }
  }
  let far = 0;
  for (let m = 0; m < n; m++) far = Math.max(far, reach[m]!);
  const ignite = new Float32Array(n);
  for (let m = 0; m < n; m++) ignite[m] = -BURN_HEAD_S + (reach[m]! / far) * (BURN_SPREAD_S + BURN_HEAD_S);
  return (field = { x0, z0, cell: BURN_CELL, w, h, ignite, fuel });
}

const smooth = (x: number): number => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/** Seconds a spot burns at its height before what feeds it runs low, and seconds it takes to sink to what is left. */
export const BURN_HOLD_S = 28;
export const BURN_FADE_S = 55;
export const BURN_PEAK = 1.25;
/** What a burnt-out spot keeps: bare floor a low fire over its coals, real fuel (`fuel` > 1) nearly all of it. */
export const burnSettle = (fuel: number): number => Math.min(0.95, 0.38 + (fuel - 1) * 1.1);
/**
 * How hard a spot that caught `age` seconds ago burns (before its fuel's own weight): up to
 * `BURN_PEAK` as it gets going, then — a fire eats what it stands on — down to `burnSettle`.
 * So a room that has burnt for minutes is not one even wall of flame: the edge and the furniture
 * burn high, the floor behind them low over its coals. (fireFx.ts repeats this in its shaders.)
 */
export function burnPower(age: number, fuel = 1): number {
  const settle = burnSettle(fuel);
  return smooth(age / BURN_GROW_S) * (settle + (BURN_PEAK - settle) * (1 - smooth((age - BURN_HOLD_S) / BURN_FADE_S)));
}

/** How hard the big fire burns at (x, z) `time` seconds into the drill (0 outside the burning room). */
export function burnAt(x: number, z: number, time: number): number {
  const f = burnField();
  const i = Math.floor((x - f.x0) / f.cell), j = Math.floor((z - f.z0) / f.cell);
  if (i < 0 || j < 0 || i >= f.w || j >= f.h) return 0;
  const k = j * f.w + i;
  return f.fuel[k]! * burnPower(time - f.ignite[k]!, f.fuel[k]);
}

/** The whole fire at `time`: how much of the room burns (0 → 1) and the middle of what burns (absolute x, z). */
export function blaze(time: number, out: { level: number; x: number; z: number } = { level: 0, x: 0, z: 0 }): { level: number; x: number; z: number } {
  const f = burnField();
  let sum = 0, sx = 0, sz = 0, count = 0;
  for (let j = 1; j < f.h; j += 3) for (let i = 1; i < f.w; i += 3) {
    const p = smooth((time - f.ignite[j * f.w + i]!) / BURN_GROW_S); // how much has CAUGHT: it never goes back
    sum += p; sx += p * (f.x0 + (i + 0.5) * f.cell); sz += p * (f.z0 + (j + 0.5) * f.cell);
    count++;
  }
  out.level = sum / count;
  if (sum > 0) { out.x = sx / sum; out.z = sz / sum; }
  return out;
}

/** The waste-bin fire is small only for so long: its size grows from `BIN_CALM_S` on, up to this many times. */
export const BIN_CALM_S = 30;
export const BIN_GROWTH = 1.6;
export function binSize(time: number): number {
  return 1 + (BIN_GROWTH - 1) * smooth((time - BIN_CALM_S) / 150);
}
/** A fire that is not being sprayed flares up again: strength regained per second. */
export const REKINDLE = 0.05;

/**
 * Where the smoke goes. The storey is cut into cells; smoke starts over whatever burns and moves
 * from cell to cell ONLY where nothing solid is between them — so it goes round furniture, stays
 * behind walls and pours through doorways, like a smoke grenade's cloud. It is hot: it climbs
 * fast, runs along under the ceiling, and only then thickens downward. `arrive` is when it gets
 * to each cell (seconds on the drill's clock), worked out once from the map; what is drawn and
 * what is breathed read it.
 */
export interface SmokeField {
  /** Cell size (m) and how many cells smoke ever reaches. */
  cell: number;
  count: number;
  /** Each cell's centre (absolute x, y, z). */
  at: Float32Array;
  /** When smoke reaches it. */
  arrive: Float32Array;
  /** 1: in the burning room (it fills to the floor); 0: elsewhere (it hangs as a layer, see `smokeFloorAt`). */
  room: Uint8Array;
  /** The whole grid, for the volume drawn from it: its low corner (absolute), its size in cells, and when smoke reaches each cell (x fastest, then y, then z; Infinity: never). */
  min: [number, number, number];
  nx: number; ny: number; nz: number;
  grid: Float32Array;
}
export const SMOKE_CELL = 0.5;
/**
 * Seconds per metre: up, level right under the ceiling (slower the lower it is), and down.
 * Slower than a real ceiling jet on purpose: at a real one's metre a second the whole storey had
 * smoke before the drill's first step — the cloud has to be SEEN leaving the fire and coming.
 */
export const SMOKE_PACE = { up: 0.8, level: 2.4, lower: 1.6, down: 14 } as const;
/** Smoke starts this long after the floor under it catches (a fire smokes once it burns). */
export const SMOKE_START_S = 6;
/** Smoke that would take longer than this to arrive is not kept (the far end of the building). */
const SMOKE_LIMIT_S = 420;

let smoke: SmokeField | null = null;
export function smokeField(): SmokeField {
  if (smoke) return smoke;
  const scene = school3d(), school = fireSchool(), burn = burnField();
  const floor = school.heat[1], ceiling = school.corridor[4];
  const x0 = Math.min(school.heat[0], school.corridor[0]), x1 = Math.min(school.corridor[3], school.retry[0] + 16);
  const z0 = Math.min(school.heat[2], school.classroom[2]), z1 = school.corridor[5];
  const c = SMOKE_CELL, nx = Math.ceil((x1 - x0) / c), ny = Math.max(1, Math.floor((ceiling - floor) / c)), nz = Math.ceil((z1 - z0) / c);
  const n = nx * ny * nz, id = (i: number, j: number, k: number): number => (k * ny + j) * nx + i;
  // cells hang from the ceiling: the top row is right under it, wherever the floor is
  const cx = (i: number): number => x0 + (i + 0.5) * c, cy = (j: number): number => ceiling - (ny - j - 0.5) * c, cz = (k: number): number => z0 + (k + 0.5) * c;
  const open = new Uint8Array(n);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = cx(i), y = cy(j), z = cz(k);
    if (!scene.intersects([x - 0.06, y - 0.06, z - 0.06], [x + 0.06, y + 0.06, z + 0.06])) open[id(i, j, k)] = 1;
  }
  // smoke starts just over what burns, when it catches
  const time = new Float32Array(n).fill(Infinity);
  const heap: number[] = []; // a binary heap of cell ids by time
  const push = (m: number): void => {
    heap.push(m);
    for (let a = heap.length - 1; a > 0;) {
      const up = (a - 1) >> 1;
      if (time[heap[up]!]! <= time[heap[a]!]!) break;
      [heap[up], heap[a]] = [heap[a]!, heap[up]!];
      a = up;
    }
  };
  const pop = (): number => {
    const top = heap[0]!, last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let a = 0; ;) {
        const l = a * 2 + 1, r = l + 1;
        let least = a;
        if (l < heap.length && time[heap[l]!]! < time[heap[least]!]!) least = l;
        if (r < heap.length && time[heap[r]!]! < time[heap[least]!]!) least = r;
        if (least === a) break;
        [heap[least], heap[a]] = [heap[a]!, heap[least]!];
        a = least;
      }
    }
    return top;
  };
  const inRoom = (x: number, z: number): boolean => x >= school.heat[0] && x < school.heat[3] && z >= school.heat[2] && z < school.heat[5];
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const x = cx(i), z = cz(k);
    if (!inRoom(x, z)) continue;
    for (let j = 0; j < ny; j++) {
      const m = id(i, j, k);
      if (!open[m]) continue;
      const bi = Math.min(burn.w - 1, Math.max(0, Math.floor((x - burn.x0) / burn.cell))), bk = Math.min(burn.h - 1, Math.max(0, Math.floor((z - burn.z0) / burn.cell)));
      time[m] = burn.ignite[bk * burn.w + bi]! + SMOKE_START_S;
      push(m);
      break; // the lowest open cell of the column: the fire is under it
    }
  }
  const settled = new Uint8Array(n);
  const steps: readonly (readonly [number, number, number])[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  while (heap.length > 0) {
    const m = pop();
    if (settled[m]) continue;
    settled[m] = 1;
    const i = m % nx, j = Math.floor(m / nx) % ny, k = Math.floor(m / (nx * ny)), now = time[m]!;
    if (now > SMOKE_LIMIT_S) break;
    for (const [di, dj, dk] of steps) {
      const a = i + di, b = j + dj, e = k + dk;
      if (a < 0 || b < 0 || e < 0 || a >= nx || b >= ny || e >= nz) continue;
      const to = id(a, b, e);
      if (!open[to] || settled[to]) continue;
      // under the ceiling it runs; lower down it creeps; it sinks only as the layer above fills
      const under = (ny - 1 - Math.max(j, b)) * c;
      const pace = dj > 0 ? SMOKE_PACE.up : dj < 0 ? SMOKE_PACE.down : SMOKE_PACE.level + SMOKE_PACE.lower * under;
      const t = now + pace * c;
      if (t >= time[to]!) continue;
      // nothing solid between the two cells: a wall thinner than a cell still stops it
      if (scene.raycast([cx(i), cy(j), cz(k)], [di, dj, dk], c)) continue;
      time[to] = t;
      push(to);
    }
  }
  const kept: number[] = [];
  for (let m = 0; m < n; m++) if (settled[m] && time[m]! <= SMOKE_LIMIT_S) kept.push(m);
  const at = new Float32Array(kept.length * 3), arrive = new Float32Array(kept.length), room = new Uint8Array(kept.length);
  kept.forEach((m, q) => {
    const i = m % nx, j = Math.floor(m / nx) % ny, k = Math.floor(m / (nx * ny));
    at.set([cx(i), cy(j), cz(k)], q * 3);
    arrive[q] = time[m]!;
    room[q] = inRoom(cx(i), cz(k)) ? 1 : 0;
  });
  const grid = new Float32Array(n).fill(Infinity);
  for (const m of kept) grid[m] = time[m]!;
  return (smoke = { cell: c, count: kept.length, at, arrive, room, min: [x0, ceiling - ny * c, z0], nx, ny, nz, grid });
}

/**
 * When the smoke gets to the ceiling over (x, z) — Infinity where it never does. The breath
 * rules ask this: smoke that has not come yet costs nothing, however far the drill has got.
 */
export function smokeOverhead(x: number, z: number): number {
  const f = smokeField();
  const i = Math.floor((x - f.min[0]) / f.cell), k = Math.floor((z - f.min[2]) / f.cell);
  if (i < 0 || k < 0 || i >= f.nx || k >= f.nz) return Infinity;
  let first = Infinity;
  for (let j = f.ny - 1; j >= Math.max(0, f.ny - 3); j--) first = Math.min(first, f.grid[(k * f.ny + j) * f.nx + i]!);
  return first;
}

/** How many times faster the smoke's clock runs while it is catching up with the escape. */
export const SMOKE_HURRY = 10;
let smokeNeed = -1;
/** The smoke clock by which the whole way from our classroom to the stairs has smoke over it. */
export function smokeOverRoute(): number {
  if (smokeNeed >= 0) return smokeNeed;
  const school = fireSchool(), z = (school.corridor[2] + school.corridor[5]) / 2;
  const to = Math.max(school.retry[0], school.escapeRoute[0]?.[0] ?? school.retry[0]) + 1.5;
  let need = 0;
  for (let x = school.classroom[0]; x <= to; x += SMOKE_CELL) { const t = smokeOverhead(x, z); if (Number.isFinite(t)) need = Math.max(need, t); }
  return (smokeNeed = need + 12); // …and has had time to thicken
}

/** How far the smoke has sunk and spread, 0 → 1 over a minute and a half of filling the corridor. */
const smokeSpread = (d: Drill): number => smooth(d.smokeAge / 90);
/**
 * Where the corridor's smoke hangs down to (absolute y). It starts just under a standing child's
 * eyes and sinks — but never to a crawling child's: low is always the way through.
 */
export function smokeFloorAt(d: Drill): number {
  return fireSchool().smokeFloor + 0.2 - 0.35 * smokeSpread(d);
}
/** The thick smoke's front (absolute x): it creeps east from the west end, and stops short of the classrooms. */
export const THICK_CREEP = 7;
export function thickFrontAt(d: Drill): number {
  return fireSchool().thickWest + THICK_CREEP * smokeSpread(d);
}

/** What using a station did. `panel-*`: its lesson opens first (finish it with `panelDone`). */
export type Used =
  | "alarm" // the bell rings
  | "panel-call" // dial 119
  | "panel-pass" // learn the extinguisher
  | "grab" // extinguisher in hand (already trained)
  | "towel" // wet towel over the face
  | "info" // just what it is
  | "later" // its turn comes later
  | "already"; // done before

/** The step a station belongs to (for "that comes later" and for the guide's target). */
export const STATION_STEP: Record<FireStationKind, DrillStep | null> = {
  alarm: "alarm", phone: "call", extinguisher: "grab", towel: "towel", sign: null,
};

/** With the towel already taken, its step is passed at once. */
function settle(d: Drill): void {
  if (d.step === "towel" && d.towel) d.step = "escape";
}

export function useStation(d: Drill, kind: FireStationKind): Used {
  if (d.step === "done") return "info";
  switch (kind) {
    case "sign":
      return "info";
    case "alarm":
      if (d.alarm) return "already";
      d.alarm = true;
      if (d.step === "alarm") d.step = "call";
      return "alarm";
    case "phone":
      if (d.step === "call") return "panel-call";
      return reached(d, "grab") ? "already" : "later";
    case "extinguisher":
      if (d.step === "grab") return d.trained ? takeExtinguisher(d) : "panel-pass";
      // ran dry before the fire was out: a fresh one
      if (d.step === "spray" && !d.extinguisher) return takeExtinguisher(d);
      if (d.step === "spray") return "already";
      return reached(d, "towel") ? "already" : "later";
    case "towel":
      if (d.towel) return "already";
      d.towel = true; // taking it early is fine: it is never wrong to have one
      settle(d);
      return "towel";
  }
}

function takeExtinguisher(d: Drill): Used {
  d.extinguisher = true;
  d.charge = 1;
  if (d.step === "grab") d.step = "spray";
  return "grab";
}

/** A station's lesson was completed. */
export function panelDone(d: Drill, panel: "call" | "pass"): void {
  if (panel === "call" && d.step === "call") d.step = "grab";
  if (panel === "pass" && d.step === "grab") {
    d.trained = true;
    takeExtinguisher(d);
  }
}

export interface DrillEnv {
  /** Feet. */
  x: number; y: number; z: number;
  /** Eye height (absolute y): what the smoke is measured against. */
  eyeY: number;
  /** The spray button is held. */
  spraying: boolean;
  /** The spray ray from the nozzle (or the eye before the first held frame). */
  ox: number; oy: number; oz: number; dx: number; dy: number; dz: number;
  sprayLimit?: number;
}

export type DrillEvent =
  | "spray" // the extinguisher is spraying this tick
  | "hit" // …and it is on the fire's base
  | "aim-low" // …on the flames, not the base
  | "too-far" // …aimed right but from too far
  | "empty" // the extinguisher ran out
  | "fire-out"
  | "smoke" // breathing smoke upright
  | "need-towel" // low, but nothing over the face
  | "thick" // the west end: too much smoke whatever you do
  | "heat" // in the burning room
  | "fainted" // out of breath: back to the retry point
  | "early" // outside before the drill got there
  | "outside" // out through the exit, in turn
  | "done";

/** One tick. Returns what happened (the glue paces toasts and sounds) and how fast breath is going. */
export function tickDrill(d: Drill, dt: number, env: DrillEnv): { events: DrillEvent[]; drain: number } {
  const events: DrillEvent[] = [];
  if (d.step === "done") return { events, drain: 0 };
  const school = fireSchool();
  d.time += dt;

  // the extinguisher: aim at the BASE of the small fire, from within reach
  if (d.extinguisher && env.spraying) {
    events.push("spray");
    d.charge = Math.max(0, d.charge - dt / CHARGE_S);
    const fire = school.fires.find((f) => f.small)!;
    if (d.fire > 0) {
      const base = rayMiss(env, fire.at[0], fire.at[1], fire.at[2]);
      const flame = rayMiss(env, fire.at[0], fire.at[1] + 0.9 * fire.size, fire.at[2]);
      if (base.along > 0 && base.miss <= BASE_RADIUS) {
        if (base.along > SPRAY_REACH) events.push("too-far");
        else if (base.along <= (env.sprayLimit ?? Infinity) + .20) { d.fire -= dt / (EXTINGUISH_S * binSize(d.time)); events.push("hit"); }
      } else if (flame.along > 0 && flame.along <= SPRAY_REACH && flame.along <= (env.sprayLimit ?? Infinity) + .20 && flame.miss <= FLAME_RADIUS) {
        d.fire -= (dt / EXTINGUISH_S) * 0.25; // the flames only: it barely helps
        events.push("aim-low");
      }
      if (d.fire <= 0) {
        d.fire = 0;
        d.extinguisher = false; // set down: the big fire is not ours to fight
        d.smokeIn = SMOKE_GRACE_S;
        if (d.step === "spray") { d.step = "towel"; settle(d); }
        events.push("fire-out");
      }
    }
    if (d.extinguisher && d.charge <= 0) {
      d.extinguisher = false;
      events.push("empty");
    }
  }

  // a fire nobody is spraying flares up again
  if (d.fire > 0 && d.fire < 1 && !events.includes("hit") && !events.includes("aim-low")) d.fire = Math.min(1, d.fire + REKINDLE * dt);

  // smoke and heat
  let drain = 0;
  if (smokeOn(d)) d.smokeAge += dt;
  d.smokeClock = Math.max(d.smokeClock, d.time - dt) + dt * (smokeOn(d) && d.smokeClock < smokeOverRoute() ? SMOKE_HURRY : 1);
  const bodyY = env.y + 0.1;
  d.smokeIn = Math.max(0, d.smokeIn - dt);
  if (inFireZone(school.heat, env.x, bodyY, env.z)) {
    drain = DRAIN.heat;
    events.push("heat");
  } else if (smokeOn(d) && d.smokeIn <= 0 && inFireZone(school.corridor, env.x, bodyY, env.z) && d.smokeClock >= smokeOverhead(env.x, env.z)) {
    // (only where the smoke has COME: it leaves the fire and travels — see smokeField — and what is drawn is what is breathed)
    const upright = env.eyeY >= smokeFloorAt(d);
    if (env.x < thickFrontAt(d)) { drain = DRAIN.thick; events.push("thick"); }
    else if (upright) { drain = d.towel ? DRAIN.uprightTowel : DRAIN.upright; events.push("smoke"); }
    else if (!d.towel) { drain = DRAIN.lowBare; events.push("need-towel"); }
  }
  if (drain > 0) {
    d.air -= drain * dt;
    d.smokeTime += dt;
    if (d.air <= 0) {
      d.air = 1;
      d.mistakes++;
      events.push("fainted");
    }
  } else d.air = Math.min(1, d.air + 0.2 * dt);

  // the way out, then the gathering place
  const outside = inFireZone(school.exitZone,env.x,env.y,env.z)||
    (env.z>=school.exitZone[5]&&env.y<school.exitZone[4]&&Math.abs(env.x)<5);
  if (outside && d.step === "escape") { d.step = "assemble"; events.push("outside"); }
  else if (outside && !reached(d, "escape")) events.push("early");
  if (d.step === "assemble" && Math.hypot(env.x - school.assembly.x, env.z - school.assembly.z) <= school.assembly.r) {
    d.step = "done";
    events.push("done");
  }
  return { events, drain };
}

/** How far along the ray the point's closest approach is, and how far the ray passes from it. */
function rayMiss(env: DrillEnv, px: number, py: number, pz: number): { along: number; miss: number } {
  const vx = px - env.ox, vy = py - env.oy, vz = pz - env.oz;
  const along = vx * env.dx + vy * env.dy + vz * env.dz;
  return { along, miss: Math.hypot(vx - along * env.dx, vy - along * env.dy, vz - along * env.dz) };
}

/** Three stars: never overcome by smoke and hardly any breathed. */
export function drillStars(d: Drill): 1 | 2 | 3 {
  if (d.mistakes === 0 && d.smokeTime < 6) return 3;
  if (d.mistakes <= 1 && d.smokeTime < 15) return 2;
  return 1;
}

/** Does a look ray cross a station's box, and how far along? Null: it misses or is out of reach. */
export function rayBox(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  box: readonly [number, number, number, number, number, number], reach: number,
): number | null {
  let t0 = 0, t1 = reach;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]!) < 1e-9) {
      if (o[i]! < box[i]! || o[i]! > box[i + 3]!) return null;
      continue;
    }
    let a = (box[i]! - o[i]!) / d[i]!, b = (box[i + 3]! - o[i]!) / d[i]!;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0;
}
