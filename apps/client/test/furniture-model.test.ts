import { describe, expect, it } from "vitest";
import { CATALOG, furnitureDef, variantCount } from "../src/craft/furniture/catalog/index.js";
import { buildFurnitureShape, paintFurniture } from "../src/craft/furniture/model.js";

/**
 * Furniture geometry is drawn three times a frame for every look in use, so
 * its size is a frame-rate budget, and colour variants must reuse the shape
 * instead of copying it.
 */
describe("furniture geometry", () => {
  it("every piece is indexed and within the vertex budget", () => {
    let total = 0;
    for (const def of CATALOG) {
      const { geometry } = buildFurnitureShape(def);
      expect(geometry.index, def.key).not.toBeNull();
      const vertices = geometry.attributes.position!.count;
      // un-indexed 4-segment boxes once made a bookshelf ~175k vertices
      expect(vertices, def.key).toBeLessThan(8000);
      total += vertices;
    }
    expect(total).toBeLessThan(150_000);
  });

  it("colour variants share the shape's buffers and only own their colours", () => {
    const def = furnitureDef("sofa");
    expect(variantCount(def)).toBeGreaterThan(1);
    const shape = buildFurnitureShape(def);
    const a = paintFurniture(def, 0, false, shape);
    const b = paintFurniture(def, 1, false, shape);
    for (const name of ["position", "normal", "uv"]) {
      expect(a.getAttribute(name)).toBe(shape.geometry.getAttribute(name));
      expect(b.getAttribute(name)).toBe(shape.geometry.getAttribute(name));
    }
    expect(a.index).toBe(shape.geometry.index);
    expect(a.getAttribute("color")).not.toBe(b.getAttribute("color"));
    expect(Array.from(a.getAttribute("color").array)).not.toEqual(Array.from(b.getAttribute("color").array));
    expect(a.getAttribute("color").count).toBe(shape.geometry.attributes.position!.count);
  });

  it("open doors get their own shape", () => {
    const def = furnitureDef("door");
    const closed = buildFurnitureShape(def, false);
    const open = buildFurnitureShape(def, true);
    expect(open.geometry.attributes.position!.array).not.toEqual(closed.geometry.attributes.position!.array);
    expect(paintFurniture(def, 0, true, open).getAttribute("color").count).toBe(open.geometry.attributes.position!.count);
  });
});
