import { describe, expect, it } from "vitest";
import { parseSettings } from "../src/ui/settings.js";

describe("parseSettings", () => {
  it("defaults to Korean, normal sensitivity and full volume", () => {
    expect(parseSettings(null)).toEqual({ lang: "ko", sensitivity: 1, music: 1, sfx: 1 });
  });

  it("keeps valid stored values", () => {
    expect(parseSettings(JSON.stringify({ lang: "en", sensitivity: 1.6, music: 0.4, sfx: 0 }))).toEqual({
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
    expect(s).toEqual({ lang: "ko", sensitivity: 1, music: 1, sfx: 1 });
  });
});
