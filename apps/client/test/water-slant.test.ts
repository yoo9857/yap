// Water running over blocks at different heights must come down as upright sheets and level tops,
// not as slanted panels: blocks hanging in the air with two sources poured on them, the water
// settled by the real rules, then every triangle well above the ground stream that is neither
// upright nor level, AND a big panel on its own, is added up. (All tilted faces together were 27 m²
// with the first mesher; the rounded rims water pours over are about 10 of today's, by design.)
import { expect, it } from "vitest";

/** m² of big tilted panels allowed in this scene. (1.5 with 0.34 m sheets; a film 0.09 m thin
 *  steps further where it meets a whole cell of water — an inside corner, a free fall: 1.73;
 *  1.27 once a sheet's foot and its saddle points kept to the sheet.) */
const BIG_PANELS = 1.6; // 1.55 with falls in the open drawn 0.6 m wide (they step in where one starts)
import { FluidSim, WATER, isWater, type FluidWorld } from "@robo/shared";
import { VoxelWorld } from "../src/craft/voxelWorld.js";
import { buildWaterGeometry } from "../src/craft/waterMesher.js";
import { blockByKey } from "../src/craft/blocks.js";
it("running water over stacked blocks has few slanted faces", () => {
  const w = new VoxelWorld(), S = blockByKey("stone")!.id, Y = 3, cx = 40, cz = 40;
  for (let x = 20; x < 60; x++) for (let z = 20; z < 60; z++) for (let y = 0; y < Y; y++) w.set(x, y, z, S);
  for (let x = cx - 2; x <= cx; x++) w.set(x, Y + 1, cz, S);
  w.set(cx + 2, Y + 1, cz, S); w.set(cx + 2, Y + 2, cz + 1, S); w.set(cx + 1, Y, cz + 2, S);
  const fw: FluidWorld = { get: (x, y, z) => w.get(x, y, z), open: (x, y, z) => w.inBounds(x, y, z), set: (x, y, z, id) => { w.set(x, y, z, id); } };
  const sim = new FluidSim();
  for (const [x, y, z] of [[cx - 1, Y + 2, cz], [cx + 2, Y + 3, cz + 1]] as const) { w.set(x, y, z, WATER); sim.touch(x, y, z); }
  for (let i = 0; i < 300 && sim.busy; i++) sim.step(fw);
  const cells: number[] = [];
  for (let y = 0; y < 12; y++) for (let z = 20; z < 60; z++) for (let x = 20; x < 60; x++) if (isWater(w.get(x, y, z))) cells.push(x, y, z);
  const g = buildWaterGeometry(w, cells)!, p = g.getAttribute("position"), idx = g.index!;
  let slantArea = 0, total = 0, curved = 0;
  for (let i = 0; i < idx.count; i += 3) {
    const v = [0, 1, 2].map((k) => { const j = idx.getX(i + k); return [p.getX(j), p.getY(j), p.getZ(j)]; });
    const a = v[1]!.map((c, k) => c - v[0]![k]!), b = v[2]!.map((c, k) => c - v[0]![k]!);
    const n = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
    const len = Math.hypot(...n), area = len / 2; if (area < 1e-6) continue;
    const ny = Math.abs(n[1]! / len); total += area;
    const cy = (v[0]![1]! + v[1]![1]! + v[2]![1]!) / 3;
    // a big tilted PANEL (a quarter of a square metre in one triangle): the rounded rim water
    // pours over is tilted too, but in small faces, and that curve is wanted
    if (ny > 0.3 && ny < 0.92 && cy > Y + 0.7 && area > 0.2) slantArea += area;
    if (ny > 0.3 && ny < 0.92 && cy > Y + 0.7) curved += area;
  }
  expect(total).toBeGreaterThan(200); // the scene really flooded
  console.log("big tilted panels", slantArea.toFixed(2), "m2; all tilted faces", curved.toFixed(2), "m2");
  expect(slantArea).toBeLessThan(BIG_PANELS);
  g.dispose();
});
