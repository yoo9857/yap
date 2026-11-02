import { t } from "../../ui/i18n.js";
import type { FurnitureDef } from "./types.js";

/**
 * English display names. The catalog's `name`s are Korean data shared with the server; English
 * lives here beside it (the way `BlockDef.ko` does the other way round) and is picked at display
 * time. A missing entry falls back to the Korean name, and a unit test keeps the table complete.
 */
export const PIECE_EN: Readonly<Record<string, string>> = {
  bathtub: "Bathtub", toilet: "Toilet", "bath-sink": "Washbasin", shower: "Shower", "towel-rack": "Towel rack",
  "bath-mat": "Bath mat", bed: "Bed", "double-bed": "Double bed", nightstand: "Nightstand", wardrobe: "Wardrobe",
  dresser: "Dresser", desk: "Desk", plant: "Potted plant", succulent: "Little plant", vase: "Vase", teddy: "Teddy bear",
  globe: "Globe", painting: "Painting", "big-painting": "Big painting", clock: "Wall clock", rug: "Rug", door: "Door",
  "double-door": "Double door", "garden-gate": "Garden gate", curtain: "Curtain", table: "Dining table", chair: "Chair",
  stool: "Stool", counter: "Counter", stove: "Stove", sink: "Kitchen sink", fridge: "Fridge", lamp: "Floor lamp",
  "table-lamp": "Table lamp", "wall-lamp": "Wall lamp", candles: "Candles", lantern: "Lantern", sofa: "Sofa",
  armchair: "Armchair", "coffee-table": "Coffee table", "side-table": "Side table", tv: "TV", bookshelf: "Bookshelf",
  fireplace: "Fireplace", bench: "Bench", "picnic-table": "Picnic table", parasol: "Parasol", planter: "Planter box",
  mailbox: "Mailbox", doghouse: "Doghouse", bbq: "BBQ grill", "street-lamp": "Street lamp",
};

/** Colour (palette) names, keyed by their Korean name. */
export const PALETTE_EN: Readonly<Record<string, string>> = {
  나무: "Wood", 낮: "Day", 노랑: "Yellow", 노을: "Sunset", 눈: "Snow", 밤: "Night", 보라: "Purple", 분홍: "Pink",
  빨강: "Red", 초록: "Green", 파랑: "Blue", 하늘: "Sky", 하양: "White", 회색: "Grey", 갈색: "Brown",
};

/** Category names, keyed by their Korean name. */
export const CATEGORY_EN: Readonly<Record<string, string>> = {
  거실: "Living", 침실: "Bedroom", 주방: "Kitchen", 욕실: "Bath", 조명: "Lights", 장식: "Decor", "문·창": "Doors", 야외: "Outdoor",
};

export const pieceName = (def: Pick<FurnitureDef, "key" | "name">): string => t(def.name, PIECE_EN[def.key] ?? def.name);
export const paletteName = (name: string): string => t(name, PALETTE_EN[name] ?? name);
export const categoryName = (name: string): string => t(name, CATEGORY_EN[name] ?? name);
