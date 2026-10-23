/**
 * Craft-mode block catalog. Numeric ids index the world's Uint8Array
 * (0 = air); everything else is data-driven so adding a block is one row.
 */

import { WATER, isWater } from "@robo/shared";

export interface BlockDef {
  /** Stable numeric id — persisted in saves, NEVER reorder existing rows. */
  id: number;
  key: string;
  name: string;
  /** Tile from the generated doodle set — used for the 2D HUD/hotbar icons. */
  texture: string;
  /** Solid crayon brick colour for the 3D world (the LEGO/toy-brick look). */
  color: string;
  /** Seconds of mining to break (0 = unbreakable bedrock-style). */
  hardness: number;
  /** What the block yields when mined (defaults to itself). */
  drops?: string;
  emissive?: boolean;
  /** Suppress studs (glass / foliage read cleaner without them). */
  noStud?: boolean;
  /** A liquid: not a brick at all. Drawn by the water mesh, walked and aimed
   *  through, and placed from an endless "bucket" (see @robo/shared fluid). */
  fluid?: boolean;
}

export const AIR = 0;

export const BLOCKS: BlockDef[] = [
  { id: 1, key: "grass", name: "Grass", texture: "grass-top", color: "#5cbe4a", hardness: 0.4, drops: "dirt" },
  { id: 2, key: "dirt", name: "Dirt", texture: "dirt", color: "#9c6b3f", hardness: 0.35 },
  { id: 3, key: "stone", name: "Stone", texture: "stone", color: "#9aa0a8", hardness: 0.8 },
  { id: 4, key: "sand", name: "Sand", texture: "sand", color: "#ecd9a0", hardness: 0.3 },
  { id: 5, key: "oak-log", name: "Oak Log", texture: "oak-log", color: "#7a5230", hardness: 0.6 },
  { id: 6, key: "oak-leaves", name: "Leaves", texture: "oak-leaves", color: "#57b23f", hardness: 0.15, noStud: true },
  { id: 7, key: "coal-ore", name: "Coal Ore", texture: "coal-ore", color: "#5c6066", hardness: 1.1 },
  { id: 8, key: "iron-ore", name: "Iron Ore", texture: "iron-ore", color: "#c2a488", hardness: 1.4 },
  { id: 9, key: "gold-ore", name: "Gold Ore", texture: "gold-ore", color: "#d8b64a", hardness: 1.4 },
  { id: 10, key: "diamond-ore", name: "Diamond Ore", texture: "diamond-ore", color: "#6fd6cf", hardness: 1.8 },
  { id: 11, key: "bedrock", name: "Bedrock", texture: "bedrock", color: "#4a4d54", hardness: 0 },
  { id: 12, key: "oak-planks", name: "Oak Planks", texture: "oak-planks", color: "#c08a4a", hardness: 0.5 },
  { id: 13, key: "stone-bricks", name: "Stone Bricks", texture: "stone-bricks", color: "#b8bcc2", hardness: 0.9 },
  { id: 14, key: "glass", name: "Glass", texture: "glass", color: "#bfe8ff", hardness: 0.2, noStud: true },
  { id: 15, key: "glowstone", name: "Glowstone", texture: "glowstone", color: "#ffcf57", hardness: 0.4, emissive: true },
  { id: 16, key: "iron-block", name: "Iron Block", texture: "iron-block", color: "#d8dce0", hardness: 1.2 },
  { id: 17, key: "gold-block", name: "Gold Block", texture: "gold-block", color: "#ffd21c", hardness: 1.2 },
  { id: 18, key: "diamond-block", name: "Diamond Block", texture: "diamond-block", color: "#5fe0d8", hardness: 1.6 },
  // 19 is a water SOURCE; 20‒27 (flowing levels, falling) are its states and
  // have no row of their own — they are never items (see @robo/shared fluid)
  { id: WATER, key: "water", name: "Water", texture: "water", color: "#3d8fe0", hardness: 0, fluid: true, noStud: true },
];

/**
 * Does this cell id stop bodies, rays and the faces of its neighbours? Air
 * and every water state do not — that one table is what lets physics, aiming,
 * the pet and face culling treat water like air without a special case each.
 */
export const SOLID_ID = new Uint8Array(256);
for (let id = 1; id < 256; id++) SOLID_ID[id] = isWater(id) ? 0 : 1;

const BY_ID = new Map(BLOCKS.map((b) => [b.id, b]));
const BY_KEY = new Map(BLOCKS.map((b) => [b.key, b]));

/** May a cell id be stored in a world (air, a catalog block, or a water state)? */
export const isKnownCell = (id: number): boolean => id === AIR || isWater(id) || BY_ID.has(id);

export function blockById(id: number): BlockDef | undefined {
  return BY_ID.get(id);
}

export function blockByKey(key: string): BlockDef | undefined {
  return BY_KEY.get(key);
}

export function textureUrl(def: BlockDef): string {
  return `/textures/blocks/${def.texture}.png`;
}

/** The mined item's block key (grass drops dirt, ores drop themselves…). */
export function dropOf(def: BlockDef): string {
  return def.drops ?? def.key;
}
