import { describe, expect, it } from "vitest";
import { preset, type Blueprint } from "../src/craft/machines/blueprint.js";
import { customizationScope } from "../src/craft/machines/editScope.js";
import { partInspectorMarkup } from "../src/craft/machines/workshopUi.js";

describe("customization scope", () => {
  it("identifies the exact mirrored pair and describes both block numbers", () => {
    const blueprint = preset("rover");
    const wheel = blueprint.parts.findIndex(part => part.kind === "wheel");
    const scope = customizationScope(blueprint, wheel, true);
    expect(scope.mode).toBe("paired");
    expect(scope.indices).toHaveLength(2);
    const [left, right] = scope.indices.map(index => blueprint.parts[index]!);
    expect(left!.cell[0]).toBe(-right!.cell[0]);
    expect(left!.cell.slice(1)).toEqual(right!.cell.slice(1));
    const html = partInspectorMarkup(blueprint, wheel, true, false, true);
    expect(html).toContain('data-scope="paired"');
    expect(html).toContain(`#${scope.indices.map(index => index + 1).join(" + #")}`);
  });

  it("does not promise a second change for a centre block or individual editing", () => {
    const blueprint = preset("rover");
    const centre = blueprint.parts.findIndex(part => part.cell[0] === 0);
    expect(customizationScope(blueprint, centre, true)).toEqual({ mode: "center", indices: [centre] });
    expect(partInspectorMarkup(blueprint, centre, true, false, true)).toContain("중앙 블록 1개");
    const wheel = blueprint.parts.findIndex(part => part.kind === "wheel");
    expect(customizationScope(blueprint, wheel, false)).toEqual({ mode: "single", indices: [wheel] });
  });

  it("explains a missing or differently shaped counterpart without modifying the design", () => {
    const blueprint: Blueprint = { version: 1, name: "asymmetric", parts: [
      {kind:"wheel",cell:[-1,0,0],direction:0},
      {kind:"frame",cell:[1,0,0],direction:0},
    ] };
    const before = structuredClone(blueprint);
    expect(customizationScope(blueprint, 0, true)).toEqual({ mode: "missing", indices: [0] });
    expect(partInspectorMarkup(blueprint, 0, true, false, true)).toContain("반대쪽에 같은 블록이 없어");
    expect(blueprint).toEqual(before);
    expect(customizationScope(blueprint, -1, true).indices).toEqual([]);
  });
});
