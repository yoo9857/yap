import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as rapier from "@dimforge/rapier3d-compat";
import { PlazaPhysics, type PlazaCollision } from "../src/plaza/plazaPhysics.js";
let world: PlazaPhysics;
beforeAll(async () => {
  await rapier.init();
  const data = JSON.parse(readFileSync(new URL("../public/world/main-plaza/collision.json", import.meta.url), "utf8")) as PlazaCollision;
  world = new PlazaPhysics(rapier, data);
}, 30000);
afterAll(() => world?.dispose());
describe("plaza movement against the exported metre-scale model", () => {
  it("stands on the actual village paving and walks in a clear approach", () => {
    world.teleport([0, 2, 10]);
    for (let i = 0; i < 180; i++) world.step(0, 0, false);
    expect(world.grounded).toBe(true); expect(world.feet.y).toBeGreaterThan(.08); expect(world.feet.y).toBeLessThan(.25);
    const z = world.feet.z;
    for (let i = 0; i < 60; i++) world.step(0, -5, false);
    expect(world.feet.z).toBeLessThan(z - 3);
  });
  it("climbs the 16 cm castle approach steps without a jump", () => {
    world.teleport([0, .16, -88]);
    for (let i = 0; i < 520; i++) world.step(0, -4, false);
    expect(world.feet.z).toBeLessThan(-115); expect(world.feet.y).toBeGreaterThan(6.2); expect(world.feet.y).toBeLessThan(6.7);
  });
});
