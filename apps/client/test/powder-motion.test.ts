import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ExtinguisherPowder } from "../src/craft/fire/extinguisherPowder.js";

describe("extinguisher powder in world space", () => {
  it("leaves the previous plume in place through a sweep and fades it after release", () => {
    const powder = new ExtinguisherPowder();
    const from = new THREE.Vector3();
    const spray = { from, dir: new THREE.Vector3(1, 0, 0), len: 2.5 };
    try {
      for (let i = 0; i < 16; i++) powder.update(1/60, spray);
      spray.dir.set(0, 0, 1);
      for (let i = 0; i < 9; i++) powder.update(1/60, spray);
      const centres = powder.root.geometry.getAttribute("aCentre");
      const count = powder.root.geometry.instanceCount;
      expect(count).toBeGreaterThan(90);
      expect(Array.from({length: count}, (_, i) => centres.getX(i)).some(x => x > 1.5)).toBe(true);
      expect(Array.from({length: count}, (_, i) => centres.getZ(i)).some(z => z > .7)).toBe(true);
      powder.update(1/60, null);
      expect(powder.root.visible).toBe(true);
      for (let i = 0; i < 80; i++) powder.update(1/60, null);
      expect(powder.root.visible).toBe(false);
    } finally { powder.dispose(); }
  });
});
