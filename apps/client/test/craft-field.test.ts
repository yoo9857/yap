import { describe, expect, it } from "vitest";
import { FIELD_TOP, FieldWindow } from "../src/craft/fieldWorld.js";
import { blockByKey } from "../src/craft/blocks.js";
import { AIR } from "../src/craft/blocks.js";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe("education field", () => {
  it("preserves the previous readable save when the field exceeds its save limit", () => {
    const storage = memory(), field = new FieldWindow();
    expect(field.save(storage, {}, field.spawn)).toBe(true);
    const previous = storage.getItem("craftyap-field-save-v1");
    for (let i = 0; i < 400_001; i++) field.applyRemote(1000 + i, FIELD_TOP + 1, 1000, 19, 0);
    expect(field.save(storage, {}, field.spawn)).toBe(false);
    expect(storage.getItem("craftyap-field-save-v1")).toBe(previous);
    expect(new FieldWindow().load(storage)).not.toBeNull();
  });

  it("is flat grass everywhere, including outside the voxel window", () => {
    const field = new FieldWindow();
    const grass = blockByKey("grass")!.id;
    expect(field.world.get(80, FIELD_TOP, 80)).toBe(grass);
    expect(field.world.get(80, FIELD_TOP + 1, 80)).toBe(AIR);
    expect(field.world.get(-5000, FIELD_TOP, 9000)).toBe(grass);
    expect(field.world.get(-5000, FIELD_TOP + 1, 9000)).toBe(AIR);
  });

  it("scrolls the window and keeps edits at their absolute position", () => {
    const field = new FieldWindow();
    const gold = blockByKey("gold-block")!.id;
    field.world.set(80, FIELD_TOP + 1, 80, gold);
    expect(field.recenter({ x: 85, z: 80 })).toBeNull();

    const out = field.recenter({ x: 200, z: 80 })!;
    expect(out).toEqual({ dx: 128, dz: 0 });
    expect(field.world.get(80, FIELD_TOP + 1, 80)).toBe(AIR);

    const back = field.recenter({ x: 80 - 128, z: 80 })!;
    expect(back).toEqual({ dx: -128, dz: 0 });
    expect(field.world.get(80, FIELD_TOP + 1, 80)).toBe(gold);
  });

  it("round-trips edits, inventory and position through storage", () => {
    const storage = memory();
    const field = new FieldWindow();
    const glass = blockByKey("glass")!.id;
    field.world.set(10, FIELD_TOP + 2, 20, glass);
    field.recenter({ x: 300, z: 300 });
    field.save(storage, { glass: 5 }, { x: 81, y: 4, z: 82 });

    const restored = new FieldWindow();
    const saved = restored.load(storage)!;
    expect(saved.inventory).toEqual({ glass: 5 });
    expect(saved.player).toEqual({ x: 81, y: 4, z: 82 });
    restored.recenter({ x: 80 - 224, z: 80 - 224 });
    expect(restored.world.get(10, FIELD_TOP + 2, 20)).toBe(glass);
  });
});
