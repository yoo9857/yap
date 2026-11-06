/**
 * Power-plant PARTS: items carried in the bag and fitted into a plant's part slots. They are not
 * blocks (no voxel id, never placed into a cell); a plant without every part never runs.
 * Pure data — the 3D models are in partModels.ts, the icons under /items/parts/.
 */
export type PartKey = "part-blades" | "part-generator" | "part-wire-terminal";

export interface PartDef {
  key: PartKey;
  name: string;
  ko: string;
  icon: string;
  /** One line of science: what this part does in the energy chain. */
  note: string;
  noteEn: string;
}

export const PARTS: Readonly<Record<PartKey, PartDef>> = {
  "part-blades": {
    key: "part-blades",
    name: "Turbine blades",
    ko: "날개",
    icon: "/items/parts/part-blades.webp",
    note: "바람의 움직이는 힘(운동 에너지)을 받아 축을 돌려요.",
    noteEn: "Catch the wind's moving energy (kinetic energy) and turn the shaft.",
  },
  "part-generator": {
    key: "part-generator",
    name: "Generator",
    ko: "발전기",
    icon: "/items/parts/part-generator.webp",
    note: "자석 옆에서 코일이 돌면 전기가 생겨요. 도는 힘이 전기로 바뀌는 곳이에요.",
    noteEn: "A coil spinning next to magnets makes electricity: turning becomes electric energy here.",
  },
  "part-wire-terminal": {
    key: "part-wire-terminal",
    name: "Wire terminal",
    ko: "전선 단자",
    icon: "/items/parts/part-wire-terminal.webp",
    note: "만든 전기를 전선으로 내보내는 출구예요. 없으면 전기가 마을로 못 가요.",
    noteEn: "The outlet that sends the electricity down the wire. Without it, nothing reaches the village.",
  },
};

export const PART_KEYS = Object.keys(PARTS) as PartKey[];

export function isPartKey(key: string): key is PartKey {
  return Object.prototype.hasOwnProperty.call(PARTS, key);
}

/** The most of one part a bag holds. */
export const PART_MAX_STACK = 99;
