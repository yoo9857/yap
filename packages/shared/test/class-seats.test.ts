import { describe, expect, it } from "vitest";
import { PLOT, PLOT_COLS, PLOT_FRONT, plotCorners, seatLayout } from "../src/classSeats.js";

const TEACHER: [number, number, number] = [100.3, 5, -40.8];

/** A plot as an axis-aligned box [minX, maxX, minZ, maxZ]. */
const box = (spot: ReturnType<typeof seatLayout>[number]) => {
  const c = plotCorners(spot);
  const xs = c.map((p) => p[0]);
  const zs = c.map((p) => p[1]);
  return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)] as const;
};

describe("classroom plots: every student gets their own 15 × 20 plot", () => {
  it("each plot is 15 across × 20 deep, on cell boundaries, with its student inside facing the teacher", () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2 + 0.2]) {
      for (const spot of seatLayout(7, TEACHER, yaw)) {
        const [x0, x1, z0, z1] = box(spot);
        const across = Math.abs(Math.round(Math.sin(yaw))) === 1 ? z1 - z0 : x1 - x0;
        const deep = Math.abs(Math.round(Math.sin(yaw))) === 1 ? x1 - x0 : z1 - z0;
        expect([across, deep]).toEqual([PLOT.width, PLOT.depth]);
        for (const v of [x0, x1, z0, z1]) expect(v).toBe(Math.round(v)); // edges on cell boundaries
        expect(spot.pos[0]).toBeGreaterThan(x0);
        expect(spot.pos[0]).toBeLessThan(x1);
        expect(spot.pos[2]).toBeGreaterThan(z0);
        expect(spot.pos[2]).toBeLessThan(z1);
        // facing back toward the teacher
        const tx = TEACHER[0] - spot.pos[0];
        const tz = TEACHER[2] - spot.pos[2];
        expect(Math.sin(spot.yaw) * tx + Math.cos(spot.yaw) * tz).toBeGreaterThan(0);
      }
    }
  });

  it("plots never overlap, and neighbours share a fence line exactly", () => {
    for (const count of [2, 6, 7, 13, 30]) {
      const boxes = seatLayout(count, TEACHER, 0).map(box);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const [a0, a1, b0, b1] = boxes[i]!;
          const [c0, c1, d0, d1] = boxes[j]!;
          const ox = Math.min(a1, c1) - Math.max(a0, c0);
          const oz = Math.min(b1, d1) - Math.max(b0, d0);
          expect(ox <= 0 || oz <= 0).toBe(true);
        }
      }
    }
    const [a, b] = seatLayout(2, TEACHER, 0).map(box);
    expect(a![0] === b![1] || a![1] === b![0]).toBe(true); // side by side, one shared edge
  });

  it("rows of at most six, the first row PLOT_FRONT cells ahead of the teacher, the last row centred", () => {
    const spots = seatLayout(8, TEACHER, 0); // 6 + 2
    const rows = [...new Set(spots.map((s) => s.pos[2]))].sort((p, q) => p - q);
    expect(rows).toHaveLength(2);
    expect(spots.filter((s) => s.pos[2] === rows[0]).length).toBe(PLOT_COLS);
    const front = Math.min(...spots.map((s) => box(s)[2]));
    expect(front - (Math.floor(TEACHER[2]) + 0.5)).toBeCloseTo(0.5 + PLOT_FRONT);
    expect(rows[1]! - rows[0]!).toBe(PLOT.depth);
    const cx = Math.floor(TEACHER[0]) + 0.5;
    const back = spots.filter((s) => s.pos[2] === rows[1]).map((s) => s.pos[0] - cx);
    expect(Math.abs(back[0]! + back[1]!)).toBeLessThanOrEqual(1); // centred (half a cell for the grid)
  });

  it("reads left → right as the teacher sees it (facing +z the teacher's left is +x)", () => {
    const [first, second] = seatLayout(2, TEACHER, 0);
    expect(first!.pos[0]).toBeGreaterThan(second!.pos[0]);
  });

  it("an empty class gets no plots", () => {
    expect(seatLayout(0, TEACHER, 0)).toEqual([]);
  });
});
