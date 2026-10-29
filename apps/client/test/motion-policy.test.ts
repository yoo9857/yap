import { describe, it, expect } from "vitest";
import { postureTransition, type CharacterPosture } from "@robo/shared";
import { PostureMotion, RUN_GAIT, WALK_GAIT, gaitBlend, gaitCadence } from "../src/player/motionPolicy.js";
const poses: CharacterPosture[] = ["stand", "sit", "lie", "crawl"];
describe("motion timing policy", () => {
    it("provides every direct edge and completes without a standing detour", () => {
        for (const from of poses)
            for (const to of poses) {
                if (from === to)
                    continue;
                const p = new PostureMotion();
                p.reset(from);
                const edge = postureTransition(from, to)!;
                expect(edge).toBeDefined();
                expect(p.update(to, .01)?.clip).toBe(edge.clip);
                p.update(to, edge.seconds);
                expect(p.pose).toBe(to);
                expect(p.transition).toBeNull();
            }
    });
    it("mirrors time on reversal and queues a third posture until the current edge finishes", () => {
        const p = new PostureMotion();
        p.update("lie", .3);
        const forward = p.transition!.elapsed / p.transition!.seconds;
        p.update("stand", 0);
        expect(p.transition!.elapsed / p.transition!.seconds).toBeCloseTo(1 - forward);
        p.update("crawl", .01);
        expect(p.transition!.clip).toBe("StandUp");
        p.update("crawl", .5);
        expect(p.transition!.clip).toBe("CrawlEnter");
        p.update("crawl", 1);
        expect(p.pose).toBe("crawl");
        expect(p.transition).toBeNull();
    });
    it("keeps cadence continuous across the old walk/run boundary and matches stance travel", () => {
        for (const speed of [1, 1.8, 2.39, 2.4, 2.41, 3, 4.6]) {
            const b = gaitBlend(speed), travel = (.42 / .64) * (1 - b) + (.50 / .42) * b;
            expect(gaitCadence(speed) * travel).toBeCloseTo(speed, 8);
        }
        expect(gaitBlend(WALK_GAIT)).toBe(0);
        expect(gaitBlend(2.2)).toBe(0);
        expect(gaitBlend(RUN_GAIT)).toBe(1);
        expect(gaitBlend(4.6)).toBe(1);
    });
});
