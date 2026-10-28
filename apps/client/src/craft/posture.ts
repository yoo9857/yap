import type { Body } from "./voxelBody.js";
import { canOccupy } from "./voxelBody.js";
import type { VoxelWorld } from "./voxelWorld.js";
export type Posture = "stand" | "sit" | "lie" | "crawl";
export const POSTURE_HEIGHT: Readonly<Record<Posture, number>> = { stand: 1.8, sit: 1.15, lie: .85, crawl: 1.35 };
export const POSTURE_EYE: Readonly<Record<Posture, number>> = { stand: 1.55, sit: .95, lie: .48, crawl: 1.02 };
export const CRAWL_SPEED_RATIO = 1.25 / 4.6;
/** Refuse an occupied target height, including furniture, without moving the feet. */
export function adoptPosture(world: VoxelWorld, body: Body, next: Posture): boolean {
    if (next !== "stand" && (!body.grounded || (body.wet ?? 0) >= .35))
        return false;
    const height = POSTURE_HEIGHT[next];
    if (!canOccupy(world, body, height))
        return false;
    body.h = height;
    body.vx = body.vz = 0;
    return true;
}
