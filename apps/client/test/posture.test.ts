import { describe, expect, it } from "vitest";
import { VoxelWorld } from "../src/craft/voxelWorld.js";
import { adoptPosture, CRAWL_SPEED_RATIO, POSTURE_HEIGHT, moveScale } from "../src/craft/posture.js";
import { MOVE_SPEED, RUN_SPEED, WALK_SPEED, stepBody, type Body } from "../src/craft/voxelBody.js";
import { RUN_GAIT, WALK_GAIT } from "../src/player/motionPolicy.js";
const body = (): Body => ({ x: 8.5, y: 1.5, z: 8.5, vx: 0, vy: 0, vz: 0, grounded: true });
describe("posture collision and locomotion", () => {
    it("keeps feet fixed and refuses to stand into blocks or furniture", () => {
        const world = new VoxelWorld(), b = body();
        expect(adoptPosture(world, b, "crawl")).toBe(true);
        expect(b.h).toBe(POSTURE_HEIGHT.crawl);
        world.set(8, 3, 8, 1);
        expect(adoptPosture(world, b, "stand")).toBe(false);
        expect([b.x, b.y, b.z]).toEqual([8.5, 1.5, 8.5]);
        expect(b.h).toBe(POSTURE_HEIGHT.crawl);
        world.set(8, 3, 8, 0);
        world.propSolid = (x, y, z) => x === 8 && y === 3 && z === 8;
        expect(adoptPosture(world, b, "stand")).toBe(false);
        world.propSolid = null;
        expect(adoptPosture(world, b, "stand")).toBe(true);
    });
    it("refuses low poses in the air or underwater", () => {
        const world = new VoxelWorld(), b = body();
        b.grounded = false;
        expect(adoptPosture(world, b, "crawl")).toBe(false);
        b.grounded = true;
        b.wet = .7;
        expect(adoptPosture(world, b, "lie")).toBe(false);
    });
    it("uses a deliberate 1.25 m/s crawl rather than normal running speed", () => {
        const world = new VoxelWorld(), b = body();
        adoptPosture(world, b, "crawl");
        stepBody(world, b, 1 / 60, CRAWL_SPEED_RATIO, 0, false);
        expect(b.vx).toBeCloseTo(1.25);
    });
    it("walks unless Shift is held, and keeps crawl and swimming off that split", () => {
        expect(moveScale("stand", false) * MOVE_SPEED).toBeCloseTo(WALK_SPEED);
        expect(moveScale("stand", true) * MOVE_SPEED).toBeCloseTo(RUN_SPEED);
        expect(moveScale("crawl", true)).toBe(CRAWL_SPEED_RATIO);
        expect(moveScale("stand", true, true)).toBe(1);
        expect(WALK_SPEED).toBeLessThanOrEqual(WALK_GAIT);
        expect(RUN_SPEED).toBeGreaterThanOrEqual(RUN_GAIT);
    });
});

it("rejects a low-to-low transition whose intermediate body needs more clearance",()=>{
  const world=new VoxelWorld(),b=body();b.y=1.6;b.h=POSTURE_HEIGHT.crawl;
  world.set(8,3,8,1);
  expect(adoptPosture(world,b,"lie","crawl")).toBe(false);
  expect(b.h).toBe(POSTURE_HEIGHT.crawl);
  world.set(8,3,8,0);expect(adoptPosture(world,b,"lie","crawl")).toBe(true);
});
