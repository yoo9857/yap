import { describe, it, expect } from "vitest";
import { CUBE, KIT_CUBE, ROUND, MAX_BLOCK_SHAPE, kitSlopeShape, cornerShape, isBlockShape, shapeIntersectsBox, raycastBlockShape, rotateShapeVector, toShapeLocal } from "../src/blockShapes.js";
import { decodeClassClient } from "../src/protocol/classroom.js";
describe("construction shape contract", () => {
    it("keeps old codes stable and carries every new orientation over the classroom wire", () => {
        expect([CUBE, ROUND, KIT_CUBE]).toEqual([0, 1, 18]);
        for (const factory of [kitSlopeShape, cornerShape])
            for (let yaw = 0; yaw < 4; yaw++)
                for (let tilt = 0; tilt < 4; tilt++) {
                    const shape = factory(yaw, tilt);
                    expect(isBlockShape(shape)).toBe(true);
                    expect(decodeClassClient(JSON.stringify({ t: "k-edit", edits: [[2, 4, 3, 3, shape]] }))).not.toBeNull();
                    const p: [
                        number,
                        number,
                        number
                    ] = [.21, .43, .76], rot = rotateShapeVector(p, shape);
                    expect(rotateShapeVector(rot, shape, true)).toEqual(p);
                }
        expect(decodeClassClient(JSON.stringify({ t: "k-edit", edits: [[2, 4, 3, 3, MAX_BLOCK_SHAPE + 1]] }))).toBeNull();
    });
    it("uses the sloped surface and leaves the empty half selectable-through", () => {
        const hit = raycastBlockShape(kitSlopeShape(0, 0), [.5, 2, .25], [0, -1, 0], 4)!;
        expect(hit.distance).toBeCloseTo(1.25);
        expect(hit.normal[1]).toBeGreaterThan(.7);
        expect(shapeIntersectsBox(kitSlopeShape(0, 0), { min: [.1, .8, .8], max: [.2, .9, .9] })).toBe(false);
        expect(shapeIntersectsBox(cornerShape(0, 0), { min: [.8, .4, .1], max: [.9, .5, .2] })).toBe(false);
        expect(shapeIntersectsBox(cornerShape(0, 0), { min: [.1, .5, .1], max: [.2, .6, .2] })).toBe(true);
    });
    it("rotates collisions and aiming exactly like the displayed cell", () => {
        for (const factory of [kitSlopeShape, cornerShape])
            for (let yaw = 0; yaw < 4; yaw++)
                for (let tilt = 0; tilt < 4; tilt++) {
                    const shape = factory(yaw, tilt);
                    const p: [
                        number,
                        number,
                        number
                    ] = [.3, .5, .7];
                    const local = toShapeLocal(p, shape);
                    const localShape = factory(0, 0);
                    const half = .02;
                    expect(shapeIntersectsBox(shape, { min: [p[0] - half, p[1] - half, p[2] - half], max: [p[0] + half, p[1] + half, p[2] + half] })).toBe(shapeIntersectsBox(localShape, { min: [local[0] - half, local[1] - half, local[2] - half], max: [local[0] + half, local[1] + half, local[2] + half] }));
                }
    });
});
