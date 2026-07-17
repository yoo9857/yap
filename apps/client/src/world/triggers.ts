import {
  CAPSULE_RADIUS,
  KILL_PLANE_Y,
  vec3DistXZ,
  type LevelDef,
  type Vec3,
} from "@robo/shared";

export type TriggerHit =
  | { kind: "death"; cause: "kill-plane" | "hazard" }
  | { kind: "checkpoint"; index: number }
  | { kind: "goal" }
  /** Standing on the goal pad without all checkpoints — server would reject
   *  the finish, so the client never celebrates it either. */
  | { kind: "goal-blocked" };

/**
 * Analytic trigger volumes — checked in plain code against the player's feet
 * position each tick instead of relying on physics sensor events. Pure and
 * trivially testable; the exact same rules run in server validation.
 */
export class TriggerField {
  private readonly hazards: { center: Vec3; halfX: number; halfY: number; halfZ: number }[] = [];

  constructor(private readonly level: LevelDef) {
    for (const p of level.platforms) {
      if (p.kind === "solid" && p.hazard) {
        this.hazards.push({
          center: p.hazard.center,
          halfX: p.hazard.size[0] / 2 + CAPSULE_RADIUS,
          halfY: p.hazard.size[1] / 2,
          halfZ: p.hazard.size[2] / 2 + CAPSULE_RADIUS,
        });
      }
    }
  }

  /**
   * `feet` is the character's feet position; `reachedCheckpoint` is the
   * highest checkpoint already activated (-1 = none).
   */
  check(feet: Vec3, reachedCheckpoint: number): TriggerHit | null {
    if (feet[1] < KILL_PLANE_Y) return { kind: "death", cause: "kill-plane" };

    const bodyCenterY = feet[1] + 0.9; // roughly capsule center
    for (const h of this.hazards) {
      if (
        Math.abs(feet[0] - h.center[0]) < h.halfX &&
        Math.abs(feet[2] - h.center[2]) < h.halfZ &&
        bodyCenterY > h.center[1] - h.halfY - 0.9 &&
        feet[1] < h.center[1] + h.halfY
      ) {
        return { kind: "death", cause: "hazard" };
      }
    }

    const next = this.level.checkpoints[reachedCheckpoint + 1];
    if (
      next &&
      vec3DistXZ(feet, next.center) < next.radius &&
      Math.abs(feet[1] - next.center[1]) < 1.2
    ) {
      return { kind: "checkpoint", index: next.index };
    }

    const goal = this.level.goal;
    if (vec3DistXZ(feet, goal.center) < goal.radius && Math.abs(feet[1] - goal.center[1]) < 1.2) {
      return reachedCheckpoint === this.level.checkpoints.length - 1
        ? { kind: "goal" }
        : { kind: "goal-blocked" };
    }

    return null;
  }

  /** Feet respawn position for the given checkpoint (-1 = level spawn). */
  respawnPoint(reachedCheckpoint: number): Vec3 {
    const cp = this.level.checkpoints[reachedCheckpoint];
    if (!cp) return [...this.level.spawn];
    return [cp.center[0], cp.center[1] + 0.1, cp.center[2]];
  }
}
