import {BLOCKS, blockByKey, isPlaceableItem, textureUrl} from "./blocks.js";
import {PICKAXE, type HeldItemId} from "./toolDefinitions.js";

/** Inventory entries do not allocate voxel IDs. Tools can be saved and held,
 * but never passed to world-cell placement or the server's block catalog. */
export interface InventoryItem {
    key: string;
    name: string;
    ko: string;
    icon: string;
    kind: "block" | "tool" | "fluid";
    fluid?: boolean;
    maxStack: number;
}
export const TOOL_ITEMS: readonly InventoryItem[] = [{
    key: PICKAXE.id, name: PICKAXE.nameEn, ko: PICKAXE.name,
    icon: PICKAXE.iconUrl, kind: "tool", maxStack: PICKAXE.inventory.maxStack,
}];
const entries = new Map<string, InventoryItem>([
    ...BLOCKS.filter(def => isPlaceableItem(def) || def.fluid).map(def => [def.key, {
        key: def.key, name: def.name, ko: def.ko, icon: textureUrl(def),
        kind: def.fluid ? "fluid" : "block", fluid: def.fluid, maxStack: 9999,
    }] as [string, InventoryItem]),
    ...TOOL_ITEMS.map(def => [def.key, def] as [string, InventoryItem]),
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
    return !!def && !def.fluid && (def.kind === "tool" || isPlaceableItem(blockByKey(key)!));
}
