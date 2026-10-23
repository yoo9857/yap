import type { FurnitureDef, PartSpec } from "../types.js";
import { C, QUARTER, ball, brick, cyl, dome, hollow, legs4, palettes } from "./kit.js";

/**
 * An OPEN parasol canopy: a shallow cone, scalloped edge in the stripe colour,
 * ribs running out underneath, a finial on top. `y` is where the cone's base
 * (its rim) sits.
 */
function canopy(y: number, diameter: number): PartSpec[] {
  const r = diameter / 2;
  const out: PartSpec[] = [
    cyl("canopy", [diameter, 0.42, diameter], [0, y + 0.21, 0], 0.06),
    cyl("stripe", [diameter * 0.42, 0.18, diameter * 0.42], [0, y + 0.33, 0], 0.15),
    ball("canopy", [0.09, 0.09, 0.09], [0, y + 0.45, 0]),
  ];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const x = Math.cos(a);
    const z = Math.sin(a);
    // scallops hang just under the rim, alternating colours
    out.push(ball(i % 2 ? "canopy" : "stripe", [0.17, 0.08, 0.17], [x * (r - 0.06), y - 0.01, z * (r - 0.06)]));
    // ribs: from the pole up to the rim, under the fabric
    out.push(cyl(C.white, [0.02, r * 0.9, 0.02], [x * r * 0.45, y - 0.08, z * r * 0.45], 1, [z * 1.2, 0, -x * 1.2]));
  }
  return out;
}

export const OUTDOOR: FurnitureDef[] = [
  {
    key: "bench",
    seat: 0.5,
    name: "벤치",
    emoji: "🪵",
    category: "outdoor",
    placement: "floor",
    size: { w: 2, d: 1, h: 1 },
    palettes: palettes(
      ["slat"],
      [
        ["나무", C.wood],
        ["초록", C.green],
        ["빨강", C.red],
      ],
    ),
    parts: [
      // cast-iron ends: legs, an armrest scroll, a back post
      ...[-0.82, 0.82].flatMap((x) => [
        brick(C.charcoal, [0.07, 0.42, 0.07], [x, 0.21, 0.22], 0.4),
        brick(C.charcoal, [0.07, 0.86, 0.07], [x, 0.43, -0.24], 0.4, [-0.12, 0, 0]),
        brick(C.charcoal, [0.07, 0.06, 0.52], [x, 0.43, 0], 0.4),
        brick(C.charcoal, [0.07, 0.06, 0.46], [x, 0.66, 0.02], 0.4),
        ball(C.charcoal, [0.09, 0.09, 0.09], [x, 0.66, 0.25]),
      ]),
      ...[-0.16, 0, 0.16].map((z) => brick("slat", [1.6, 0.05, 0.13], [0, 0.47, z + 0.04], 0.3)),
      ...[0.66, 0.84].map((y) => brick("slat", [1.6, 0.13, 0.04], [0, y, -0.27 + (y - 0.66) * 0.12], 0.3, [-0.12, 0, 0])),
    ],
  },
  {
    key: "picnic-table",
    name: "피크닉 테이블",
    emoji: "🧺",
    category: "outdoor",
    placement: "floor",
    size: { w: 2, d: 2, h: 1 },
    surface: 0.78,
    parts: [
      // A-frame legs at each end, crossing under the top
      ...[-0.72, 0.72].flatMap((x) => [
        brick(C.woodDark, [0.08, 0.82, 0.1], [x, 0.38, -0.22], 0.3, [-0.55, 0, 0]),
        brick(C.woodDark, [0.08, 0.82, 0.1], [x, 0.38, 0.22], 0.3, [0.55, 0, 0]),
        brick(C.woodDark, [0.08, 0.07, 1.7], [x, 0.4, 0], 0.3),
      ]),
      ...[-0.31, -0.1, 0.1, 0.31].map((z) => brick(C.wood, [1.9, 0.07, 0.19], [0, 0.745, z], 0.3)),
      ...[-0.72, 0.72].flatMap((z) => [
        brick(C.wood, [1.86, 0.06, 0.15], [0, 0.43, z - 0.08], 0.3),
        brick(C.wood, [1.86, 0.06, 0.15], [0, 0.43, z + 0.08], 0.3),
      ]),
    ],
  },
  {
    key: "parasol",
    name: "파라솔",
    emoji: "⛱️",
    category: "outdoor",
    placement: "floor",
    size: { w: 1, d: 1, h: 3 },
    palettes: palettes(
      ["canopy", "stripe"],
      [
        ["빨강", C.red, C.white],
        ["파랑", C.blue, C.white],
        ["노랑", C.yellow, C.orange],
      ],
    ),
    parts: [
      cyl(C.greyLight, [0.42, 0.14, 0.42], [0, 0.07, 0], 0.8), // weighted base
      // proportions of a garden parasol, not a cocktail umbrella: a pole just
      // over head height and a deep canopy
      cyl(C.white, [0.05, 2.0, 0.05], [0, 1.1, 0]),
      cyl(C.white, [0.08, 0.06, 0.08], [0, 1.0, 0]), // the slider
      ...canopy(1.95, 1.0),
    ],
  },
  {
    key: "planter",
    name: "꽃밭 상자",
    emoji: "🌷",
    category: "outdoor",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    palettes: palettes(
      ["flower"],
      [
        ["빨강", C.red],
        ["노랑", C.yellow],
        ["분홍", C.pink],
        ["보라", C.purple],
      ],
    ),
    parts: [
      // a box you can look into, soil below its rim
      ...hollow(C.wood, [0.94, 0.44, 0.94], [0, 0.22, 0], 0.08, C.wood, 0.2),
      brick(C.soil, [0.8, 0.04, 0.8], [0, 0.38, 0], 0.3),
      ...[0.12, 0.3].map((y) => brick(C.woodDark, [0.95, 0.02, 0.02], [0, y, 0.47], 0.3)),
      ...[
        [-0.24, -0.24],
        [0.2, -0.2],
        [-0.2, 0.22],
        [0.24, 0.24],
        [0, 0],
      ].flatMap(([x, z], i) => [
        cyl(C.greenDark, [0.03, 0.26 + (i % 2) * 0.06, 0.03], [x!, 0.53 + (i % 2) * 0.03, z!]),
        ball(C.green, [0.12, 0.04, 0.06], [x! + 0.05, 0.5, z!], [0, 0, 0.5]),
        // a tulip: a cup of three petals
        ...[0, 1, 2].map((k) => {
          const a = (k * 2 * Math.PI) / 3;
          return ball("flower", [0.08, 0.14, 0.08], [x! + Math.cos(a) * 0.035, 0.72 + (i % 2) * 0.06, z! + Math.sin(a) * 0.035]);
        }),
      ]),
    ],
  },
  {
    key: "mailbox",
    name: "우편함",
    emoji: "📮",
    category: "outdoor",
    placement: "floor",
    size: { w: 1, d: 1, h: 2 },
    parts: [
      cyl(C.woodDark, [0.1, 1.0, 0.1], [0, 0.5, 0], 0.9),
      // a rounded-top box: half a cylinder on a box, slot facing you
      brick(C.red, [0.5, 0.22, 0.42], [0, 1.1, 0], 0.15),
      cyl(C.red, [0.5, 0.42, 0.5], [0, 1.21, 0], 1, [QUARTER, 0, 0]),
      cyl(0xc84a3c, [0.46, 0.02, 0.46], [0, 1.21, 0.215], 1, [QUARTER, 0, 0]), // door
      brick(C.white, [0.26, 0.04, 0.02], [0, 1.28, 0.23], 0.3),
      ball(C.gold, [0.05, 0.05, 0.03], [0.15, 1.12, 0.23]),
      // the flag, raised
      cyl(C.yellow, [0.03, 0.32, 0.03], [0.27, 1.32, -0.05]),
      brick(C.yellow, [0.03, 0.12, 0.16], [0.27, 1.43, 0.03], 0.3),
    ],
  },
  {
    key: "doghouse",
    name: "강아지 집",
    emoji: "🐶",
    category: "outdoor",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    palettes: palettes(
      ["wall", "roof"],
      [
        ["빨강", C.red, C.blueDark],
        ["나무", C.woodLight, C.red],
        ["하늘", C.sky, C.yellow],
      ],
    ),
    parts: [
      brick("wall", [0.86, 0.5, 0.86], [0, 0.25, 0], 0.1),
      // gables: a square turned 45° above each end wall makes the triangle
      brick("wall", [0.6, 0.6, 0.86], [0, 0.5, 0], 0.08, [0, 0, Math.PI / 4]),
      // a pitched roof of two slabs meeting at the ridge, with eaves
      brick("roof", [0.66, 0.07, 0.98], [-0.23, 0.69, 0], 0.25, [0, 0, 0.72]),
      brick("roof", [0.66, 0.07, 0.98], [0.23, 0.69, 0], 0.25, [0, 0, -0.72]),
      cyl("roof", [0.08, 1.0, 0.08], [0, 0.92, 0], 1, [QUARTER, 0, 0]), // ridge
      // an arched doorway: a dark box topped by a dark disc
      brick(C.ink, [0.3, 0.26, 0.02], [0, 0.15, 0.43], 0.1),
      cyl(C.ink, [0.3, 0.02, 0.3], [0, 0.28, 0.43], 1, [QUARTER, 0, 0]),
      brick(C.yellow, [0.3, 0.07, 0.02], [0, 0.52, 0.44], 0.3), // name plate
      cyl(C.red, [0.2, 0.06, 0.2], [0.3, 0.03, 0.62 - 0.2], 1.3), // food bowl
      ball(0x8a5a2f, [0.14, 0.03, 0.14], [0.3, 0.06, 0.42]),
    ],
  },
  {
    key: "bbq",
    name: "바비큐 그릴",
    emoji: "🍖",
    category: "outdoor",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    parts: [
      ...legs4(C.charcoal, 0.56, 0.56, 0.44, 0.05, 0.06),
      brick(C.charcoal, [0.5, 0.03, 0.5], [0, 0.16, 0], 0.3), // shelf
      cyl(C.charcoal, [0.1, 0.04, 0.1], [0.22, 0.05, 0.22], 1, [0, 0, QUARTER]), // wheel
      // kettle: a bowl, a grate across its mouth, the lid tipped back on its
      // hinge (fully open it would stand 30 cm into the cell above)
      dome(C.charcoal, [0.68, 0.3, 0.68], [0, 0.5, 0], [Math.PI, 0, 0]),
      cyl(C.ink, [0.66, 0.02, 0.66], [0, 0.655, 0]),
      ...[-0.2, -0.1, 0, 0.1, 0.2].map((x) => brick(C.steel, [0.02, 0.015, 0.6 - Math.abs(x) * 1.2], [x, 0.67, 0], 0.3)),
      dome(C.charcoal, [0.66, 0.18, 0.66], [0, 0.8, -0.2], [-0.5, 0, 0]),
      ball(C.steel, [0.06, 0.04, 0.06], [0, 0.93, -0.08]), // lid handle
      // sausages and a corn cob on the grill
      cyl(C.red, [0.06, 0.24, 0.06], [-0.14, 0.7, 0.05], 1, [0, 0, QUARTER]),
      cyl(C.red, [0.06, 0.24, 0.06], [-0.12, 0.7, 0.16], 1, [0, 0.3, QUARTER]),
      cyl(C.yellow, [0.08, 0.2, 0.08], [0.14, 0.7, 0.1], 0.8, [QUARTER, 0, 0]),
    ],
  },
  {
    key: "street-lamp",
    name: "가로등",
    emoji: "🗼",
    category: "outdoor",
    placement: "floor",
    size: { w: 1, d: 1, h: 3 },
    parts: [
      cyl(C.charcoal, [0.42, 0.16, 0.42], [0, 0.08, 0], 0.8),
      cyl(C.charcoal, [0.24, 0.2, 0.24], [0, 0.26, 0], 0.6),
      cyl(C.charcoal, [0.08, 2.2, 0.08], [0, 1.45, 0], 0.8),
      ball(C.gold, [0.12, 0.08, 0.12], [0, 2.5, 0]),
      // the lantern head: tapered glass, a pointed cap, a finial
      cyl(C.charcoal, [0.3, 0.04, 0.3], [0, 2.56, 0]),
      cyl(C.yellow, [0.34, 0.3, 0.34], [0, 2.73, 0], 1.25),
      ...[0, 1, 2, 3].map((i) => {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        return cyl(C.charcoal, [0.025, 0.3, 0.025], [Math.cos(a) * 0.15, 2.73, Math.sin(a) * 0.15]);
      }),
      cyl(C.charcoal, [0.42, 0.14, 0.42], [0, 2.95, 0], 0.15),
    ],
  },
];
