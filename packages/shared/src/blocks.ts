import { WATER } from "./fluid.js";

/**
 * Player-writable solid block ids. Persisted in worlds and classrooms — never
 * renumber. 1–18 are the original catalog. 19 is the water source (`WATER`,
 * not in this set). 20–28 are fluid states the simulation owns, so a player
 * packet cannot write them. 29–MAX_SOLID_ID are later solids (wools, bricks,
 * woods, decorative blocks). The client catalog must occupy every id in this set and no others.
 */
export const MAX_SOLID_ID = 63;

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let id = from; id <= to; id++) out.push(id);
  return out;
}

export const PLAYER_SOLID_IDS: ReadonlySet<number> = new Set([
  ...range(1, 18),
  ...range(29, MAX_SOLID_ID),
]);

/** Air, the water source, or a catalog solid. Not a flowing/falling/settled state. */
export function isPlayerBlock(id: number): boolean {
  return id === 0 || id === WATER || PLAYER_SOLID_IDS.has(id);
}
