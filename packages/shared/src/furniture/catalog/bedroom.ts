import type { FurnitureDef, PartSpec } from "../types.js";
import { C, QUARTER, brick, cyl, legs4, palettes } from "./kit.js";

/** Bedding shared by both beds. */
const BEDDING = palettes(
  ["blanket"],
  [
    ["파랑", C.blue],
    ["분홍", C.pink],
    ["초록", C.green],
    ["보라", C.purple],
    ["노랑", C.yellow],
  ],
);

/** A drawer front with a round knob, on a cabinet whose face is at `z`. */
const drawer = (x: number, y: number, z: number, w = 0.6, h = 0.2): PartSpec[] => [
  brick(C.woodLight, [w, h, 0.03], [x, y, z + 0.015], 0.3),
  cyl(C.gold, [0.06, 0.04, 0.06], [x, y, z + 0.045], 1, [QUARTER, 0, 0]),
];

/**
 * A bed `w` metres wide (1 or 2 cells) and 2 cells long: frame on turned feet,
 * mattress, a blanket turned down at the top, pillows, and a headboard with a
 * rolled top rail. Both beds are this one build.
 */
function bed(w: number): PartSpec[] {
  const pillows = w > 1.5 ? [-0.45, 0.45] : [0];
  return [
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => cyl(C.woodDark, [0.1, 0.12, 0.1], [sx * (w / 2 - 0.08), 0.06, sz * 0.88], 0.8))),
    brick(C.wood, [w - 0.04, 0.2, 1.9], [0, 0.22, 0.02], 0.2),
    brick(C.cream, [w - 0.12, 0.2, 1.8], [0, 0.42, 0.03], 0.32),
    brick("blanket", [w - 0.08, 0.13, 1.2], [0, 0.53, 0.32], 0.38),
    // the turned-down top edge of the sheet, over the blanket
    brick(C.white, [w - 0.08, 0.06, 0.18], [0, 0.6, -0.24], 0.45),
    ...pillows.map((x) => brick(C.white, [0.6, 0.15, 0.34], [x, 0.58, -0.62], 0.55)),
    brick(C.woodDark, [w, 0.86, 0.1], [0, 0.46, -0.94], 0.2),
    cyl(C.wood, [0.14, w + 0.02, 0.14], [0, 0.9, -0.94], 1, [0, 0, QUARTER]),
    brick(C.woodDark, [w, 0.48, 0.09], [0, 0.3, 0.945], 0.2),
  ];
}

export const BEDROOM: FurnitureDef[] = [
  {
    key: "bed",
    seat: 0.52,
    name: "침대",
    emoji: "🛏️",
    category: "bedroom",
    placement: "floor",
    size: { w: 1, d: 2, h: 1 },
    palettes: BEDDING,
    parts: bed(0.98),
  },
  {
    key: "double-bed",
    seat: 0.52,
    name: "큰 침대",
    emoji: "🛌",
    category: "bedroom",
    placement: "floor",
    size: { w: 2, d: 2, h: 1 },
    palettes: BEDDING,
    parts: bed(1.96),
  },
  {
    key: "nightstand",
    name: "침대 옆 탁자",
    emoji: "🗄️",
    category: "bedroom",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    surface: 0.63,
    parts: [
      ...legs4(C.woodDark, 0.66, 0.56, 0.1, 0.07, 0.02),
      brick(C.woodLight, [0.7, 0.46, 0.6], [0, 0.33, -0.05], 0.15),
      ...drawer(0, 0.44, 0.25, 0.6, 0.17),
      ...drawer(0, 0.24, 0.25, 0.6, 0.17),
      brick(C.wood, [0.76, 0.07, 0.66], [0, 0.595, -0.05], 0.3),
    ],
  },
  {
    key: "wardrobe",
    name: "옷장",
    emoji: "👔",
    category: "bedroom",
    placement: "floor",
    size: { w: 2, d: 1, h: 2 },
    palettes: palettes(
      ["body", "door"],
      [
        ["나무", C.wood, C.woodLight],
        ["하양", C.cream, C.white],
        ["하늘", C.sky, C.white],
      ],
    ),
    parts: [
      ...legs4(C.woodDark, 1.84, 0.74, 0.1, 0.09, 0.04),
      brick("body", [1.9, 1.76, 0.8], [0, 0.98, -0.08], 0.08),
      brick(C.woodDark, [1.98, 0.08, 0.86], [0, 1.9, -0.07], 0.3), // crown
      // doors with a raised inner panel each, and a gap between them
      ...[-1, 1].flatMap((sx) => [
        brick("door", [0.9, 1.6, 0.04], [sx * 0.465, 0.98, 0.33], 0.2),
        brick("body", [0.66, 1.3, 0.03], [sx * 0.465, 0.98, 0.36], 0.25),
        cyl(C.gold, [0.035, 0.26, 0.035], [sx * 0.07, 1.0, 0.385]),
      ]),
    ],
  },
  {
    key: "dresser",
    name: "서랍장",
    emoji: "🧺",
    category: "bedroom",
    placement: "floor",
    size: { w: 2, d: 1, h: 1 },
    surface: 0.82,
    parts: [
      ...legs4(C.woodDark, 1.76, 0.66, 0.1, 0.08, 0.02),
      brick(C.wood, [1.8, 0.68, 0.7], [0, 0.44, -0.05], 0.12),
      ...[0.24, 0.45, 0.66].flatMap((y) => [...drawer(-0.43, y, 0.3, 0.8, 0.17), ...drawer(0.43, y, 0.3, 0.8, 0.17)]),
      brick(C.woodDark, [1.86, 0.07, 0.76], [0, 0.785, -0.05], 0.3),
    ],
  },
  {
    key: "desk",
    name: "책상",
    emoji: "🖊️",
    category: "bedroom",
    placement: "floor",
    size: { w: 2, d: 1, h: 1 },
    surface: 0.76,
    parts: [
      ...legs4(C.woodDark, 1.9, 0.86, 0.68, 0.08),
      brick(C.woodDark, [1.7, 0.05, 0.05], [0, 0.18, -0.36], 0.3), // footrest stretcher
      brick(C.woodLight, [0.5, 0.42, 0.72], [0.62, 0.47, 0], 0.15),
      ...drawer(0.62, 0.58, 0.36, 0.42, 0.14),
      ...drawer(0.62, 0.38, 0.36, 0.42, 0.18),
      brick(C.wood, [1.9, 0.08, 0.86], [0, 0.72, 0], 0.3),
    ],
  },
];
