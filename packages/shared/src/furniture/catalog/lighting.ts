import type { FurnitureDef, PartSpec } from "../types.js";
import { C, QUARTER, ball, brick, cyl, palettes } from "./kit.js";

/** Lampshades. Lights are colours, not light sources — see docs/FURNITURE.md. */
const SHADES = palettes(
  ["shade"],
  [
    ["노랑", C.yellow],
    ["하양", C.cream],
    ["분홍", C.pink],
    ["하늘", C.sky],
  ],
);

/**
 * A lampshade: a truncated cone (narrow at the top) with a trim band at its
 * hem and the bulb glowing underneath. A soft box read as a mushroom cap; the
 * taper is what says "lampshade".
 */
function shade(width: number, height: number, x: number, bottom: number, z: number): PartSpec[] {
  return [
    ball(C.cream, [width * 0.36, width * 0.36, width * 0.36], [x, bottom + width * 0.06, z]),
    cyl("shade", [width, height, width], [x, bottom + height / 2, z], 0.62),
    cyl(C.gold, [width * 1.02, height * 0.08, width * 1.02], [x, bottom + height * 0.04, z]),
  ];
}

export const LIGHTING: FurnitureDef[] = [
  {
    key: "lamp",
    name: "스탠드",
    emoji: "💡",
    category: "lighting",
    placement: "floor",
    size: { w: 1, d: 1, h: 2 },
    palettes: SHADES,
    parts: [
      cyl(C.charcoal, [0.4, 0.06, 0.4], [0, 0.03, 0], 0.8),
      cyl(C.charcoal, [0.05, 1.3, 0.05], [0, 0.7, 0]),
      ball(C.gold, [0.08, 0.06, 0.08], [0, 0.7, 0]), // the switch knuckle
      ...shade(0.6, 0.44, 0, 1.3, 0),
    ],
  },
  {
    key: "table-lamp",
    name: "탁상 조명",
    emoji: "🏮",
    category: "lighting",
    placement: "surface",
    size: { w: 1, d: 1, h: 1 },
    palettes: SHADES,
    parts: [
      ball(C.terracotta, [0.24, 0.22, 0.24], [0, 0.11, 0]),
      cyl(C.terracotta, [0.08, 0.04, 0.08], [0, 0.23, 0]),
      cyl(C.gold, [0.025, 0.1, 0.025], [0, 0.29, 0]),
      ...shade(0.34, 0.24, 0, 0.32, 0),
    ],
  },
  {
    key: "wall-lamp",
    name: "벽 조명",
    emoji: "🔆",
    category: "lighting",
    placement: "wall",
    size: { w: 1, d: 1, h: 1 },
    palettes: SHADES,
    parts: [
      cyl(C.gold, [0.16, 0.03, 0.16], [0, 0.6, -0.485], 1, [QUARTER, 0, 0]), // wall plate
      cyl(C.gold, [0.03, 0.2, 0.03], [0, 0.6, -0.38], 1, [QUARTER, 0, 0]),
      cyl(C.gold, [0.03, 0.12, 0.03], [0, 0.65, -0.28]),
      ...shade(0.28, 0.22, 0, 0.66, -0.28),
    ],
  },
  {
    key: "candles",
    name: "양초",
    emoji: "🕯️",
    category: "lighting",
    placement: "surface",
    size: { w: 1, d: 1, h: 1 },
    parts: [
      cyl(C.gold, [0.4, 0.03, 0.3], [0, 0.015, 0], 1.1), // tray
      ...(
        [
          [-0.11, 0, 0.22],
          [0.03, 0.04, 0.3],
          [0.13, -0.04, 0.16],
        ] as const
      ).flatMap(([x, z, h]) => [
        cyl(C.cream, [0.08, h, 0.08], [x, 0.03 + h / 2, z]),
        ball(C.cream, [0.03, 0.05, 0.03], [x + 0.035, 0.03 + h - 0.04, z + 0.02]), // a drip
        cyl(C.ink, [0.01, 0.03, 0.01], [x, 0.045 + h, z]), // wick
        ball(C.orange, [0.06, 0.1, 0.06], [x, 0.1 + h, z]),
        ball(C.yellow, [0.03, 0.06, 0.03], [x, 0.09 + h, z + 0.012]),
      ]),
    ],
  },
  {
    key: "lantern",
    name: "랜턴",
    emoji: "🪔",
    category: "lighting",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    parts: [
      brick(C.charcoal, [0.44, 0.06, 0.44], [0, 0.03, 0], 0.4),
      ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => brick(C.charcoal, [0.05, 0.46, 0.05], [sx * 0.18, 0.29, sz * 0.18], 0.4))),
      ball(C.yellow, [0.3, 0.36, 0.3], [0, 0.29, 0]),
      ball(C.cream, [0.12, 0.16, 0.12], [0, 0.3, 0]),
      brick(C.charcoal, [0.48, 0.06, 0.48], [0, 0.54, 0], 0.4),
      cyl(C.charcoal, [0.48, 0.16, 0.48], [0, 0.65, 0], 0.15), // pointed roof
      // the carrying ring, as a hoop of three bars
      cyl(C.charcoal, [0.03, 0.12, 0.03], [-0.08, 0.78, 0], 1, [0, 0, 0.5]),
      cyl(C.charcoal, [0.03, 0.12, 0.03], [0.08, 0.78, 0], 1, [0, 0, -0.5]),
      cyl(C.charcoal, [0.03, 0.12, 0.03], [0, 0.83, 0], 1, [0, 0, QUARTER]),
    ],
  },
];
