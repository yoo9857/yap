import type { ColorRef, Palette, PartSpec } from "../types.js";

/**
 * The authoring kit for catalog files: short constructors for parts, a few
 * recurring sub-assemblies (legs, frames), and the shared colour set — so a
 * def reads like a parts list and every piece draws from one palette family.
 * Everything here returns plain data.
 */

/** Shared crayon colours. Prefer these over new literals so the set stays one family. */
export const C = {
  wood: 0xc98a4b,
  woodDark: 0x8a5a2f,
  woodLight: 0xe2b77d,
  cream: 0xf6f1e4,
  white: 0xfdfbf6,
  red: 0xe0604f,
  blue: 0x5b8fd9,
  blueDark: 0x3f6fb8,
  sky: 0x9fd8f5,
  yellow: 0xffd84d,
  orange: 0xf29a3f,
  green: 0x5cb85c,
  greenDark: 0x3e9a48,
  pink: 0xf2a0b8,
  purple: 0x9b7fd1,
  terracotta: 0xd2734a,
  soil: 0x5a3d2b,
  charcoal: 0x2b2b33,
  grey: 0x9aa0a8,
  greyLight: 0xd5d9de,
  steel: 0xb8c0c8,
  screen: 0x3a5a8c,
  ink: 0x241d22,
  gold: 0xe8b93c,
} as const;

type V3 = readonly [number, number, number];

/** A soft rounded brick, optionally turned (`rot` = Euler radians). */
export function brick(color: ColorRef, size: V3, at: V3, soft?: number, rot?: V3): PartSpec {
  const p: PartSpec = { shape: "box", color, size, at };
  if (soft !== undefined) p.soft = soft;
  if (rot) p.rot = rot;
  return p;
}

/** A smooth ellipsoid — eyes, leaves, bulbs, cushions' puff. */
export function ball(color: ColorRef, size: V3, at: V3, rot?: V3): PartSpec {
  return rot ? { shape: "ball", color, size, at, rot } : { shape: "ball", color, size, at };
}

/**
 * A cylinder standing on its local y. `taper` = top radius ÷ bottom radius:
 * 1 straight (pole, pot), < 1 narrowing up (lampshade, opened parasol, at 0 a
 * cone), > 1 widening up (a bowl, a basin). `size` w/d are the WIDER end.
 */
export function cyl(color: ColorRef, size: V3, at: V3, taper = 1, rot?: V3): PartSpec {
  const p: PartSpec = { shape: "cyl", color, size, at };
  if (taper !== 1) p.taper = taper;
  if (rot) p.rot = rot;
  return p;
}

/** A half-ellipsoid on a flat base (canopy, lid, cushion top). */
export function dome(color: ColorRef, size: V3, at: V3, rot?: V3): PartSpec {
  return rot ? { shape: "dome", color, size, at, rot } : { shape: "dome", color, size, at };
}

/** Quarter turn about y, for the many parts that face sideways. */
export const QUARTER = Math.PI / 2;

/**
 * Something you can look INTO — a tub, a basin, a planter, a box: a floor and
 * four walls of thickness `wall` around an open top, the outer box `size`
 * centred at `at`. Solid shapes cannot be hollowed, so hollows are built.
 * The inside can be a different colour (`inner`), which is what reads as depth.
 */
export function hollow(color: ColorRef, size: V3, at: V3, wall: number, inner: ColorRef = color, soft = 0.3): PartSpec[] {
  const [w, h, d] = size;
  const [x, y, z] = at;
  const floorY = y - h / 2 + wall / 2;
  const innerW = w - wall * 2;
  const innerD = d - wall * 2;
  return [
    brick(inner, [innerW + 0.01, wall, innerD + 0.01], [x, floorY, z], soft),
    brick(color, [wall, h, d], [x - w / 2 + wall / 2, y, z], soft),
    brick(color, [wall, h, d], [x + w / 2 - wall / 2, y, z], soft),
    brick(color, [innerW + 0.01, h, wall], [x, y, z - d / 2 + wall / 2], soft),
    brick(color, [innerW + 0.01, h, wall], [x, y, z + d / 2 - wall / 2], soft),
  ];
}

/**
 * Four square legs under a top of `w` × `d`, `h` tall from the floor, inset
 * `inset` from the edges. The commonest sub-assembly in the catalog.
 */
export function legs4(color: ColorRef, w: number, d: number, h: number, thick = 0.11, inset = 0.06): PartSpec[] {
  const x = w / 2 - inset - thick / 2;
  const z = d / 2 - inset - thick / 2;
  const out: PartSpec[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(brick(color, [thick, h, thick], [sx * x, h / 2, sz * z]));
  return out;
}

/**
 * A picture frame hung on a wall: back at z = −0.5 (the wall face), `w` × `h`
 * metres, centred at height `cy`. Returns frame + canvas; callers add the art.
 */
export function wallFrame(frame: ColorRef, canvas: ColorRef, w: number, h: number, cy: number): PartSpec[] {
  return [
    brick(frame, [w, h, 0.06], [0, cy, -0.47], 0.25),
    brick(canvas, [w - 0.1, h - 0.1, 0.02], [0, cy, -0.435], 0.2),
  ];
}

/** Front-face z of a wall frame's canvas, for art laid on top of it. */
export const WALL_ART_Z = -0.42;

/** A palette builder that keeps every variant listing the same slots. */
export function palettes<const S extends string>(
  slots: readonly S[],
  variants: readonly (readonly [string, ...number[]])[],
): Palette[] {
  return variants.map(([name, ...values]) => {
    const colors: Record<string, number> = {};
    slots.forEach((slot, i) => (colors[slot] = values[i]!));
    return { name, colors };
  });
}
