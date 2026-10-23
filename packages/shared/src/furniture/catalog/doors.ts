import type { FurnitureDef, PartSpec } from "../types.js";
import { C, QUARTER, brick, cyl, palettes } from "./kit.js";

/**
 * Things that open and close. A right click on one toggles it, in any mode.
 *
 * Doors and gates hang in the BACK plane of their cell (z ≈ −0.44) and swing
 * toward the front, so the open leaf stays inside the same cell — a leaf
 * hinged in the middle would swing half a metre into the next cell, through
 * whatever block or sofa stands there. An open door is not solid (that is the
 * point of it); the posts left standing are slim enough to walk between.
 */

const DOOR = palettes(
  ["door", "trim"],
  [
    ["나무", C.wood, C.woodDark],
    ["하양", C.white, C.greyLight],
    ["빨강", C.red, 0xb8483a],
    ["파랑", C.blue, C.blueDark],
    ["초록", C.green, C.greenDark],
  ],
);

const PLANE = -0.44; // the leaf's centre plane, near the back of the cell
const LEAF_T = 0.06; // leaf thickness

/** Posts and lintel of an opening `w` metres wide and 2 m tall. */
function frame(w: number): PartSpec[] {
  return [
    brick("trim", [0.08, 1.98, 0.12], [-w / 2 + 0.04, 0.99, PLANE], 0.25),
    brick("trim", [0.08, 1.98, 0.12], [w / 2 - 0.04, 0.99, PLANE], 0.25),
    brick("trim", [w, 0.1, 0.12], [0, 1.95, PLANE], 0.25),
  ];
}

/**
 * One door leaf `w` wide, hinged at `hingeX`, its free edge toward `dir`
 * (+1 = to the right). Closed it lies across the opening; open it is turned a
 * quarter about the hinge and lies along the side of the cell.
 */
function leaf(w: number, hingeX: number, dir: 1 | -1, open: boolean): PartSpec[] {
  // Build in "leaf space": u runs from the hinge (0) to the free edge (w) and
  // `off` out of the leaf's front face. Swung open toward the room, that front
  // face turns to look across the cell — toward +x for a left hinge (dir 1).
  const at = (u: number, y: number, off: number): [number, number, number] =>
    open ? [hingeX + off * dir, y, PLANE + 0.03 + u] : [hingeX + dir * u, y, PLANE + off];
  const turn: [number, number, number] | undefined = open ? [0, QUARTER, 0] : undefined;
  const face = LEAF_T / 2 + 0.01; // the front face, for panels and the knob
  return [
    brick("door", [w, 1.86, LEAF_T], at(w / 2, 0.95, 0), 0.15, turn),
    brick("trim", [w * 0.64, 0.66, 0.02], at(w / 2, 1.4, face), 0.3, turn),
    brick("trim", [w * 0.64, 0.66, 0.02], at(w / 2, 0.55, face), 0.3, turn),
    cyl(C.gold, [0.07, 0.05, 0.07], at(w - 0.1, 0.95, face + 0.02), 1, open ? [0, 0, QUARTER] : [QUARTER, 0, 0]),
  ];
}

/** A picket gate leaf, `w` wide and 1 m tall, hinged at `hingeX`. */
function gateLeaf(w: number, hingeX: number, open: boolean): PartSpec[] {
  const at = (u: number, y: number): [number, number, number] =>
    open ? [hingeX, y, PLANE + 0.03 + u] : [hingeX + u, y, PLANE];
  const turn: [number, number, number] | undefined = open ? [0, QUARTER, 0] : undefined;
  const pickets = [0.1, 0.3, 0.5, 0.7].map((u) => brick("door", [0.12, 0.78, 0.04], at(u * (w / 0.8), 0.46), 0.3, turn));
  return [
    ...pickets,
    // pointed tops: each picket capped by a cone
    ...[0.1, 0.3, 0.5, 0.7].map((u) => cyl("door", [0.12, 0.1, 0.05], at(u * (w / 0.8), 0.9), 0, turn)),
    brick("trim", [w, 0.07, 0.03], at(w / 2, 0.25), 0.3, turn),
    brick("trim", [w, 0.07, 0.03], at(w / 2, 0.68), 0.3, turn),
  ];
}

const curtainColors = palettes(
  ["cloth", "tie"],
  [
    ["빨강", C.red, C.gold],
    ["파랑", C.blue, C.cream],
    ["노랑", C.yellow, C.orange],
    ["초록", C.green, C.cream],
    ["분홍", C.pink, C.white],
  ],
);

/** Folds of cloth from x0 to x1: alternating bricks a little in and out. */
function drape(x0: number, x1: number, n: number): PartSpec[] {
  const out: PartSpec[] = [];
  const w = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    out.push(brick("cloth", [w + 0.02, 1.72, 0.05], [x0 + w * (i + 0.5), 1.0, -0.4 + (i % 2) * 0.025], 0.4));
  }
  return out;
}

export const DOORS: FurnitureDef[] = [
  {
    key: "door",
    name: "문",
    emoji: "🚪",
    category: "doors",
    placement: "floor",
    size: { w: 1, d: 1, h: 2 },
    palettes: DOOR,
    parts: [...frame(1), ...leaf(0.84, -0.42, 1, false)],
    openParts: [...frame(1), ...leaf(0.84, -0.42, 1, true)],
  },
  {
    key: "double-door",
    name: "큰 문",
    emoji: "⛩️",
    category: "doors",
    placement: "floor",
    size: { w: 2, d: 1, h: 2 },
    palettes: DOOR,
    parts: [...frame(2), ...leaf(0.92, -0.92, 1, false), ...leaf(0.92, 0.92, -1, false)],
    openParts: [...frame(2), ...leaf(0.92, -0.92, 1, true), ...leaf(0.92, 0.92, -1, true)],
  },
  {
    key: "garden-gate",
    name: "울타리 문",
    emoji: "🚧",
    category: "doors",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    palettes: palettes(
      ["door", "trim"],
      [
        ["하양", C.white, C.greyLight],
        ["나무", C.woodLight, C.wood],
        ["초록", C.green, C.greenDark],
      ],
    ),
    parts: [
      brick("trim", [0.1, 1.0, 0.1], [-0.45, 0.5, PLANE], 0.3),
      brick("trim", [0.1, 1.0, 0.1], [0.45, 0.5, PLANE], 0.3),
      ...gateLeaf(0.8, -0.4, false),
    ],
    openParts: [
      brick("trim", [0.1, 1.0, 0.1], [-0.45, 0.5, PLANE], 0.3),
      brick("trim", [0.1, 1.0, 0.1], [0.45, 0.5, PLANE], 0.3),
      ...gateLeaf(0.8, -0.38, true),
    ],
  },
  {
    key: "curtain",
    name: "커튼",
    emoji: "🪟",
    category: "doors",
    placement: "wall",
    // hang it over a window (a glass block) — or over any wall
    size: { w: 1, d: 1, h: 2 },
    palettes: curtainColors,
    parts: [
      cyl(C.woodDark, [0.04, 1.0, 0.04], [0, 1.9, -0.42], 1, [0, 0, QUARTER]), // rod
      cyl(C.woodDark, [0.07, 0.07, 0.07], [-0.48, 1.9, -0.42]),
      cyl(C.woodDark, [0.07, 0.07, 0.07], [0.48, 1.9, -0.42]),
      ...drape(-0.47, -0.01, 4),
      ...drape(0.01, 0.47, 4),
    ],
    openParts: [
      cyl(C.woodDark, [0.04, 1.0, 0.04], [0, 1.9, -0.42], 1, [0, 0, QUARTER]),
      cyl(C.woodDark, [0.07, 0.07, 0.07], [-0.48, 1.9, -0.42]),
      cyl(C.woodDark, [0.07, 0.07, 0.07], [0.48, 1.9, -0.42]),
      // drawn aside: gathered bunches at each end, tied back
      ...drape(-0.47, -0.31, 2),
      ...drape(0.31, 0.47, 2),
      brick("tie", [0.2, 0.05, 0.08], [-0.39, 0.95, -0.37], 0.4),
      brick("tie", [0.2, 0.05, 0.08], [0.39, 0.95, -0.37], 0.4),
    ],
  },
];
