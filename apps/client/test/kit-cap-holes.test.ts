import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { cleanLoop, kitFootprintGeometry } from "../src/craft/kitShell.js";

/** Area of the cap (triangles lying flat at y = 1, facing up) of a one-layer kit footprint. */
function capArea(g: THREE.BufferGeometry): number {
  const p = g.getAttribute("position"), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let area = 0;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    if ([a, b, c].every((v) => Math.abs(v.y - 1) < 1e-4)) area += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
  }
  return area;
}

describe("kit caps never lose triangles (players: blocks with holes here and there)", () => {
  // Captured from a live field: two cobblestones at (84, 89) and (84, 90), other blocks beside and
  // below them. At exactly these coordinates the inset outline carried corner points that differed by
  // float noise, earcut misread them, and half the top cap was gone; one cell over it was whole.
  const solid = new Set(["84,-1,89", "84,0,89", "84,-1,90", "84,0,90", "84,-1,91", "84,0,91", "85,-1,88", "85,0,88"]);
  const island = (dx: number, dz: number) =>
    kitFootprintGeometry([[84 - dx, 89 - dz], [84 - dx, 90 - dz]],
      (x, z) => solid.has(`${x + dx},0,${z + dz}`),
      (x, z, dy) => solid.has(`${x + dx},${dy},${z + dz}`));

  it("the captured island has its whole cap, at its real coordinates and shifted", () => {
    const whole = capArea(island(1, 0));
    expect(whole).toBeGreaterThan(1.8);
    expect(capArea(island(0, 0))).toBeCloseTo(whole, 3); // was 0.937
    for (const [dx, dz] of [[80, 80], [0, 1], [-40, 17]] as const) expect(capArea(island(dx, dz))).toBeCloseTo(whole, 3);
  });

  it("cleanLoop drops near-duplicates and collinear points, keeps real corners", () => {
    const noisy: [number, number][] = [[0, 0], [1e-14, 0], [0.5, 0], [1, 0], [1, 1 - 1e-15], [1, 1], [0, 1]];
    const cleaned = cleanLoop(noisy);
    expect(cleaned.length).toBe(4);
    for (const corner of [[1, 0], [1, 1], [0, 1]]) expect(cleaned.some((p) => Math.hypot(p[0] - corner[0]!, p[1] - corner[1]!) < 1e-9)).toBe(true);
  });
});
