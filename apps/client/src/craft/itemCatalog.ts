import {BLOCKS, blockByKey, isPlaceableItem, textureUrl} from "./blocks.js";
import {PICKAXE, type HeldItemId} from "./toolDefinitions.js";
import {PARTS, PART_MAX_STACK} from "./science/parts.js";
import {FRAMES, FRAME_MAX_STACK} from "./science/frames.js";

/** Inventory entries do not allocate voxel IDs. Tools can be saved and held,
 * but never passed to world-cell placement or the server's block catalog. */
export interface InventoryItem {
    key: string;
    name: string;
    ko: string;
    icon: string;
    kind: "block" | "tool" | "fluid" | "part";
    /** A part's one line of science (bag detail). */
    note?: string;
    noteEn?: string;
    fluid?: boolean;
    maxStack: number;
}
export const TOOL_ITEMS: readonly InventoryItem[] = [{
    key: PICKAXE.id, name: PICKAXE.nameEn, ko: PICKAXE.name,
    icon: PICKAXE.iconUrl, kind: "tool", maxStack: PICKAXE.inventory.maxStack,
}];
/** Power-plant parts (science mode): carried, fitted into a plant's slots, never placed as blocks. */
export const PART_ITEMS: readonly InventoryItem[] = Object.values(PARTS).map((p) => ({
    key: p.key, name: p.name, ko: p.ko, icon: p.icon, kind: "part", maxStack: PART_MAX_STACK, note: p.note, noteEn: p.noteEn,
}));
/** Power-plant frame pieces (뼈대): fitted into a blueprint's sockets from the bottom up, like parts. */
export const FRAME_ITEMS: readonly InventoryItem[] = Object.values(FRAMES).map((f) => ({
    key: f.key, name: f.name, ko: f.ko, icon: f.icon, kind: "part", maxStack: FRAME_MAX_STACK, note: f.note, noteEn: f.noteEn,
}));
const entries = new Map<string, InventoryItem>([
    ...BLOCKS.filter(def => isPlaceableItem(def) || def.fluid).map(def => [def.key, {
        key: def.key, name: def.name, ko: def.ko, icon: textureUrl(def),
        kind: def.fluid ? "fluid" : "block", fluid: def.fluid, maxStack: 9999,
    }] as [string, InventoryItem]),
    ...TOOL_ITEMS.map(def => [def.key, def] as [string, InventoryItem]),
    ...FRAME_ITEMS.map(def => [def.key, def] as [string, InventoryItem]),
    ...PART_ITEMS.map(def => [def.key, def] as [string, InventoryItem]),
]);
export function itemByKey(key: string): InventoryItem | undefined { return entries.get(key); }
export function itemIcon(item: InventoryItem): string { return item.icon; }
export function inventoryItems(): InventoryItem[] { return [...entries.values()].filter(def => !def.fluid); }
export function toolByKey(key: string): HeldItemId | null { return key === PICKAXE.id ? "pickaxe-basic" : null; }
export function selectedTool(counts: Readonly<Record<string, number>>, hotbar: readonly string[], slot: number, emptyHands = false): HeldItemId | null {
    if (emptyHands || !Number.isInteger(slot) || slot < 0 || slot >= hotbar.length) return null;
    const key = hotbar[slot] ?? "", tool = toolByKey(key);
    const count=counts[key];
    return tool && typeof count==="number" && Number.isFinite(count) && count>=1 ? tool : null;
}
/** One permanent starter tool; existing stacks and hotbar choices are kept. */
export function withStarterTools(counts: Record<string, number>): Record<string, number> {
    const next = {...counts};
    for (const tool of TOOL_ITEMS) if (PICKAXE.inventory.starter) next[tool.key] = Math.min(tool.maxStack, Math.max(1, next[tool.key] ?? 0));
    return next;
}
export function canStoreItem(key: string): boolean {
    const def = itemByKey(key);
    return !!def && !def.fluid && (def.kind === "tool" || def.kind === "part" || isPlaceableItem(blockByKey(key)!));
}
