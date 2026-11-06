/**
 * Power-plant construction (science mode, T): pure rules, no three.js and no DOM.
 *
 * A plant is a SITE: a blueprint laid on the ground at an ABSOLUTE anchor (field coordinates, like
 * furniture and edits, so a field scroll never touches it) with a quarter-turn rotation. Every cell
 * of the blueprint is an ITEM SOCKET: FRAME sockets (뼈대 — foundation, tower, nacelle) take frame
 * pieces and are filled from the underbody up, one layer after the other; PART sockets (generator,
 * blades, wire terminal) take the working parts once the whole frame stands. What a site stores is
 * which sockets are filled and whether it is switched on.
 *
 * A plant runs only when every socket is filled. There is no losing: a missing piece just holds it
 * at "building" / "parts" and says what comes next.
 */
import { z } from "zod";
import type { PartKey } from "./parts.js";
import type { FrameKey } from "./frames.js";

export type PlantKind = "wind";
export const PLANT_KINDS: readonly PlantKind[] = ["wind"];

export type SocketItem = FrameKey | PartKey;
export type SocketKind = "frame" | "part";

/** One socket, relative to the anchor at rotation 0 (+z is the plant's front). A socket may span
 *  several cells: `size` [w, h, d] grows it from its (dx, dy, dz) cell toward +x, +y, +z. */
export interface BlueprintSocket {
  dx: number;
  dy: number;
  dz: number;
  item: SocketItem;
  kind: SocketKind;
  size?: readonly [number, number, number];
}

export interface Blueprint {
  kind: PlantKind;
  name: string;
  ko: string;
  icon: string;
  /** Frame sockets first (bottom-up), then part sockets. */
  sockets: readonly BlueprintSocket[];
  /** The energy chain shown while it runs (source → … → village). */
  chain: readonly string[];
  chainEn: readonly string[];
}

function windTurbine(): BlueprintSocket[] {
  const s: BlueprintSocket[] = [];
  const frame = (dx: number, dy: number, dz: number, item: FrameKey, size?: [number, number, number]) => s.push({ dx, dy, dz, item, kind: "frame", ...(size ? { size } : {}) });
  // underbody: a 3×3 foundation, its centre holding the tower's anchor ring
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) frame(dx, 0, dz, dx === 0 && dz === 0 ? "frame-foundation-center" : "frame-foundation");
  // the tower: a two-storey base (its door is the robot's height), three sections, the turntable top
  frame(0, 1, 0, "frame-tower-base", [1, 2, 1]);
  for (let dy = 3; dy <= 5; dy++) frame(0, dy, 0, "frame-tower");
  frame(0, 6, 0, "frame-tower-top");
  // the head: the nacelle housing at the back, the hub in front; the two-cell generator goes between
  frame(0, 7, -2, "frame-nacelle-tail");
  frame(0, 7, 1, "frame-hub");
  // the working parts
  s.push({ dx: 0, dy: 7, dz: -1, item: "part-generator", kind: "part", size: [1, 1, 2] }); // in the nacelle, over the tower
  s.push({ dx: 0, dy: 7, dz: 2, item: "part-blades", kind: "part" }); // on the front of the hub
  s.push({ dx: 1, dy: 1, dz: 0, item: "part-wire-terminal", kind: "part" }); // at the tower's foot
  return s;
}

export const BLUEPRINTS: Readonly<Record<PlantKind, Blueprint>> = {
  wind: {
    kind: "wind",
    name: "Wind turbine",
    ko: "풍력 발전기",
    icon: "🌬️",
    sockets: windTurbine(),
    chain: ["바람", "날개", "발전기", "전선 단자", "마을"],
    chainEn: ["Wind", "Blades", "Generator", "Terminal", "Village"],
  },
};

/** A laid-out blueprint. `x, y, z` = the foundation's centre cell, absolute. */
export interface PlantSite {
  id: number;
  kind: PlantKind;
  x: number;
  y: number;
  z: number;
  /** Quarter turns (0–3) clockwise seen from above. */
  rot: number;
  /** Filled sockets: bit i = socket i holds its item. */
  filled: number;
  /** Switched on. It RUNS only while every socket is filled. */
  on: boolean;
}

type Placement = Pick<PlantSite, "kind" | "x" | "y" | "z" | "rot">;

export interface SiteSocket {
  /** Its first cell (the blueprint's dx, dy, dz turned), absolute. */
  x: number;
  y: number;
  z: number;
  /** Every cell it covers, absolute (one for most sockets). */
  cells: ReadonlyArray<{ x: number; y: number; z: number }>;
  /** The middle of what it covers (where the item's model is centred), absolute, in cell units. */
  cx: number;
  cy: number;
  cz: number;
  /** Layer above the foundation (0 = underbody). */
  dy: number;
  index: number;
  item: SocketItem;
  kind: SocketKind;
}

/** A relative (dx, dz) turned by `rot` quarter turns. */
export function turn(dx: number, dz: number, rot: number): [number, number] {
  switch (((rot % 4) + 4) % 4) {
    case 1: return [0 - dz, dx]; // 0 - v, never -v: no -0 in keys or saves
    case 2: return [0 - dx, 0 - dz];
    case 3: return [dz, 0 - dx];
    default: return [dx, dz];
  }
}

/** Every socket of a site, absolute, in blueprint order. */
export function siteSockets(site: Placement): SiteSocket[] {
  return BLUEPRINTS[site.kind].sockets.map((s, index) => {
    const [w, h, d] = s.size ?? [1, 1, 1];
    const cells: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) for (let k = 0; k < d; k++) {
      const [tx, tz] = turn(s.dx + i, s.dz + k, site.rot);
      cells.push({ x: site.x + tx, y: site.y + s.dy + j, z: site.z + tz });
    }
    const [dx, dz] = turn(s.dx, s.dz, site.rot);
    const mid = (f: (c: { x: number; y: number; z: number }) => number) => cells.reduce((n, c) => n + f(c), 0) / cells.length + 0.5;
    return {
      x: site.x + dx, y: site.y + s.dy, z: site.z + dz, cells,
      cx: mid((c) => c.x), cy: mid((c) => c.y), cz: mid((c) => c.z),
      dy: s.dy, index, item: s.item, kind: s.kind,
    };
  });
}

export function isFilled(site: Pick<PlantSite, "filled">, index: number): boolean {
  return (site.filled & (1 << index)) !== 0;
}

/** Bitmask of every socket of a kind ("frame" / "part") or of all of them. */
export function socketMask(kind: PlantKind, of?: SocketKind): number {
  let m = 0;
  BLUEPRINTS[kind].sockets.forEach((s, i) => {
    if (!of || s.kind === of) m |= 1 << i;
  });
  return m;
}

export type BuildState = "building" | "built";

export interface Progress {
  filled: number;
  total: number;
  /** 0–100 of the FRAME, rounded down: 100 only when every frame socket is filled. */
  pct: number;
  state: BuildState;
  /** Frame item → how many sockets still want it. */
  missing: Partial<Record<SocketItem, number>>;
  /** The lowest layer with an empty frame socket (where building continues), or null. */
  layer: number | null;
}

/** How far the frame is: counted from the filled bits. */
export function plantProgress(site: PlantSite): Progress {
  let filled = 0;
  let total = 0;
  let layer: number | null = null;
  const missing: Partial<Record<SocketItem, number>> = {};
  BLUEPRINTS[site.kind].sockets.forEach((s, i) => {
    if (s.kind !== "frame") return;
    total++;
    if (isFilled(site, i)) filled++;
    else {
      missing[s.item] = (missing[s.item] ?? 0) + 1;
      if (layer === null || s.dy < layer) layer = s.dy;
    }
  });
  const pct = filled === total ? 100 : Math.floor((filled / total) * 100);
  return { filled, total, pct, state: filled === total ? "built" : "building", missing, layer };
}

/** Parts still missing, in socket order. */
export function missingParts(site: PlantSite): PartKey[] {
  return BLUEPRINTS[site.kind].sockets.flatMap((s, i) => (s.kind === "part" && !isFilled(site, i) ? [s.item as PartKey] : []));
}

/**
 * The states a player sees:
 * - building: the frame is not complete yet
 * - parts: the frame stands, a part is missing (부품 대기)
 * - ready: everything is in, waiting to be switched on (가동 준비)
 * - running: switched on and complete (가동 중)
 * - inspection: switched on, but something has gone missing since (점검 중) — never a failure
 */
export type PlantStatus = "building" | "parts" | "ready" | "running" | "inspection";

export function plantStatus(site: PlantSite): PlantStatus {
  const complete = site.filled === socketMask(site.kind);
  if (site.on) return complete ? "running" : "inspection";
  if ((site.filled & socketMask(site.kind, "frame")) !== socketMask(site.kind, "frame")) return "building";
  return complete ? "ready" : "parts";
}

/** Can socket i take something now? Frames go layer by layer from the underbody; parts after the frame. */
export function socketOpen(site: PlantSite, index: number): boolean {
  const bp = BLUEPRINTS[site.kind];
  const s = bp.sockets[index];
  if (!s || isFilled(site, index)) return false;
  if (s.kind === "part") return plantProgress(site).state === "built";
  return bp.sockets.every((o, i) => o.kind !== "frame" || o.dy >= s.dy || isFilled(site, i));
}

export type FitResult = "ok" | "order" | "frame-first" | "wrong-item" | "filled" | "blocked";

/**
 * Fitting an item into socket i: the socket must still be empty (of items and of blocks), it must
 * be its turn (frames layer by layer from the bottom, parts once the frame stands), and the item
 * must be the socket's own. Returns the new site on success (pure: the caller stores it).
 */
export function fitItem(site: PlantSite, index: number, item: string, cellEmpty: boolean): { result: FitResult; site: PlantSite } {
  const s = BLUEPRINTS[site.kind].sockets[index];
  if (!s) return { result: "wrong-item", site };
  if (isFilled(site, index)) return { result: "filled", site };
  if (!socketOpen(site, index)) return { result: s.kind === "part" ? "frame-first" : "order", site };
  if (s.item !== item) return { result: "wrong-item", site };
  if (!cellEmpty) return { result: "blocked", site };
  return { result: "ok", site: { ...site, filled: site.filled | (1 << index) } };
}

export type TakeOutResult = "ok" | "empty" | "above" | "parts-first";

/**
 * Taking one fitted item back out (held left click): parts come out any time; a frame piece only
 * when nothing fitted rests on a higher layer and no part is in (the parts sit on the frame).
 * A running plant that loses an item stops for a check ("inspection") until it is back.
 */
export function takeOut(site: PlantSite, index: number): { result: TakeOutResult; site: PlantSite } {
  const sockets = BLUEPRINTS[site.kind].sockets;
  const s = sockets[index];
  if (!s || !isFilled(site, index)) return { result: "empty", site };
  if (s.kind === "frame") {
    if (sockets.some((o, i) => i !== index && isFilled(site, i) && o.kind === "part")) return { result: "parts-first", site };
    if (sockets.some((o, i) => i !== index && isFilled(site, i) && o.dy > s.dy)) return { result: "above", site };
  }
  return { result: "ok", site: { ...site, filled: site.filled & ~(1 << index) } };
}

export type SiteProblem = "outside" | "blocked" | "ground" | "overlap" | "player" | null;

/**
 * May a blueprint be laid here? Every socket must be in the world and empty, the foundation must
 * rest on solid ground, it may not overlap another site, and nobody (player, furniture) may be inside.
 */
export function siteProblem(
  site: Placement,
  world: {
    inBounds(x: number, y: number, z: number): boolean;
    blockAt(x: number, y: number, z: number): number;
    isEmpty(id: number): boolean;
    isGround(x: number, y: number, z: number): boolean;
    occupied?(x: number, y: number, z: number): boolean;
  },
  others: readonly PlantSite[],
): SiteProblem {
  const all = siteSockets(site).flatMap((s) => s.cells.map((c) => ({ ...c, dy: c.y - site.y })));
  for (const c of all) if (!world.inBounds(c.x, c.y, c.z)) return "outside";
  const taken = new Set<string>();
  for (const o of others) for (const s of siteSockets(o)) for (const c of s.cells) taken.add(`${c.x},${c.y},${c.z}`);
  for (const c of all) if (taken.has(`${c.x},${c.y},${c.z}`)) return "overlap";
  for (const c of all) if (!world.isEmpty(world.blockAt(c.x, c.y, c.z))) return "blocked";
  for (const c of all) if (c.dy === 0 && !world.isGround(c.x, c.y - 1, c.z)) return "ground";
  for (const c of all) if (world.occupied?.(c.x, c.y, c.z)) return "player";
  return null;
}

/** The site whose sockets include this absolute cell, if any. */
export function siteAt(sites: readonly PlantSite[], x: number, y: number, z: number): PlantSite | null {
  for (const s of sites) for (const k of siteSockets(s)) for (const c of k.cells) if (c.x === x && c.y === y && c.z === z) return s;
  return null;
}

/** The most sites one save keeps (a field is endless; a class of children is not careful). */
export const MAX_PLANTS = 64;

/** [kind, x, y, z, rot, filled, on]. */
const plantRow = z.tuple([z.string(), z.number().int(), z.number().int(), z.number().int(), z.number().int()]).rest(z.number().int());
export const plantSaveSchema = z.array(plantRow).max(MAX_PLANTS);
export type PlantTuple = z.infer<typeof plantRow>;

/** The sites a save lists, minus anything unknown or malformed (one bad row never drops the rest). */
export function loadPlants(raw: unknown): PlantSite[] {
  if (!Array.isArray(raw)) return [];
  const out: PlantSite[] = [];
  for (const row of raw.slice(0, MAX_PLANTS)) {
    const parsed = plantRow.safeParse(row);
    if (!parsed.success) continue;
    const [kind, x, y, zz, rot, filled = 0, on = 0] = parsed.data;
    if (!(PLANT_KINDS as readonly string[]).includes(kind) || rot < 0 || rot > 3) continue;
    const k = kind as PlantKind;
    const all = socketMask(k);
    let bits = filled < 0 ? 0 : filled & all;
    // a filled socket must have had its turn: drop anything resting on an empty layer
    const probe: PlantSite = { id: 0, kind: k, x, y, z: zz, rot, filled: 0, on: false };
    for (let pass = 0; pass < 32; pass++) {
      let changed = false;
      for (let i = 0; i < BLUEPRINTS[k].sockets.length; i++) {
        if (!(bits & (1 << i))) continue;
        const without = { ...probe, filled: bits & ~(1 << i) };
        if (!socketOpen(without, i)) {
          bits &= ~(1 << i);
          changed = true;
        }
      }
      if (!changed) break;
    }
    // switched on means everything was in: a row saying otherwise was edited by hand
    out.push({ id: out.length + 1, kind: k, x, y, z: zz, rot, filled: bits, on: on === 1 && bits === all });
  }
  return out;
}

export function savePlants(sites: readonly PlantSite[]): PlantTuple[] {
  return sites.map((s) => [s.kind, s.x, s.y, s.z, s.rot, s.filled, s.on ? 1 : 0]);
}
