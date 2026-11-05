import { describe, expect, it } from "vitest";
import { parseSettings } from "../src/ui/settings.js";

describe("parseSettings", () => {
  it("defaults to Korean, normal sensitivity and full volume", () => {
    expect(parseSettings(null)).toMatchObject({ lang: "ko", sensitivity: 1, music: 1, sfx: 1 });
  });

  it("keeps valid stored values", () => {
    expect(parseSettings(JSON.stringify({ lang: "en", sensitivity: 1.6, music: 0.4, sfx: 0 }))).toMatchObject({
      lang: "en", sensitivity: 1.6, music: 0.4, sfx: 0,
    });
  });

  it("clamps out-of-range numbers instead of rejecting them", () => {
    const s = parseSettings(JSON.stringify({ sensitivity: 99, music: -3, sfx: 7 }));
    expect(s.sensitivity).toBe(2.5);
    expect(s.music).toBe(0);
    expect(s.sfx).toBe(1);
  });

  it("falls back field by field on garbage", () => {
    expect(parseSettings("{not json")).toEqual(parseSettings(null));
    const s = parseSettings(JSON.stringify({ lang: "fr", sensitivity: "fast", music: null, sfx: Number.NaN }));
    expect(s).toMatchObject({ lang: "ko", sensitivity: 1, music: 1, sfx: 1 });
  });

  it("new fields default sensibly and old records gain them", () => {
    const old = parseSettings(JSON.stringify({ lang: "en", sensitivity: 1.5, music: 0.5, sfx: 0.2 }));
    expect(old).toMatchObject({ lang: "en", sensitivity: 1.5, fov: 70, invertY: false, uiScale: 1, view: 1, hints: false });
  });

  it("clamps the field of view, interface size and view distance, and refuses junk", () => {
    expect(parseSettings(JSON.stringify({ fov: 20, uiScale: 9, view: 7 }))).toMatchObject({ fov: 60, uiScale: 1.3, view: 2 });
    expect(parseSettings(JSON.stringify({ fov: 150, uiScale: 0.1, view: -3 }))).toMatchObject({ fov: 100, uiScale: 0.8, view: 0 });
    expect(parseSettings(JSON.stringify({ fov: "wide", uiScale: null, view: "far", invertY: "yes", hints: 1 }))).toMatchObject({ fov: 70, uiScale: 1, view: 1, invertY: false, hints: false });
    // steps: whole degrees, 5 % interface steps, whole presets
    expect(parseSettings(JSON.stringify({ fov: 77.6, uiScale: 1.12, view: 1.4 }))).toMatchObject({ fov: 78, uiScale: 1.1, view: 1 });
  });
});
