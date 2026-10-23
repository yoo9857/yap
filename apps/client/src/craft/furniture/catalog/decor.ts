import type { FurnitureDef, PartSpec } from "../types.js";
import { C, QUARTER, WALL_ART_Z, ball, brick, cyl, palettes, wallFrame } from "./kit.js";

/** The paintings' colour schemes: frame, sky, ground, sun. */
const ART = palettes(
  ["frame", "sky", "ground", "sun"],
  [
    ["낮", C.woodDark, C.sky, C.green, C.yellow],
    ["노을", C.gold, C.orange, C.purple, C.red],
    ["밤", C.charcoal, C.blueDark, C.greenDark, C.cream],
    ["눈", C.white, C.greyLight, C.white, C.yellow],
  ],
);

/**
 * A long leaf growing from (x, y, z): a slim ellipsoid tipped `tilt` radians
 * off vertical, toward compass direction `yaw`. Euler XYZ applies z first, so
 * rz = −tilt leans it toward +x and ry = yaw then swings it round; the centre
 * sits half a leaf out along that same direction so the leaf starts at the stem.
 */
function leaf(color: number, len: number, x: number, y: number, z: number, yaw: number, tilt: number): PartSpec {
  const dx = Math.cos(yaw) * Math.sin(tilt);
  const dy = Math.cos(tilt);
  const dz = -Math.sin(yaw) * Math.sin(tilt);
  const half = len * 0.45;
  return ball(color, [len * 0.34, len, len * 0.12], [x + dx * half, y + dy * half, z + dz * half], [0, yaw, -tilt]);
}

export const DECOR: FurnitureDef[] = [
  {
    key: "plant",
    name: "화분",
    emoji: "🪴",
    category: "decor",
    placement: "floor",
    size: { w: 1, d: 1, h: 1 },
    parts: [
      cyl(C.terracotta, [0.5, 0.4, 0.5], [0, 0.2, 0], 1.3), // pot, flaring out
      cyl(0xbd6440, [0.58, 0.08, 0.58], [0, 0.42, 0]), // rim
      cyl(C.soil, [0.46, 0.02, 0.46], [0, 0.465, 0]),
      ball(C.green, [0.4, 0.32, 0.4], [0, 0.62, 0]),
      ball(C.greenDark, [0.28, 0.26, 0.28], [0.14, 0.72, 0.08]),
      ball(C.green, [0.24, 0.24, 0.24], [-0.1, 0.8, -0.05]),
      ...[0, 1.25, 2.5, 3.75, 5.0].map((a, i) => leaf(i % 2 ? C.green : C.greenDark, 0.36, 0, 0.55, 0, a, 0.85)),
      ...[0.6, 2.2, 4.4].map((a) => leaf(0x7bcf7f, 0.3, 0, 0.7, 0, a, 0.35)),
    ],
  },
  {
    key: "succulent",
    name: "작은 화분",
    emoji: "🌵",
    category: "decor",
    placement: "surface",
    size: { w: 1, d: 1, h: 1 },
    parts: [
      cyl(C.terracotta, [0.22, 0.16, 0.22], [0, 0.08, 0], 1.2),
      cyl(0xbd6440, [0.25, 0.04, 0.25], [0, 0.17, 0]),
      cyl(C.soil, [0.2, 0.01, 0.2], [0, 0.19, 0]),
      // a rosette: an outer ring of fat leaves, an inner upright ring, a bud
      ...[0, 1, 2, 3, 4, 5].map((i) => leaf(C.green, 0.13, 0, 0.2, 0, (i * Math.PI) / 3, 1.05)),
      ...[0, 1, 2, 3].map((i) => leaf(0x7bcf7f, 0.11, 0, 0.2, 0, (i * Math.PI) / 2 + 0.4, 0.45)),
      ball(C.pink, [0.05, 0.05, 0.05], [0, 0.29, 0]),
    ],
  },
  {
    key: "vase",
    name: "꽃병",
    emoji: "💐",
    category: "decor",
    placement: "surface",
    size: { w: 1, d: 1, h: 1 },
    palettes: palettes(
      ["vase", "flower"],
      [
        ["하늘", C.sky, C.red],
        ["하양", C.white, C.pink],
        ["노랑", C.yellow, C.purple],
      ],
    ),
    parts: [
      ball("vase", [0.22, 0.26, 0.22], [0, 0.13, 0]),
      cyl("vase", [0.1, 0.12, 0.1], [0, 0.3, 0], 0.8),
      cyl("vase", [0.14, 0.03, 0.14], [0, 0.36, 0]),
      ...(
        [
          [0, 0.6, 0, 0],
          [0.1, 0.54, 0.03, -0.3],
          [-0.09, 0.55, -0.04, 0.3],
        ] as const
      ).flatMap(([x, y, z, lean]) => [
        cyl(C.greenDark, [0.02, y - 0.33, 0.02], [x / 2, (y + 0.33) / 2, z / 2], 1, [0, 0, lean]),
        // a five-petal flower round a yellow heart
        ...[0, 1, 2, 3, 4].map((k) =>
          ball("flower", [0.065, 0.04, 0.065], [x + Math.cos((k * 2 * Math.PI) / 5) * 0.042, y, z + Math.sin((k * 2 * Math.PI) / 5) * 0.042]),
        ),
        ball(C.yellow, [0.045, 0.045, 0.045], [x, y + 0.012, z]),
      ]),
      leaf(C.green, 0.14, 0.01, 0.38, 0, 0.4, 0.9),
      leaf(C.green, 0.12, -0.01, 0.4, 0, 3.4, 0.8),
    ],
  },
  {
    key: "teddy",
    name: "곰인형",
    emoji: "🧸",
    category: "decor",
    placement: "surface",
    size: { w: 1, d: 1, h: 1 },
    palettes: palettes(
      ["fur", "patch"],
      [
        ["갈색", 0xb98454, C.cream],
        ["분홍", C.pink, C.white],
        ["하양", C.cream, C.pink],
      ],
    ),
    parts: [
      ball("fur", [0.3, 0.3, 0.26], [0, 0.16, 0]),
      ball("patch", [0.18, 0.18, 0.04], [0, 0.15, 0.115]), // belly
      ball("fur", [0.12, 0.1, 0.16], [-0.11, 0.06, 0.1]), // legs, sitting
      ball("fur", [0.12, 0.1, 0.16], [0.11, 0.06, 0.1]),
      ball("patch", [0.07, 0.07, 0.02], [-0.11, 0.06, 0.18]),
      ball("patch", [0.07, 0.07, 0.02], [0.11, 0.06, 0.18]),
      ball("fur", [0.1, 0.16, 0.1], [-0.16, 0.2, 0.03], [0, 0, 0.5]), // arms
      ball("fur", [0.1, 0.16, 0.1], [0.16, 0.2, 0.03], [0, 0, -0.5]),
      ball("fur", [0.26, 0.24, 0.24], [0, 0.4, 0.01]),
      ball("fur", [0.09, 0.09, 0.06], [-0.1, 0.52, 0]),
      ball("fur", [0.09, 0.09, 0.06], [0.1, 0.52, 0]),
      ball("patch", [0.05, 0.05, 0.03], [-0.1, 0.52, 0.02]),
      ball("patch", [0.05, 0.05, 0.03], [0.1, 0.52, 0.02]),
      ball("patch", [0.11, 0.08, 0.06], [0, 0.37, 0.12]), // muzzle
      ball(C.ink, [0.04, 0.03, 0.03], [0, 0.39, 0.15]),
      ball(C.ink, [0.035, 0.035, 0.02], [-0.06, 0.44, 0.12]),
      ball(C.ink, [0.035, 0.035, 0.02], [0.06, 0.44, 0.12]),
      brick(C.red, [0.14, 0.06, 0.03], [0, 0.29, 0.12], 0.4), // bow tie
    ],
  },
  {
    key: "globe",
    name: "지구본",
    emoji: "🌍",
    category: "decor",
    placement: "surface",
    size: { w: 1, d: 1, h: 1 },
    parts: [
      cyl(C.woodDark, [0.22, 0.04, 0.22], [0, 0.02, 0], 0.85),
      cyl(C.gold, [0.03, 0.12, 0.03], [0, 0.1, 0]),
      // the axis is tilted, as a real globe's is
      cyl(C.gold, [0.02, 0.36, 0.02], [0, 0.32, 0], 1, [0, 0, 0.4]),
      ball(C.blue, [0.28, 0.28, 0.28], [0, 0.32, 0]),
      ball(C.green, [0.14, 0.12, 0.08], [0.04, 0.36, 0.1]),
      ball(C.green, [0.1, 0.1, 0.08], [-0.08, 0.27, 0.09]),
      ball(C.greenDark, [0.08, 0.06, 0.08], [0.1, 0.27, -0.06]),
      ball(C.white, [0.12, 0.03, 0.12], [-0.05, 0.45, 0]), // ice cap
    ],
  },
  {
    key: "painting",
    name: "그림",
    emoji: "🖼️",
    category: "decor",
    placement: "wall",
    size: { w: 1, d: 1, h: 1 },
    palettes: ART,
    parts: [
      ...wallFrame("frame", "sky", 0.7, 0.56, 0.6),
      ball("ground", [0.6, 0.18, 0.02], [0, 0.42, WALL_ART_Z]),
      ball("sun", [0.12, 0.12, 0.02], [0.16, 0.7, WALL_ART_Z]),
      ball(C.white, [0.16, 0.06, 0.02], [-0.14, 0.72, WALL_ART_Z]),
      cyl(C.gold, [0.04, 0.03, 0.04], [0, 0.95, -0.47], 1, [QUARTER, 0, 0]), // the nail it hangs on
    ],
  },
  {
    key: "big-painting",
    name: "큰 그림",
    emoji: "🏞️",
    category: "decor",
    placement: "wall",
    size: { w: 2, d: 1, h: 1 },
    palettes: ART,
    parts: [
      ...wallFrame("frame", "sky", 1.7, 0.66, 0.58),
      ball("ground", [0.9, 0.26, 0.02], [-0.35, 0.37, WALL_ART_Z]),
      ball("ground", [0.8, 0.2, 0.02], [0.4, 0.36, WALL_ART_Z]),
      ball("sun", [0.14, 0.14, 0.02], [0.5, 0.72, WALL_ART_Z]),
      ball(C.white, [0.22, 0.07, 0.02], [-0.3, 0.74, WALL_ART_Z]),
      ball(C.white, [0.14, 0.05, 0.02], [-0.12, 0.78, WALL_ART_Z]),
    ],
  },
  {
    key: "clock",
    name: "벽시계",
    emoji: "🕰️",
    category: "decor",
    placement: "wall",
    size: { w: 1, d: 1, h: 1 },
    palettes: palettes(
      ["rim"],
      [
        ["빨강", C.red],
        ["나무", C.woodDark],
        ["하늘", C.sky],
      ],
    ),
    parts: [
      // discs facing the room: cylinders turned onto their side
      cyl("rim", [0.52, 0.07, 0.52], [0, 0.62, -0.465], 1, [QUARTER, 0, 0]),
      cyl(C.white, [0.42, 0.02, 0.42], [0, 0.62, -0.425], 1, [QUARTER, 0, 0]),
      ...[0, 1, 2, 3].map((i) => {
        const a = (i * Math.PI) / 2;
        return brick(C.ink, [0.03, 0.06, 0.01], [Math.sin(a) * 0.16, 0.62 + Math.cos(a) * 0.16, -0.41], 0.3, [0, 0, -a]);
      }),
      brick(C.ink, [0.025, 0.12, 0.01], [0, 0.67, -0.405], 0.3), // minute hand at 12
      brick(C.ink, [0.025, 0.09, 0.01], [0.035, 0.62, -0.403], 0.3, [0, 0, -QUARTER]), // hour hand at 3
      cyl(C.red, [0.035, 0.015, 0.035], [0, 0.62, -0.4], 1, [QUARTER, 0, 0]),
    ],
  },
  {
    key: "rug",
    name: "러그",
    emoji: "🧶",
    category: "decor",
    placement: "rug",
    size: { w: 2, d: 2, h: 1 },
    palettes: palettes(
      ["field", "border"],
      [
        ["빨강", C.red, C.yellow],
        ["파랑", C.blue, C.cream],
        ["초록", C.green, C.yellow],
        ["보라", C.purple, C.pink],
      ],
    ),
    parts: [
      brick("border", [1.84, 0.12, 1.84], [0, 0.06, 0], 0.5),
      brick("field", [1.5, 0.02, 1.5], [0, 0.125, 0], 0.5),
      // a diamond in the middle and tassels along two edges
      brick("border", [0.6, 0.012, 0.6], [0, 0.132, 0], 0.4, [0, Math.PI / 4, 0]),
      brick("field", [0.3, 0.008, 0.3], [0, 0.136, 0], 0.4, [0, Math.PI / 4, 0]),
      ...[-0.7, -0.35, 0, 0.35, 0.7].flatMap((x) => [
        brick("border", [0.05, 0.03, 0.08], [x, 0.03, -0.93], 0.4),
        brick("border", [0.05, 0.03, 0.08], [x, 0.03, 0.93], 0.4),
      ]),
    ],
  },
];
