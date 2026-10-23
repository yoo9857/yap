import type { FurnitureDef } from "../types.js";
import { C, QUARTER, ball, brick, cyl, dome, hollow, palettes } from "./kit.js";

const TEXTILE = palettes(
  ["cloth", "stripe"],
  [
    ["하늘", C.sky, C.white],
    ["분홍", C.pink, C.white],
    ["노랑", C.yellow, C.orange],
    ["초록", C.green, C.cream],
  ],
);

export const BATH: FurnitureDef[] = [
  {
    key: "bathtub",
    name: "욕조",
    emoji: "🛁",
    category: "bath",
    placement: "floor",
    size: { w: 1, d: 2, h: 1 },
    parts: [
      // clawfoot tub you can see INTO: walls and a floor around open water
      ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => ball(C.gold, [0.16, 0.16, 0.16], [sx * 0.34, 0.08, sz * 0.8]))),
      ...hollow(C.white, [0.96, 0.5, 1.92], [0, 0.4, 0], 0.09, C.white, 0.35),
      // a rolled lip round the top: four strips, so the middle stays OPEN
      brick(C.white, [1.0, 0.07, 0.12], [0, 0.66, -0.92], 0.5),
      brick(C.white, [1.0, 0.07, 0.12], [0, 0.66, 0.92], 0.5),
      brick(C.white, [0.12, 0.07, 1.96], [-0.46, 0.66, 0], 0.5),
      brick(C.white, [0.12, 0.07, 1.96], [0.46, 0.66, 0], 0.5),
      brick(C.sky, [0.79, 0.04, 1.75], [0, 0.5, 0], 0.4), // water, well below the lip
      ball(C.white, [0.22, 0.1, 0.2], [0.15, 0.53, 0.42]),
      ball(C.white, [0.16, 0.08, 0.15], [-0.12, 0.53, 0.56]),
      ball(C.white, [0.12, 0.07, 0.12], [0.02, 0.53, 0.25]),
      ball(C.yellow, [0.11, 0.1, 0.13], [-0.18, 0.56, 0.05]), // a rubber duck
      ball(C.yellow, [0.07, 0.07, 0.07], [-0.18, 0.62, 0.0]),
      ball(C.orange, [0.05, 0.03, 0.05], [-0.18, 0.62, -0.05]),
      // the tap stands on the rim at the head end
      cyl(C.steel, [0.06, 0.22, 0.06], [0, 0.78, -0.88]),
      cyl(C.steel, [0.05, 0.2, 0.05], [0, 0.88, -0.8], 1, [QUARTER, 0, 0]),
      cyl(C.steel, [0.1, 0.04, 0.1], [-0.12, 0.7, -0.88]),
      cyl(C.steel, [0.1, 0.04, 0.1], [0.12, 0.7, -0.88]),
    ],
  },
  {
    key: "toilet",
    seat: 0.52,
    name: "변기",
    emoji: "🚽",
    category: "bath",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    // the seat and lid take the colour: in white-on-white the raised lid
    // vanished into the tank and the seat into the bowl
    palettes: palettes(
      ["seat"],
      [
        ["나무", C.woodLight],
        ["하양", C.white],
        ["분홍", C.pink],
        ["하늘", C.sky],
      ],
    ),
    parts: [
      cyl(C.white, [0.34, 0.3, 0.42], [0, 0.15, 0.06], 0.8), // pedestal
      dome(C.white, [0.06, 0.03, 0.06], [-0.17, 0.015, 0.12]), // floor-bolt caps
      dome(C.white, [0.06, 0.03, 0.06], [0.17, 0.015, 0.12]),
      cyl(C.white, [0.5, 0.18, 0.6], [0, 0.38, 0.1], 1.25), // bowl, wider at the top
      // seat ring, then the opening's dark edge, then the water deep inside
      cyl("seat", [0.54, 0.05, 0.64], [0, 0.495, 0.1]),
      cyl(C.grey, [0.36, 0.006, 0.44], [0, 0.522, 0.12]),
      cyl(C.sky, [0.27, 0.006, 0.34], [0, 0.526, 0.13]),
      cyl("seat", [0.04, 0.03, 0.06], [-0.16, 0.53, -0.19]), // hinges
      cyl("seat", [0.04, 0.03, 0.06], [0.16, 0.53, -0.19]),
      // the lid, raised and leaning back against the tank
      brick("seat", [0.5, 0.045, 0.56], [0, 0.78, -0.23], 0.45, [-1.79, 0, 0]),
      brick(C.white, [0.58, 0.44, 0.18], [0, 0.74, -0.38], 0.25), // tank
      brick(C.white, [0.62, 0.05, 0.22], [0, 0.985, -0.38], 0.4),
      cyl(C.steel, [0.08, 0.02, 0.08], [0.16, 1.015, -0.38]), // flush button
      cyl(C.steel, [0.025, 0.12, 0.025], [-0.26, 0.9, -0.28], 1, [0, 0, QUARTER]), // lever
      // a paper roll on the tank's side
      cyl(C.steel, [0.02, 0.06, 0.02], [0.32, 0.66, -0.38], 1, [0, 0, QUARTER]),
      cyl(C.white, [0.12, 0.11, 0.12], [0.39, 0.66, -0.38], 1, [0, 0, QUARTER]),
      cyl(C.greyLight, [0.04, 0.112, 0.04], [0.39, 0.66, -0.38], 1, [0, 0, QUARTER]),
      brick(C.white, [0.01, 0.12, 0.1], [0.45, 0.56, -0.38], 0.3), // the loose end
    ],
  },
  {
    key: "bath-sink",
    name: "세면대",
    emoji: "🪥",
    category: "bath",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    parts: [
      cyl(C.white, [0.26, 0.7, 0.24], [0, 0.35, -0.12], 0.7), // pedestal
      cyl(C.white, [0.72, 0.2, 0.54], [0, 0.8, -0.05], 1.5), // basin, flaring out
      brick(C.white, [0.74, 0.14, 0.05], [0, 0.95, -0.335], 0.4), // splashback
      cyl(C.greyLight, [0.52, 0.01, 0.36], [0, 0.905, -0.02]), // the hollow you look into
      cyl(C.sky, [0.34, 0.008, 0.22], [0, 0.912, 0]),
      cyl(C.charcoal, [0.05, 0.006, 0.05], [0, 0.918, 0]), // drain
      cyl(C.charcoal, [0.05, 0.006, 0.02], [0, 0.9, -0.21], 1, [QUARTER, 0, 0]), // overflow
      // mixer tap with hot and cold
      cyl(C.steel, [0.05, 0.12, 0.05], [0, 0.96, -0.28]),
      cyl(C.steel, [0.045, 0.13, 0.045], [0, 1.01, -0.225], 1, [QUARTER, 0, 0]),
      cyl(C.blue, [0.06, 0.04, 0.06], [-0.12, 0.93, -0.27]),
      cyl(C.red, [0.06, 0.04, 0.06], [0.12, 0.93, -0.27]),
      // a bar of soap on the rim, and a cup with a toothbrush
      brick(C.pink, [0.09, 0.035, 0.06], [0.27, 0.915, 0.04], 0.5),
      cyl(C.sky, [0.07, 0.1, 0.07], [-0.26, 0.95, -0.14], 0.85),
      cyl(C.yellow, [0.015, 0.13, 0.015], [-0.255, 0.985, -0.14], 1, [0, 0, -0.2]),
      brick(C.white, [0.02, 0.03, 0.02], [-0.243, 1.03, -0.13], 0.3, [0, 0, -0.2]),
    ],
  },
  {
    key: "shower",
    name: "샤워실",
    emoji: "🚿",
    category: "bath",
    placement: "floor",
    size: { w: 1, d: 1, h: 2 },
    palettes: TEXTILE,
    parts: [
      brick(C.white, [0.96, 0.14, 0.96], [0, 0.07, 0], 0.3), // tray, over the floor studs
      cyl(C.steel, [0.08, 0.01, 0.08], [0.1, 0.145, 0.05]), // drain
      brick(C.white, [0.96, 1.82, 0.06], [0, 1.05, -0.45], 0.12),
      brick(C.white, [0.06, 1.82, 0.9], [-0.45, 1.05, 0.03], 0.12),
      // tile joints
      ...[0.5, 0.95, 1.4].map((y) => brick(C.greyLight, [0.9, 0.02, 0.01], [0, y, -0.418], 0.2)),
      ...[-0.15, 0.15].map((x) => brick(C.greyLight, [0.02, 1.78, 0.01], [x, 1.05, -0.418], 0.2)),
      // riser, arm and a shower head that is a real cone
      cyl(C.steel, [0.04, 1.2, 0.04], [0.25, 1.2, -0.4]),
      cyl(C.steel, [0.035, 0.2, 0.035], [0.25, 1.82, -0.31], 1, [QUARTER, 0, 0]),
      cyl(C.steel, [0.2, 0.08, 0.2], [0.25, 1.78, -0.2], 0.35, [Math.PI, 0, 0]),
      cyl(C.steel, [0.07, 0.03, 0.07], [0.25, 1.0, -0.4], 1, [QUARTER, 0, 0]), // mixer
      // curtain rail and a curtain hanging in soft folds
      cyl(C.steel, [0.03, 0.92, 0.03], [0.45, 1.9, 0.02], 1, [QUARTER, 0, 0]),
      ...[-0.3, -0.12, 0.06].map((z, i) => brick(i % 2 ? "stripe" : "cloth", [0.05, 1.6, 0.2], [0.45 - (i % 2) * 0.03, 1.08, z], 0.45)),
    ],
  },
  {
    key: "towel-rack",
    name: "수건걸이",
    emoji: "🧻",
    category: "bath",
    placement: "wall",
    size: { w: 1, d: 1, h: 1 },
    palettes: TEXTILE,
    parts: [
      cyl(C.steel, [0.08, 0.03, 0.08], [-0.34, 0.74, -0.485], 1, [QUARTER, 0, 0]),
      cyl(C.steel, [0.08, 0.03, 0.08], [0.34, 0.74, -0.485], 1, [QUARTER, 0, 0]),
      cyl(C.steel, [0.035, 0.12, 0.035], [-0.34, 0.74, -0.42], 1, [QUARTER, 0, 0]),
      cyl(C.steel, [0.035, 0.12, 0.035], [0.34, 0.74, -0.42], 1, [QUARTER, 0, 0]),
      cyl(C.steel, [0.04, 0.74, 0.04], [0, 0.74, -0.37], 1, [0, 0, QUARTER]),
      // a towel folded over the bar: a short back flap, the roll, a long front
      brick("cloth", [0.52, 0.28, 0.04], [0, 0.6, -0.4], 0.35),
      cyl("cloth", [0.09, 0.52, 0.09], [0, 0.74, -0.37], 1, [0, 0, QUARTER]),
      brick("cloth", [0.52, 0.5, 0.04], [0, 0.5, -0.33], 0.35),
      brick("stripe", [0.52, 0.05, 0.045], [0, 0.33, -0.33], 0.3),
      brick("stripe", [0.52, 0.03, 0.045], [0, 0.4, -0.33], 0.3),
    ],
  },
  {
    key: "bath-mat",
    name: "발매트",
    emoji: "🧼",
    category: "bath",
    placement: "rug",
    size: { w: 1, d: 2, h: 1 },
    palettes: TEXTILE,
    parts: [
      brick("cloth", [0.8, 0.12, 1.6], [0, 0.06, 0], 0.5),
      brick("stripe", [0.62, 0.02, 0.06], [0, 0.125, -0.6], 0.4),
      brick("stripe", [0.62, 0.02, 0.06], [0, 0.125, 0.6], 0.4),
    ],
  },
];
