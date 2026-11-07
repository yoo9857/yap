import { afterEach, describe, expect, it, vi } from "vitest";

/** Blocked site data must not fail a mode's boot: the saves fall back to memory. */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("browserStorage", () => {
  it("falls back to memory when reading localStorage throws", async () => {
    const blocked = {};
    Object.defineProperty(blocked, "localStorage", { get: () => { throw new DOMException("denied", "SecurityError"); } });
    vi.stubGlobal("window", blocked);
    const { browserStorage } = await import("../src/ui/storage.js");
    const s = browserStorage();
    expect(s.getItem("a")).toBeNull();
    s.setItem("a", "1");
    expect(browserStorage().getItem("a")).toBe("1"); // the same store for the whole session
    expect(s.length).toBe(1);
    s.removeItem("a");
    expect(s.getItem("a")).toBeNull();
  });

  it("falls back when the storage exists but throws on use", async () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error("blocked"); } } });
    const { browserStorage } = await import("../src/ui/storage.js");
    expect(() => browserStorage().setItem("k", "v")).not.toThrow();
    expect(browserStorage().getItem("k")).toBe("v");
  });

  it("uses the real localStorage when it works", async () => {
    const real = { getItem: () => null, setItem: () => {} };
    vi.stubGlobal("window", { localStorage: real });
    const { browserStorage } = await import("../src/ui/storage.js");
    expect(browserStorage()).toBe(real);
  });
});
