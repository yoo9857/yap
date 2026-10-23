import type { Category, CategoryKey, FurnitureDef } from "../types.js";
import { BATH } from "./bath.js";
import { BEDROOM } from "./bedroom.js";
import { DECOR } from "./decor.js";
import { DOORS } from "./doors.js";
import { KITCHEN } from "./kitchen.js";
import { LIGHTING } from "./lighting.js";
import { LIVING } from "./living.js";
import { OUTDOOR } from "./outdoor.js";

/**
 * The whole catalog, in panel order. Categories hold at most nine pieces each,
 * because the furniture bar is driven by the 1‒9 keys; the catalog test
 * enforces it — a tenth piece means a new category, not a bigger one.
 */
export const CATEGORIES: readonly Category[] = [
  { key: "living", name: "거실", emoji: "🛋️" },
  { key: "bedroom", name: "침실", emoji: "🛏️" },
  { key: "kitchen", name: "주방", emoji: "🍳" },
  { key: "bath", name: "욕실", emoji: "🛁" },
  { key: "lighting", name: "조명", emoji: "💡" },
  { key: "decor", name: "장식", emoji: "🖼️" },
  { key: "doors", name: "문·창", emoji: "🚪" },
  { key: "outdoor", name: "야외", emoji: "🌳" },
];

export const CATALOG: readonly FurnitureDef[] = [
  ...LIVING,
  ...BEDROOM,
  ...KITCHEN,
  ...BATH,
  ...LIGHTING,
  ...DECOR,
  ...DOORS,
  ...OUTDOOR,
];

/** Null-prototype lookup, so "toString" or "__proto__" can never resolve. */
const BY_KEY: Record<string, FurnitureDef> = Object.assign(Object.create(null) as object, Object.fromEntries(CATALOG.map((d) => [d.key, d])));

export const isFurnitureKind = (v: unknown): v is string => typeof v === "string" && BY_KEY[v] !== undefined;

/** The def for a kind. Callers validate with `isFurnitureKind` first; an unknown
 *  key here is a programming error. */
export function furnitureDef(kind: string): FurnitureDef {
  const def = BY_KEY[kind];
  if (!def) throw new Error(`unknown furniture kind: ${kind}`);
  return def;
}

const BY_CATEGORY = new Map<CategoryKey, FurnitureDef[]>(CATEGORIES.map((c) => [c.key, CATALOG.filter((d) => d.category === c.key)]));

export function inCategory(category: CategoryKey): readonly FurnitureDef[] {
  return BY_CATEGORY.get(category) ?? [];
}

/** How many colour variants a kind has (at least 1). */
export const variantCount = (def: FurnitureDef): number => Math.max(1, def.palettes?.length ?? 0);

/** Panel search: by Korean name or key, ignoring spaces. */
export function searchCatalog(query: string): FurnitureDef[] {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return [];
  return CATALOG.filter((d) => d.name.replace(/\s+/g, "").includes(q) || d.key.includes(q));
}
