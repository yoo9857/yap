import { describe, expect, it } from "vitest";
import {
  PANEL_BUTTONS,
  PANEL_H,
  PANEL_W,
  hitTestPanel,
  type VrPanelAction,
} from "../src/builder/vrPanel.js";

/** Canvas-space point → the UV a three raycast would report (v is bottom-up). */
function uvOf(x: number, y: number): [number, number] {
  return [x / PANEL_W, 1 - y / PANEL_H];
}

/** The UV at a button's centre. */
function centerUv(id: VrPanelAction): [number, number] {
  const b = PANEL_BUTTONS.find((x) => x.id === id)!;
  return uvOf(b.x + b.w / 2, b.y + b.h / 2);
}

describe("VR wrist panel layout", () => {
  it("offers every action the idle loop needs, plus a view cut", () => {
    const ids = PANEL_BUTTONS.map((b) => b.id);
    // without these four purchases a VR session cannot progress at all: gold
    // just piles up while the build rate stays frozen
    expect(ids).toEqual(expect.arrayContaining(["worker", "speed", "value", "crane"]));
    expect(ids).toContain("next");
  });

  it("keeps every button inside the canvas", () => {
    for (const b of PANEL_BUTTONS) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(PANEL_W);
      expect(b.y + b.h).toBeLessThanOrEqual(PANEL_H);
    }
  });

  it("never overlaps two buttons", () => {
    for (let i = 0; i < PANEL_BUTTONS.length; i++) {
      for (let j = i + 1; j < PANEL_BUTTONS.length; j++) {
        const a = PANEL_BUTTONS[i]!;
        const b = PANEL_BUTTONS[j]!;
        const disjoint =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(disjoint).toBe(true);
      }
    }
  });

  it("keeps buttons big enough to hit with a controller ray", () => {
    // a shaky ray at arm's length needs a target measured in centimetres, not
    // millimetres — the panel is 0.34 m wide, so ~110 px reads as ~6 cm
    for (const b of PANEL_BUTTONS) {
      expect(b.w).toBeGreaterThan(80);
      expect(b.h).toBeGreaterThan(80);
    }
  });

  it("leaves the top of the panel free for the readout", () => {
    // progress, gold, crew and the goal line live above the buttons
    const topmost = Math.min(...PANEL_BUTTONS.map((b) => b.y));
    expect(topmost).toBeGreaterThan(PANEL_H * 0.5);
  });
});

describe("VR wrist panel hit test", () => {
  it("hits each button at its centre", () => {
    for (const b of PANEL_BUTTONS) {
      const [u, v] = centerUv(b.id);
      expect(hitTestPanel(u, v)).toBe(b.id);
    }
  });

  it("does not mix up neighbours — every button is reachable and distinct", () => {
    const hit = new Set<VrPanelAction>();
    for (const b of PANEL_BUTTONS) {
      const [u, v] = centerUv(b.id);
      hit.add(hitTestPanel(u, v)!);
    }
    expect(hit.size).toBe(PANEL_BUTTONS.length);
  });

  it("returns null above the buttons, where the readout is", () => {
    expect(hitTestPanel(0.5, 1 - 40 / PANEL_H)).toBeNull();
    expect(hitTestPanel(0.5, 1 - 150 / PANEL_H)).toBeNull();
  });

  it("returns null in the gaps between buttons", () => {
    const a = PANEL_BUTTONS[0]!;
    const b = PANEL_BUTTONS[1]!;
    const gapX = (a.x + a.w + b.x) / 2;
    const [u, v] = uvOf(gapX, a.y + a.h / 2);
    expect(hitTestPanel(u, v)).toBeNull();
  });

  it("rejects UVs off the panel rather than clamping into a button", () => {
    // a ray that misses must not register as a press on the nearest edge
    for (const [u, v] of [
      [-0.01, 0.2],
      [1.01, 0.2],
      [0.5, -0.01],
      [0.5, 1.01],
    ]) {
      expect(hitTestPanel(u!, v!)).toBeNull();
    }
  });

  it("maps v bottom-up, not top-down", () => {
    // the buttons sit at the BOTTOM of the canvas, so they must answer to LOW v.
    // getting this backwards silently swaps the readout and the buttons.
    const [, v] = centerUv("worker");
    expect(v).toBeLessThan(0.5);
    expect(hitTestPanel(0.5, 1 - v)).toBeNull();
  });
});
