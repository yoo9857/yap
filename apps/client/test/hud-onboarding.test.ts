import { afterEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_S, readPlayed } from "../src/craft/craftHud.js";

// The always-on control hints (key strip, "F change shape") teach the first ONBOARDING_S seconds
// of play, then step aside. The play time lives in localStorage, which can be missing, blocked or
// hold anything: every case must read as a sane number, never throw.
function storage(get: (k: string) => string | null) {
  vi.stubGlobal("localStorage", { getItem: get, setItem: () => undefined });
}

describe("onboarding play time", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a new player has played nothing", () => {
    storage(() => null);
    expect(readPlayed()).toBe(0);
  });

  it("reads what was saved, capped at the onboarding length", () => {
    storage(() => "42");
    expect(readPlayed()).toBe(42);
    storage(() => String(ONBOARDING_S * 10));
    expect(readPlayed()).toBe(ONBOARDING_S);
  });

  it("garbage and negative values read as a new player", () => {
    for (const v of ["abc", "-5", "NaN", "Infinity", ""]) {
      storage(() => v);
      expect(readPlayed(), v).toBe(0);
    }
  });

  it("blocked storage (private window, cleared site data) reads as a new player", () => {
    storage(() => {
      throw new Error("SecurityError");
    });
    expect(readPlayed()).toBe(0);
  });
});
