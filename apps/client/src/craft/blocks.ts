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
  /** Korean display name (the default UI language); `name` is the English one. */
  ko: string;
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
  /** Draw through this brick (glass, ice). It still collides. */
  seeThrough?: boolean;
  /** A liquid: not a brick at all. Drawn by the water mesh, walked and aimed
   *  through, and placed from an endless "bucket" (see @robo/shared fluid). */
  fluid?: boolean;
}

export const AIR = 0;

export const BLOCKS: BlockDef[] = [
  { id: 1, key: "grass", name: "Grass", ko: "잔디", texture: "grass-top", color: "#5cbe4a", hardness: 0.4, drops: "dirt" },
  { id: 2, key: "dirt", name: "Dirt", ko: "흙", texture: "dirt", color: "#9c6b3f", hardness: 0.35 },
  { id: 3, key: "stone", name: "Stone", ko: "돌", texture: "stone", color: "#9aa0a8", hardness: 0.8 },
  { id: 4, key: "sand", name: "Sand", ko: "모래", texture: "sand", color: "#ecd9a0", hardness: 0.3 },
  { id: 5, key: "oak-log", name: "Oak Log", ko: "통나무", texture: "oak-log", color: "#7a5230", hardness: 0.6 },
  { id: 6, key: "oak-leaves", name: "Leaves", ko: "나뭇잎", texture: "oak-leaves", color: "#57b23f", hardness: 0.15, noStud: true },
  { id: 7, key: "coal-ore", name: "Coal Ore", ko: "석탄 광석", texture: "coal-ore", color: "#5c6066", hardness: 1.1 },
  { id: 8, key: "iron-ore", name: "Iron Ore", ko: "철 광석", texture: "iron-ore", color: "#c2a488", hardness: 1.4 },
  { id: 9, key: "gold-ore", name: "Gold Ore", ko: "금 광석", texture: "gold-ore", color: "#d8b64a", hardness: 1.4 },
  { id: 10, key: "diamond-ore", name: "Diamond Ore", ko: "다이아몬드 광석", texture: "diamond-ore", color: "#6fd6cf", hardness: 1.8 },
  { id: 11, key: "bedrock", name: "Bedrock", ko: "기반암", texture: "bedrock", color: "#4a4d54", hardness: 0 },
  { id: 12, key: "oak-planks", name: "Oak Planks", ko: "나무 판자", texture: "oak-planks", color: "#c08a4a", hardness: 0.5 },
  { id: 13, key: "stone-bricks", name: "Stone Bricks", ko: "돌 벽돌", texture: "stone-bricks", color: "#b8bcc2", hardness: 0.9 },
  { id: 14, key: "glass", name: "Glass", ko: "유리", texture: "glass", color: "#bfe8ff", hardness: 0.2, noStud: true, seeThrough: true },
  { id: 15, key: "glowstone", name: "Glowstone", ko: "빛나는 돌", texture: "glowstone", color: "#ffcf57", hardness: 0.4, emissive: true },
  { id: 16, key: "iron-block", name: "Iron Block", ko: "철 블록", texture: "iron-block", color: "#d8dce0", hardness: 1.2 },
  { id: 17, key: "gold-block", name: "Gold Block", ko: "금 블록", texture: "gold-block", color: "#ffd21c", hardness: 1.2 },
  { id: 18, key: "diamond-block", name: "Diamond Block", ko: "다이아몬드 블록", texture: "diamond-block", color: "#5fe0d8", hardness: 1.6 },
  // 19 is a water SOURCE; 20‒27 (flowing levels, falling) are its states and
  // have no row of their own — they are never items (see @robo/shared fluid)
  { id: WATER, key: "water", name: "Water", ko: "물", texture: "water", color: "#3d8fe0", hardness: 0, fluid: true, noStud: true },
  // 29+ solids. Ids 20–28 stay water states. Append only — never insert.
  { id: 29, key: "white-wool", name: "White Wool", ko: "하얀 양털", texture: "white-wool", color: "#f2f2f2", hardness: 0.35 },
  { id: 30, key: "orange-wool", name: "Orange Wool", ko: "주황 양털", texture: "orange-wool", color: "#f09030", hardness: 0.35 },
  { id: 31, key: "yellow-wool", name: "Yellow Wool", ko: "노란 양털", texture: "yellow-wool", color: "#ffe14a", hardness: 0.35 },
  { id: 32, key: "green-wool", name: "Green Wool", ko: "초록 양털", texture: "green-wool", color: "#3cba4a", hardness: 0.35 },
  { id: 33, key: "red-wool", name: "Red Wool", ko: "빨간 양털", texture: "red-wool", color: "#e23d3d", hardness: 0.35 },
  { id: 34, key: "blue-wool", name: "Blue Wool", ko: "파란 양털", texture: "blue-wool", color: "#3d78ef", hardness: 0.35 },
  { id: 35, key: "purple-wool", name: "Purple Wool", ko: "보라 양털", texture: "purple-wool", color: "#8a46d0", hardness: 0.35 },
  { id: 36, key: "pink-wool", name: "Pink Wool", ko: "분홍 양털", texture: "pink-wool", color: "#f48cb4", hardness: 0.35 },
  { id: 37, key: "black-wool", name: "Black Wool", ko: "검은 양털", texture: "black-wool", color: "#2c2c30", hardness: 0.35 },
  { id: 38, key: "cobblestone", name: "Cobblestone", ko: "조약돌", texture: "cobblestone", color: "#8e949c", hardness: 0.85 },
  { id: 39, key: "mossy-cobblestone", name: "Mossy Cobblestone", ko: "이끼 조약돌", texture: "mossy-cobblestone", color: "#6d8a5c", hardness: 0.8 },
  { id: 40, key: "red-bricks", name: "Red Bricks", ko: "붉은 벽돌", texture: "red-bricks", color: "#c45448", hardness: 0.9 },
  { id: 41, key: "sandstone", name: "Sandstone", ko: "사암", texture: "sandstone", color: "#e6d2a4", hardness: 0.6 },
  { id: 42, key: "clay", name: "Clay", ko: "점토", texture: "clay", color: "#a4a8b4", hardness: 0.4 },
  { id: 43, key: "terracotta", name: "Terracotta", ko: "테라코타", texture: "terracotta", color: "#c46a45", hardness: 0.7 },
  { id: 44, key: "gravel", name: "Gravel", ko: "자갈", texture: "gravel", color: "#9a9086", hardness: 0.35 },
  { id: 45, key: "cracked-stone-bricks", name: "Cracked Stone Bricks", ko: "금 간 돌벽돌", texture: "cracked-stone-bricks", color: "#aeb4bc", hardness: 0.85 },
  { id: 46, key: "birch-log", name: "Birch Log", ko: "자작나무", texture: "birch-log", color: "#eadcc4", hardness: 0.6 },
  { id: 47, key: "birch-planks", name: "Birch Planks", ko: "자작 판자", texture: "birch-planks", color: "#f0e2c4", hardness: 0.5 },
  { id: 48, key: "dark-planks", name: "Dark Planks", ko: "어두운 판자", texture: "dark-planks", color: "#6b4a30", hardness: 0.5 },
  { id: 49, key: "bookshelf", name: "Bookshelf", ko: "책장", texture: "bookshelf", color: "#c9a36a", hardness: 0.5 },
  { id: 50, key: "ice", name: "Ice", ko: "얼음", texture: "ice", color: "#d4f0ff", hardness: 0.3, noStud: true, seeThrough: true },
  { id: 51, key: "snow", name: "Snow", ko: "눈", texture: "snow", color: "#f7fbff", hardness: 0.2 },
  { id: 52, key: "obsidian", name: "Obsidian", ko: "흑요석", texture: "obsidian", color: "#24182f", hardness: 2.2 },
  { id: 53, key: "red-sand", name: "Red Sand", ko: "붉은 모래", texture: "red-sand", color: "#e0a06a", hardness: 0.3 },
  { id: 54, key: "hay", name: "Hay", ko: "건초", texture: "hay", color: "#e6c04a", hardness: 0.3 },
  { id: 55, key: "sponge", name: "Sponge", ko: "스펀지", texture: "sponge", color: "#e6d24a", hardness: 0.4 },
  { id: 56, key: "emerald-ore", name: "Emerald Ore", ko: "에메랄드 광석", texture: "emerald-ore", color: "#3ecf7a", hardness: 1.4 },
  { id: 57, key: "lapis-ore", name: "Lapis Ore", ko: "청금석 광석", texture: "lapis-ore", color: "#3a5ad4", hardness: 1.4 },
  { id: 58, key: "ruby-ore", name: "Ruby Ore", ko: "루비 광석", texture: "ruby-ore", color: "#d43a4a", hardness: 1.6 },
  // Decorative tiles that already lived in the texture set. Append only.
  { id: 59, key: "flower-grass", name: "Flower Grass", ko: "꽃밭", texture: "flower-grass", color: "#5cbe4a", hardness: 0.4 },
  { id: 60, key: "dark-leaves", name: "Dark Leaves", ko: "짙은 나뭇잎", texture: "dark-leaves", color: "#1f7a32", hardness: 0.15, noStud: true },
  { id: 61, key: "brown-mushroom", name: "Brown Mushroom", ko: "갈색 버섯", texture: "brown-mushroom-block", color: "#a56a3a", hardness: 0.35 },
  { id: 62, key: "red-mushroom", name: "Red Mushroom", ko: "빨간 버섯", texture: "red-mushroom-block", color: "#d23a3a", hardness: 0.35 },
  { id: 63, key: "question-block", name: "Question Block", ko: "물음표 블록", texture: "question-block", color: "#f0c21a", hardness: 0.5 },
];

/** A block the player can hold and place. Not air, bedrock, or water. */
export function isPlaceableItem(def: BlockDef): boolean {
  return def.fluid !== true && def.hardness > 0;
}

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
