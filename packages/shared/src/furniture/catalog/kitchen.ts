import type { FurnitureDef, PartSpec } from "../types.js";
import { C, QUARTER, ball, brick, cyl, hollow, palettes } from "./kit.js";

/** A kitchen base cabinet: toe-kick, body, a door with a handle. The worktop
 *  is left to the caller — the sink's has a hole in it. */
function cabinet(body: number): PartSpec[] {
  return [
    brick(C.charcoal, [0.9, 0.1, 0.8], [0, 0.05, -0.06], 0.2), // recessed toe-kick
    brick(body, [0.96, 0.78, 0.9], [0, 0.49, -0.03], 0.1),
    brick(C.woodLight, [0.8, 0.5, 0.03], [0, 0.42, 0.435], 0.25),
    brick(C.woodLight, [0.8, 0.14, 0.03], [0, 0.76, 0.435], 0.3), // drawer
    cyl(C.steel, [0.035, 0.22, 0.035], [0.3, 0.52, 0.465]),
    cyl(C.steel, [0.035, 0.22, 0.035], [0, 0.76, 0.465], 1, [0, 0, QUARTER]),
  ];
}
const worktop = (color: number): PartSpec => brick(color, [0.98, 0.06, 0.94], [0, 0.89, -0.02], 0.25);

/** A gas ring: dark cap on a steel ring, on a hob at `y`. */
const burner = (x: number, y: number, z: number, d: number): PartSpec[] => [
  cyl(C.steel, [d, 0.025, d], [x, y + 0.012, z]),
  cyl(C.charcoal, [d * 0.62, 0.035, d * 0.62], [x, y + 0.02, z]),
];

export const KITCHEN: FurnitureDef[] = [
  {
    key: "table",
    name: "식탁",
    emoji: "🍽️",
    category: "kitchen",
    placement: "floor",
    size: { w: 2, d: 1, h: 1 },
    surface: 0.81,
    parts: [
      ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => cyl(C.woodDark, [0.12, 0.68, 0.12], [sx * 0.82, 0.34, sz * 0.34], 0.7))),
      brick(C.woodDark, [1.66, 0.1, 0.06], [0, 0.62, -0.34], 0.3), // apron
      brick(C.woodDark, [1.66, 0.1, 0.06], [0, 0.62, 0.34], 0.3),
      brick(C.wood, [1.94, 0.13, 0.96], [0, 0.74, 0], 0.32),
    ],
  },
  {
    key: "chair",
    seat: 0.65,
    name: "의자",
    emoji: "🪑",
    category: "kitchen",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    palettes: palettes(
      ["cushion"],
      [
        ["빨강", C.red],
        ["파랑", C.blue],
        ["초록", C.green],
        ["노랑", C.yellow],
      ],
    ),
    parts: [
      ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => cyl(C.woodDark, [0.09, 0.46, 0.09], [sx * 0.29, 0.23, sz * 0.29], 0.75))),
      brick(C.wood, [0.76, 0.1, 0.76], [0, 0.5, 0], 0.28),
      brick("cushion", [0.64, 0.1, 0.62], [0, 0.6, 0.03], 0.45),
      // backrest: two posts, three spindles and a top rail
      cyl(C.woodDark, [0.08, 0.5, 0.08], [-0.3, 0.8, -0.32]),
      cyl(C.woodDark, [0.08, 0.5, 0.08], [0.3, 0.8, -0.32]),
      ...[-0.13, 0, 0.13].map((x) => cyl(C.wood, [0.04, 0.3, 0.04], [x, 0.72, -0.32])),
      brick(C.wood, [0.72, 0.14, 0.08], [0, 0.94, -0.33], 0.45),
    ],
  },
  {
    key: "stool",
    seat: 0.71,
    name: "동그란 의자",
    emoji: "🍄",
    category: "kitchen",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    palettes: palettes(
      ["seat"],
      [
        ["나무", C.wood],
        ["빨강", C.red],
        ["하늘", C.sky],
      ],
    ),
    parts: [
      ...[0, 1, 2, 3].map((i) => {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        // splayed legs: each tilted outward a little, like a real stool
        return cyl(C.woodDark, [0.06, 0.62, 0.06], [Math.cos(a) * 0.17, 0.31, Math.sin(a) * 0.17], 0.8, [Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12]);
      }),
      cyl(C.woodDark, [0.42, 0.03, 0.42], [0, 0.24, 0]), // footrest ring
      cyl("seat", [0.5, 0.08, 0.5], [0, 0.64, 0]),
      cyl("seat", [0.44, 0.04, 0.44], [0, 0.69, 0], 0.85),
    ],
  },
  {
    key: "counter",
    name: "조리대",
    emoji: "🥣",
    category: "kitchen",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    surface: 0.92,
    parts: [...cabinet(C.cream), worktop(C.greyLight)],
  },
  {
    key: "stove",
    name: "가스레인지",
    emoji: "🍳",
    category: "kitchen",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    surface: 0.95,
    parts: [
      brick(C.charcoal, [0.9, 0.1, 0.8], [0, 0.05, -0.06], 0.2),
      brick(C.white, [0.96, 0.78, 0.9], [0, 0.49, -0.03], 0.1),
      brick(C.charcoal, [0.98, 0.06, 0.94], [0, 0.89, -0.02], 0.25),
      ...burner(-0.22, 0.92, -0.2, 0.26),
      ...burner(0.22, 0.92, -0.2, 0.2),
      ...burner(-0.22, 0.92, 0.18, 0.2),
      ...burner(0.22, 0.92, 0.18, 0.26),
      // oven: a framed dark window and a bar handle; knobs on a front strip
      brick(C.greyLight, [0.78, 0.46, 0.03], [0, 0.4, 0.43], 0.2),
      brick(C.ink, [0.6, 0.3, 0.02], [0, 0.38, 0.45], 0.25),
      cyl(C.steel, [0.04, 0.62, 0.04], [0, 0.66, 0.47], 1, [0, 0, QUARTER]),
      brick(C.greyLight, [0.9, 0.1, 0.03], [0, 0.8, 0.43], 0.3),
      ...[-0.3, -0.1, 0.1, 0.3].map((x) => cyl(C.ink, [0.06, 0.04, 0.06], [x, 0.8, 0.46], 1, [QUARTER, 0, 0])),
      // a raised back panel with a little clock, so the hob has a "back"
      brick(C.white, [0.98, 0.1, 0.06], [0, 0.97, -0.46], 0.3),
      brick(C.screen, [0.16, 0.05, 0.01], [0, 0.975, -0.428], 0.2),
    ],
  },
  {
    key: "sink",
    name: "싱크대",
    emoji: "🚰",
    category: "kitchen",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    parts: [
      ...cabinet(C.cream),
      // a worktop with a HOLE: four strips around the basin, which sits in it
      brick(C.greyLight, [0.98, 0.06, 0.2], [0, 0.89, -0.39], 0.25),
      brick(C.greyLight, [0.98, 0.06, 0.18], [0, 0.89, 0.36], 0.25),
      brick(C.greyLight, [0.18, 0.06, 0.6], [-0.4, 0.89, -0.02], 0.25),
      brick(C.greyLight, [0.18, 0.06, 0.6], [0.4, 0.89, -0.02], 0.25),
      ...hollow(C.steel, [0.64, 0.24, 0.58], [0, 0.8, -0.02], 0.04, C.grey, 0.2),
      cyl(C.charcoal, [0.06, 0.01, 0.06], [0, 0.705, -0.02]), // drain
      // faucet: a pipe up, a spout reaching over the basin, two taps
      // (kept under 1.06 m: anything higher pokes into the cell above)
      cyl(C.steel, [0.06, 0.13, 0.06], [0, 0.98, -0.4]),
      cyl(C.steel, [0.05, 0.24, 0.05], [0, 1.03, -0.3], 1, [QUARTER, 0, 0]),
      cyl(C.steel, [0.05, 0.05, 0.05], [0, 1.0, -0.19]),
      cyl(C.blue, [0.07, 0.05, 0.07], [-0.13, 0.94, -0.4]),
      cyl(C.red, [0.07, 0.05, 0.07], [0.13, 0.94, -0.4]),
      // a sponge on the edge and a bottle of washing-up liquid
      brick(C.yellow, [0.12, 0.035, 0.07], [0.4, 0.94, 0.28], 0.3),
      brick(C.green, [0.12, 0.015, 0.07], [0.4, 0.965, 0.28], 0.3),
      cyl(C.green, [0.07, 0.11, 0.07], [-0.38, 0.975, -0.36], 0.9),
      cyl(C.white, [0.03, 0.03, 0.03], [-0.38, 1.04, -0.36]),
    ],
  },
  {
    key: "fridge",
    name: "냉장고",
    emoji: "🧊",
    category: "kitchen",
    placement: "floor",
    size: { w: 1, d: 1, h: 2 },
    palettes: palettes(
      ["body"],
      [
        ["하양", C.white],
        ["하늘", C.sky],
        ["빨강", C.red],
      ],
    ),
    parts: [
      brick(C.charcoal, [0.84, 0.06, 0.8], [0, 0.03, -0.05], 0.3),
      brick("body", [0.92, 1.86, 0.84], [0, 0.99, -0.05], 0.12),
      // two doors that stand proud of the body, freezer on top
      brick("body", [0.9, 0.6, 0.05], [0, 1.6, 0.39], 0.2),
      brick("body", [0.9, 1.16, 0.05], [0, 0.66, 0.39], 0.2),
      cyl(C.steel, [0.045, 0.36, 0.045], [0.34, 1.52, 0.44]),
      cyl(C.steel, [0.045, 0.5, 0.045], [0.34, 0.92, 0.44]),
      ball(C.red, [0.08, 0.08, 0.03], [-0.2, 1.62, 0.42]),
      ball(C.yellow, [0.08, 0.08, 0.03], [-0.05, 1.52, 0.42]),
      // a child's crayon drawing stuck on the door: a sun over a house
      brick(C.cream, [0.2, 0.24, 0.01], [-0.18, 1.0, 0.418], 0.1),
      ball(C.orange, [0.06, 0.06, 0.01], [-0.12, 1.07, 0.425]),
      brick(C.red, [0.08, 0.07, 0.01], [-0.21, 0.94, 0.425], 0.2),
      brick(C.blue, [0.1, 0.03, 0.01], [-0.21, 0.99, 0.425], 0.2, [0, 0, 0.2]),
    ],
  },
];
