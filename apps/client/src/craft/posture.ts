import type { CharacterPosture } from "@robo/shared";
import { postureTransition } from "@robo/shared";
import type { Body } from "./voxelBody.js";
import { canOccupy, MOVE_SPEED, RUN_SPEED, WALK_SPEED } from "./voxelBody.js";
import type { VoxelWorld } from "./voxelWorld.js";
export type Posture = CharacterPosture;
export const POSTURE_HEIGHT: Readonly<Record<Posture, number>> = { stand: 1.8, sit: 1.30, lie: .85, crawl: 1.35 };
export const POSTURE_EYE: Readonly<Record<Posture, number>> = { stand: 1.55, sit: .95, lie: .48, crawl: 1.02 };
export const CRAWL_SPEED_RATIO = 1.25 / MOVE_SPEED;

/** Wish scale for stepBody. Swimming stays on MOVE_SPEED; crawl never sprints. */
export function moveScale(posture: Posture, sprint: boolean, swimming = false): number {
    if (swimming) return 1;
    if (posture === "crawl") return CRAWL_SPEED_RATIO;
    return (sprint && posture === "stand" ? RUN_SPEED : WALK_SPEED) / MOVE_SPEED;
}
/** Check the swept posture envelope as well as its destination. */
export function adoptPosture(world: VoxelWorld, body: Body, next: Posture, from: Posture = "stand"): boolean {
    if (next !== "stand" && (!body.grounded || (body.wet ?? 0) >= .35))
        return false;
    const height = POSTURE_HEIGHT[next], clearance = Math.max(height, postureTransition(from, next)?.clearance ?? height);
    if (!canOccupy(world, body, clearance))
        return false;
    body.h = height;
    body.vx = body.vz = 0;
    return true;
}
