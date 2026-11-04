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
