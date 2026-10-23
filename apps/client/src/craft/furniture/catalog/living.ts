import type { FurnitureDef, PartSpec } from "../types.js";
import { C, QUARTER, ball, brick, cyl, legs4, palettes } from "./kit.js";

/** Upholstery shared by the sofa and the armchair, so a set can match. */
const UPHOLSTERY = palettes(
  ["main", "dark", "accent"],
  [
    ["파랑", C.blue, C.blueDark, C.yellow],
    ["빨강", C.red, 0xb8483a, C.cream],
    ["초록", 0x6cc070, 0x4a9a50, C.orange],
    ["회색", 0xa9afb8, 0x7d848e, C.pink],
    ["노랑", C.yellow, 0xe0b52c, C.blue],
  ],
);

/** Books on four shelves: a fixed shuffle of widths, heights and colours, so
 *  every bookshelf shows the same stable pattern (no per-load flicker). */
function books(): PartSpec[] {
  const shelves = [0.06, 0.5, 0.96, 1.42, 1.86];
  const colors = [C.red, C.blue, C.yellow, C.green, C.cream, C.blueDark, C.terracotta];
  const out: PartSpec[] = [];
  let n = 0;
  for (let s = 0; s < shelves.length - 1; s++) {
    const floor = shelves[s]! + 0.035;
    let x = -0.36;
    while (x < 0.3) {
      const w = 0.08 + ((n * 7) % 4) * 0.02;
      const h = 0.26 + ((n * 5) % 3) * 0.05;
      if (x + w > 0.37) break;
      // every fifth book leans on its neighbour — a shelf of soldiers looks fake
      const lean = n % 5 === 3 ? -0.18 : 0;
      out.push(brick(colors[n % colors.length]!, [w, h, 0.34], [x + w / 2, floor + h / 2, -0.17], 0.15, [0, 0, lean]));
      x += w + 0.012;
      n++;
    }
  }
  return out;
}

/**
 * Upholstered seating `w` metres wide: a dark frame, plump seat and back
 * cushions per seat, rolled arms and turned feet. The sofa and the armchair
 * are the same build at two widths, so a matching set really matches.
 */
function upholstered(w: number, seats: number): PartSpec[] {
  const inner = w - 0.4; // between the arms
  const seatW = inner / seats;
  const out: PartSpec[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) out.push(cyl(C.woodDark, [0.09, 0.1, 0.09], [sx * (w / 2 - 0.1), 0.05, sz * 0.34], 0.75));
  }
  out.push(brick("dark", [w - 0.06, 0.3, 0.86], [0, 0.25, 0], 0.18));
  out.push(brick("dark", [w - 0.06, 0.5, 0.2], [0, 0.6, -0.33], 0.25));
  for (let i = 0; i < seats; i++) {
    const x = -inner / 2 + seatW * (i + 0.5);
    out.push(brick("main", [seatW - 0.03, 0.18, 0.66], [x, 0.49, 0.07], 0.45));
    out.push(brick("main", [seatW - 0.05, 0.44, 0.18], [x, 0.78, -0.21], 0.48, [-0.14, 0, 0]));
  }
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 0.11);
    out.push(brick("dark", [0.2, 0.42, 0.86], [x, 0.45, 0], 0.3));
    // the roll on top of the arm
    out.push(cyl("main", [0.22, 0.84, 0.22], [x, 0.66, 0], 1, [QUARTER, 0, 0]));
  }
  return out;
}

export const LIVING: FurnitureDef[] = [
  {
    key: "sofa",
    seat: 0.58,
    name: "소파",
    emoji: "🛋️",
    category: "living",
    placement: "floor",
    size: { w: 2, d: 1, h: 1 },
    palettes: UPHOLSTERY,
    parts: [...upholstered(1.94, 2), brick("accent", [0.28, 0.28, 0.12], [-0.5, 0.72, -0.08], 0.48, [-0.2, 0.3, 0.15])],
  },
  {
    key: "armchair",
    seat: 0.58,
    name: "안락의자",
    emoji: "💺",
    category: "living",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    palettes: UPHOLSTERY,
    parts: [...upholstered(0.98, 1), brick("accent", [0.24, 0.24, 0.1], [0.1, 0.72, -0.08], 0.48, [-0.2, -0.3, -0.1])],
  },
  {
    key: "coffee-table",
    name: "거실 탁자",
    emoji: "☕",
    category: "living",
    placement: "floor",
    size: { w: 2, d: 1, h: 1 },
    surface: 0.45,
    parts: [
      ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => cyl(C.woodDark, [0.09, 0.36, 0.09], [sx * 0.8, 0.18, sz * 0.33], 0.7))),
      brick(C.woodLight, [1.62, 0.04, 0.68], [0, 0.13, 0], 0.3),
      brick(C.wood, [1.84, 0.09, 0.88], [0, 0.405, 0], 0.35),
      brick(C.woodDark, [1.7, 0.05, 0.76], [0, 0.345, 0], 0.3),
    ],
  },
  {
    key: "side-table",
    name: "협탁",
    emoji: "🫖",
    category: "living",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    surface: 0.6,
    parts: [
      cyl(C.woodDark, [0.4, 0.05, 0.4], [0, 0.025, 0], 0.85),
      cyl(C.woodDark, [0.08, 0.5, 0.08], [0, 0.3, 0]),
      ball(C.woodDark, [0.14, 0.12, 0.14], [0, 0.3, 0]),
      cyl(C.wood, [0.72, 0.06, 0.72], [0, 0.57, 0]),
    ],
  },
  {
    key: "tv",
    name: "텔레비전",
    emoji: "📺",
    category: "living",
    placement: "floor",
    size: { w: 2, d: 1, h: 2 },
    parts: [
      ...legs4(C.woodDark, 1.66, 0.58, 0.08, 0.07, 0.04),
      brick(C.wood, [1.7, 0.38, 0.62], [0, 0.27, 0], 0.18),
      brick(C.woodDark, [0.74, 0.24, 0.03], [-0.42, 0.27, 0.31], 0.3),
      brick(C.woodDark, [0.74, 0.24, 0.03], [0.42, 0.27, 0.31], 0.3),
      ball(C.gold, [0.05, 0.05, 0.03], [-0.1, 0.27, 0.33]),
      ball(C.gold, [0.05, 0.05, 0.03], [0.1, 0.27, 0.33]),
      cyl(C.charcoal, [0.36, 0.03, 0.22], [0, 0.475, -0.06]),
      brick(C.charcoal, [0.08, 0.14, 0.05], [0, 0.55, -0.08], 0.4),
      brick(C.charcoal, [1.48, 0.86, 0.08], [0, 1.02, -0.08], 0.12),
      brick(C.screen, [1.36, 0.74, 0.02], [0, 1.03, -0.035], 0.15),
      // a crayon "picture" on the screen: sun and a cloud over two hills
      ball(C.yellow, [0.16, 0.16, 0.02], [0.42, 1.2, -0.02]),
      ball(C.white, [0.28, 0.1, 0.02], [-0.25, 1.24, -0.02]),
      ball(C.green, [0.8, 0.26, 0.02], [-0.25, 0.78, -0.02]),
      ball(C.greenDark, [0.7, 0.2, 0.02], [0.34, 0.76, -0.018]),
      ball(C.red, [0.04, 0.04, 0.02], [0.66, 0.63, -0.03]), // power light
    ],
  },
  {
    key: "bookshelf",
    name: "책장",
    emoji: "📚",
    category: "living",
    placement: "floor",
    size: { w: 1, d: 1, h: 2 },
    parts: [
      brick(C.woodDark, [0.1, 1.9, 0.5], [-0.43, 0.95, -0.18], 0.15),
      brick(C.woodDark, [0.1, 1.9, 0.5], [0.43, 0.95, -0.18], 0.15),
      brick(C.woodDark, [0.86, 1.9, 0.06], [0, 0.95, -0.4], 0.15),
      ...[0.06, 0.5, 0.96, 1.42, 1.86].map((y) => brick(C.wood, [0.8, 0.07, 0.48], [0, y, -0.16], 0.2)),
      brick(C.wood, [0.98, 0.07, 0.56], [0, 1.94, -0.17], 0.3), // crown
      ...books(),
    ],
  },
  {
    key: "fireplace",
    name: "벽난로",
    emoji: "🔥",
    category: "living",
    placement: "floor",
    size: { w: 2, d: 1, h: 2 },
    parts: [
      // a real opening: two piers and a lintel around a dark firebox, so the
      // fire sits INSIDE the wall instead of being painted on its face
      brick(C.greyLight, [1.96, 0.14, 0.96], [0, 0.07, 0.01], 0.25), // hearth: thick enough to cover the floor studs
      brick(C.terracotta, [0.46, 1.2, 0.72], [-0.73, 0.7, -0.13], 0.1),
      brick(C.terracotta, [0.46, 1.2, 0.72], [0.73, 0.7, -0.13], 0.1),
      brick(C.terracotta, [1.04, 0.42, 0.72], [0, 1.09, -0.13], 0.1),
      brick(C.charcoal, [1.04, 0.82, 0.08], [0, 0.5, -0.45], 0.1),
      brick(C.ink, [1.02, 0.04, 0.6], [0, 0.15, -0.15], 0.2),
      cyl(0x8a5a2f, [0.13, 0.66, 0.13], [0, 0.24, -0.14], 1, [0, 0.25, QUARTER]),
      cyl(0x7a4a22, [0.12, 0.6, 0.12], [0.02, 0.24, -0.24], 1, [0, -0.35, QUARTER]),
      cyl(C.orange, [0.4, 0.46, 0.34], [0, 0.48, -0.18], 0),
      cyl(C.yellow, [0.22, 0.3, 0.2], [0.06, 0.42, -0.12], 0),
      cyl(C.orange, [0.2, 0.28, 0.18], [-0.18, 0.39, -0.2], 0),
      brick(C.woodDark, [1.98, 0.1, 0.86], [0, 1.35, -0.07], 0.3), // mantel
      brick(C.terracotta, [1.2, 0.58, 0.5], [0, 1.69, -0.22], 0.12), // chimney breast
      // a little brickwork so the piers read as masonry
      ...[0.35, 0.7, 1.05].flatMap((y) => [
        brick(0xb85e3a, [0.47, 0.025, 0.02], [-0.73, y, 0.235], 0.3),
        brick(0xb85e3a, [0.47, 0.025, 0.02], [0.73, y, 0.235], 0.3),
      ]),
    ],
  },
];
