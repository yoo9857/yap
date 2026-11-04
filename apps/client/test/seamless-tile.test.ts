import { describe, expect, it } from "vitest";
import { wrapSeamless, type Pixels } from "../src/craft/kitSurface.js";

/** A grey ramp image with a 4 px black frame — the shape of the catalog tiles. */
function framedRamp(size: number): Pixels {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const frame = x < 4 || y < 4 || x >= size - 4 || y >= size - 4;
    const v = frame ? 0 : 40 + Math.round((x / size) * 180);
    data.set([v, v, v, 255], (y * size + x) * 4);
  }
  return { width: size, height: size, data };
}
const at = (p: Pixels, x: number, y: number) => p.data[(y * p.width + x) * 4]!;

describe("wrapSeamless (world block tiles)", () => {
  it("wraps without a jump: the last column continues into the first", () => {
    const src = framedRamp(64);
    // crop the frame first, as framelessTile does
    const inner: Pixels = { width: 56, height: 56, data: new Uint8ClampedArray(56 * 56 * 4) };
    for (let y = 0; y < 56; y++) for (let x = 0; x < 56; x++) for (let c = 0; c < 4; c++) inner.data[(y * 56 + x) * 4 + c] = src.data[((y + 4) * 64 + x + 4) * 4 + c]!;
    const out = wrapSeamless(inner);
    const w = out.width;
    // across the wrap the step is no bigger than an ordinary neighbouring step inside the image
    const inside = Math.abs(at(out, w / 2, 10) - at(out, w / 2 + 1, 10));
    const across = Math.abs(at(out, w - 1, 10) - at(out, 0, 10));
    expect(across).toBeLessThanOrEqual(inside + 4);
    // the raw ramp would have jumped by its whole range there
    expect(Math.abs(at(inner, 55, 10) - at(inner, 0, 10))).toBeGreaterThan(100);
  });

  it("shrinks by the blend margin and keeps alpha", () => {
    const out = wrapSeamless(framedRamp(100), 0.1);
    expect(out.width).toBe(90);
    expect(out.height).toBe(90);
    expect(out.data[3]).toBe(255);
  });
});

describe("removeInk (the tile art's own lines)", () => {
  /** A flat warm tile (200) crossed by a 3 px near-black line, like plank gaps. */
  function lined(size = 48): Pixels {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const v = y >= 20 && y < 23 ? 15 : 200;
      data.set([v, v, v, 255], (y * size + x) * 4);
    }
    return { width: size, height: size, data };
  }

  it("lifts a black line into the colour around it, a little shaded so the shape still shows", async () => {
    const { removeInk } = await import("../src/craft/kitSurface.js");
    const out = removeInk(lined());
    const line = at(out, 10, 21), around = at(out, 10, 5);
    expect(around).toBe(200); // the material itself is untouched
    expect(line).toBeGreaterThan(160); // was 15
    expect(line).toBeLessThan(around); // still a faint seam
  });

  it("leaves a tile without ink exactly as it was", async () => {
    const { removeInk } = await import("../src/craft/kitSurface.js");
    const flat: Pixels = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4).fill(180) };
    expect([...removeInk(flat).data]).toEqual([...flat.data]);
  });

  it("lifts thin lines but keeps a dark AREA that is part of the picture (coal, a face)", async () => {
    const { removeInk } = await import("../src/craft/kitSurface.js");
    const size = 48, data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const lump = x >= 10 && x < 22 && y >= 10 && y < 22; // a 12 px coal lump
      const line = y === 32 || y === 33; // a 2 px ink line
      const v = lump || line ? 12 : 190;
      data.set([v, v, v, 255], (y * size + x) * 4);
    }
    const out = removeInk({ width: size, height: size, data });
    expect(at(out, 16, 16)).toBeLessThan(40); // the lump's middle stays dark
    expect(at(out, 40, 32)).toBeGreaterThan(140); // the line is gone
  });

  it("keeps the cracks of cracked stone bricks (the only tile whose thin lines are the picture)", async () => {
    const { KEEP_INK } = await import("../src/craft/kitSurface.js");
    expect([...KEEP_INK]).toEqual(["cracked-stone-bricks"]);
  });
});
