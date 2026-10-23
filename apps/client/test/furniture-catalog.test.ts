import { describe, expect, it } from "vitest";
import { CATALOG, CATEGORIES, furnitureDef, inCategory, isFurnitureKind, searchCatalog, variantCount } from "../src/craft/furniture/catalog/index.js";
import { localBounds } from "../src/craft/furniture/footprint.js";
import { RUG_TOP } from "../src/craft/furniture/layout.js";
import type { FurnitureDef } from "../src/craft/furniture/types.js";

/**
 * The catalog is data that the physics, the save, the renderer and the panel
 * all trust. Each kind of mistake in an entry breaks a different one of them,
 * and none of them is visible until someone places that exact piece — so every
 * entry is checked here instead. A new piece that passes this file is safe to
 * ship as far as the code is concerned; how it LOOKS is for a screenshot.
 */

/** Model overhang allowed past its cells (rounded bricks, a lampshade). */
const SLACK = 0.06;

const slotsOf = (def: FurnitureDef): string[] =>
  [...def.parts, ...(def.openParts ?? [])].flatMap((p) => (typeof p.color === "string" ? [p.color] : []));

describe("furniture catalog", () => {
  it("has unique, stable, kebab-case keys", () => {
    const keys = CATALOG.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key, key).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it("still knows every key that ever shipped (they are in players' saves)", () => {
    for (const key of ["chair", "table", "sofa", "bed", "bookshelf", "lamp", "plant", "tv"]) {
      expect(isFurnitureKind(key), key).toBe(true);
    }
  });

  it("rejects anything that is not a key, including Object's own members", () => {
    for (const junk of ["", "Chair", "toString", "constructor", "__proto__", "hasOwnProperty", null, 3, {}]) {
      expect(isFurnitureKind(junk), JSON.stringify(junk)).toBe(false);
    }
  });

  it("files every piece under a known category, at most nine per category", () => {
    const known = new Set(CATEGORIES.map((c) => c.key));
    for (const def of CATALOG) expect(known.has(def.category), def.key).toBe(true);
    for (const cat of CATEGORIES) {
      const n = inCategory(cat.key).length;
      expect(n, cat.key).toBeGreaterThan(0);
      // the furniture bar is driven by the 1-9 keys
      expect(n, cat.key).toBeLessThanOrEqual(9);
    }
  });

  it("gives every piece panel copy and a sane size", () => {
    for (const def of CATALOG) {
      expect(def.name.length, def.key).toBeGreaterThan(0);
      expect(def.emoji.length, def.key).toBeGreaterThan(0);
      expect(def.parts.length, def.key).toBeGreaterThan(0);
      const { w, d, h } = def.size;
      for (const n of [w, d, h]) {
        expect(Number.isInteger(n) && n >= 1 && n <= 3, `${def.key} size`).toBe(true);
      }
    }
  });

  it("keeps placement-specific shapes to what the rules can hold", () => {
    for (const def of CATALOG) {
      const { w, d, h } = def.size;
      if (def.placement === "surface") expect([w, d, h], def.key).toEqual([1, 1, 1]);
      if (def.placement === "rug") expect(h, def.key).toBe(1);
      if (def.placement === "wall") expect(d, def.key).toBe(1);
      if (def.surface !== undefined) {
        // only a one-high floor piece can carry things on top of its own cell
        expect(def.placement, def.key).toBe("floor");
        expect(h, def.key).toBe(1);
        expect(def.surface, def.key).toBeGreaterThan(0.2);
        expect(def.surface, def.key).toBeLessThan(1);
      }
    }
  });

  it("keeps every model inside the cells it claims", () => {
    // A model that spills out of its footprint pokes through neighbouring
    // blocks and furniture, and its collider (the cells) no longer matches
    // what the player sees.
    for (const def of CATALOG) {
      const b = localBounds(def);
      const { w, d, h } = def.size;
      const where = `${def.key} ${JSON.stringify(b)}`;
      expect(b.min[0], where).toBeGreaterThanOrEqual(-w / 2 - SLACK);
      expect(b.max[0], where).toBeLessThanOrEqual(w / 2 + SLACK);
      expect(b.min[2], where).toBeGreaterThanOrEqual(-d / 2 - SLACK);
      expect(b.max[2], where).toBeLessThanOrEqual(d / 2 + SLACK);
      expect(b.min[1], where).toBeGreaterThanOrEqual(-0.01);
      expect(b.max[1], where).toBeLessThanOrEqual(h + SLACK);
      if (def.placement === "rug") expect(b.max[1], where).toBeLessThanOrEqual(RUG_TOP + 0.005);
      // wall pieces hang from the wall face (z = -0.5) and stay shallow
      if (def.placement === "wall") {
        expect(b.min[2], where).toBeLessThan(-0.44);
        expect(b.max[2], where).toBeLessThan(0);
      }
      // nothing floats: the lowest part touches the floor (or the wall)
      if (def.placement !== "wall") expect(b.min[1], where).toBeLessThan(0.02);
    }
  });

  it("resolves every colour slot in every palette", () => {
    for (const def of CATALOG) {
      const slots = new Set(slotsOf(def));
      if (!def.palettes) {
        expect([...slots], `${def.key} uses slots without palettes`).toEqual([]);
        continue;
      }
      expect(def.palettes.length, def.key).toBeGreaterThan(1);
      for (const palette of def.palettes) {
        expect(palette.name.length, def.key).toBeGreaterThan(0);
        for (const slot of slots) {
          const hex = palette.colors[slot];
          expect(Number.isInteger(hex) && hex! >= 0 && hex! <= 0xffffff, `${def.key}/${palette.name}/${slot}`).toBe(true);
        }
      }
      expect(variantCount(def)).toBe(def.palettes.length);
    }
  });

  it("finds pieces by Korean name or key, ignoring spaces", () => {
    expect(searchCatalog("소파").map((d) => d.key)).toContain("sofa");
    expect(searchCatalog("침 대").map((d) => d.key)).toEqual(expect.arrayContaining(["bed", "double-bed"]));
    expect(searchCatalog("lamp").map((d) => d.key)).toEqual(expect.arrayContaining(["lamp", "table-lamp", "wall-lamp", "street-lamp"]));
    expect(searchCatalog("   ")).toEqual([]);
  });

  it("lets only doors, gates and curtains open — never something you stand on or put things on", () => {
    for (const def of CATALOG.filter((d) => d.openParts)) {
      expect(["floor", "wall"], def.key).toContain(def.placement);
      expect(def.surface, def.key).toBeUndefined();
      expect(def.openParts!.length, def.key).toBeGreaterThan(0);
    }
    expect(CATALOG.filter((d) => d.openParts).map((d) => d.key)).toEqual(expect.arrayContaining(["door", "double-door", "garden-gate", "curtain"]));
  });

  it("keeps small pieces on the tallest host from swallowing more than the cell above", () => {
    // a surface piece on a host may reach into the cell above (the layout then
    // keeps blocks out of it), but never through it into the one beyond
    const tallest = Math.max(...CATALOG.map((d) => d.surface ?? 0));
    for (const def of CATALOG.filter((d) => d.placement === "surface")) {
      expect(tallest + localBounds(def).max[1], def.key).toBeLessThan(2);
    }
  });

  it("puts every seat on a floor piece, at a height the robot can sit at", () => {
    const seats = CATALOG.filter((d) => d.seat !== undefined);
    expect(seats.map((d) => d.key)).toEqual(expect.arrayContaining(["chair", "sofa", "bed", "bench"]));
    for (const def of seats) {
      expect(def.placement, def.key).toBe("floor");
      // the robot's hips are 0.42 m up: lower and its feet go through the floor
      expect(def.seat!, def.key).toBeGreaterThan(0.42);
      expect(def.seat!, def.key).toBeLessThan(def.size.h);
    }
  });

  it("throws on an unknown kind rather than drawing nothing", () => {
    expect(() => furnitureDef("throne")).toThrow();
  });
});
