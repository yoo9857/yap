import type { Vec3 } from "../math/index.js";

export type PlatformKind = "solid" | "moving" | "crumbling";
export type SolidRole = "ground" | "normal" | "checkpoint" | "winner";
export type MoveAxis = "x" | "z";

/** Lava brick sitting on a platform edge; absolute box, touch = death. */
export interface HazardDef {
  center: Vec3;
  size: Vec3;
}

interface PlatformBase {
  id: number;
  kind: PlatformKind;
  /** Static center; for moving platforms this is the oscillation base. */
  center: Vec3;
  /** Full extents [width x, thickness y, depth z]. */
  size: Vec3;
  /** Index into BRICK_COLORS; special roles override client-side. */
  colorIndex: number;
}

export interface SolidPlatformDef extends PlatformBase {
  kind: "solid";
  role: SolidRole;
  hazard?: HazardDef;
}

export interface MovingPlatformDef extends PlatformBase {
  kind: "moving";
  axis: MoveAxis;
  amplitude: number;
  omega: number;
  phase: number;
}

export interface CrumblingPlatformDef extends PlatformBase {
  kind: "crumbling";
}

export type PlatformDef = SolidPlatformDef | MovingPlatformDef | CrumblingPlatformDef;

export interface CheckpointDef {
  index: number;
  /** Sensor pad center (sits on the checkpoint platform top). */
  center: Vec3;
  radius: number;
}

export interface GoalDef {
  center: Vec3;
  radius: number;
}

export interface LevelDef {
  seed: number;
  platforms: PlatformDef[];
  checkpoints: CheckpointDef[];
  goal: GoalDef;
  /** Feet position on the baseplate where players spawn. */
  spawn: Vec3;
  /** Height of the winner pad top — HUD progress denominator. */
  summitHeight: number;
  /** checkpoints + summit */
  totalStages: number;
  /** Physical lower bound on a legit finish — server-side validation. */
  minFinishSeconds: number;
}
