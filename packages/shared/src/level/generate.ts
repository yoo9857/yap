import {
  BRICK_COLORS,
  LEVEL_SECTIONS,
  MOVE_SPEED,
  PLATFORM_DEPTH,
  PLATFORM_THICKNESS,
} from "../constants.js";
import { clamp, vec3DistXZ, type Vec3 } from "../math/index.js";
import { createRng } from "./rng.js";
import type {
  CheckpointDef,
  LevelDef,
  MoveAxis,
  PlatformDef,
  PlatformKind,
  SolidPlatformDef,
} from "./types.js";

/**
 * Deterministic tower generation — a faithful 3D port of the prototype's
 * buildLevel() at SCALE = 40 px/m, extended with a bounded z-axis wander.
 * Pure function of the seed: client and server produce identical output.
 *
 * Coordinate mapping from the prototype:
 *   x_m = x_px / 40 - 12   (world column x,z ∈ [-12, 12])
 *   height_m = (40 - y_px) / 40   (baseplate top = 0, platform y = its TOP)
 */
export function generateLevel(seed: number): LevelDef {
  const rng = createRng(seed);
  const R = (a: number, b: number) => rng.range(a, b);

  const platforms: PlatformDef[] = [];
  const checkpoints: CheckpointDef[] = [];
  let nextId = 0;

  // green baseplate (prototype: w = WORLD_W + 200 → 29 m), top at height 0
  platforms.push({
    id: nextId++,
    kind: "solid",
    role: "ground",
    center: [0, -0.5, 0],
    size: [29, 1, 29],
    colorIndex: 0,
  });

  let posX = 0;
  let posZ = 0;
  let height = 0; // current platform TOP height
  let brickIdx = 0;
  let prevCenter: Vec3 = [0, 0, 0];

  /** Bounded planar step: prototype x-walk + z wander that never pushes the
   *  total displacement beyond the jumpable envelope (dMax). */
  const step = (dy: number, dMax: number, dMin: number, bound: number) => {
    const dirX = posX < -7.5 ? 1 : posX > 7.5 ? -1 : rng.chance(0.5) ? -1 : 1;
    const oldX = posX;
    posX = clamp(posX + dirX * R(dMin, dMax), -bound, bound);
    const usedX = Math.abs(posX - oldX);
    const zBudget = Math.sqrt(Math.max(0, dMax * dMax - usedX * usedX));
    const dirZ = posZ < -7.5 ? 1 : posZ > 7.5 ? -1 : rng.chance(0.5) ? -1 : 1;
    posZ = clamp(posZ + dirZ * R(0, Math.min(1.5, zBudget)), -bound, bound);
    height += dy;
  };

  for (const sec of LEVEL_SECTIONS) {
    for (let i = 0; i < sec.count; i++) {
      const dy = R(1.95, 2.55);
      // prototype: dxMax = max(120, 245 - dy_px) → meters
      const dMax = Math.max(3.0, 6.125 - dy);
      step(dy, dMax, 2.75, 9.25);

      const kind: PlatformKind = rng.pick(sec.types);
      const colorIndex = ((brickIdx / 3) | 0) % BRICK_COLORS.length;
      brickIdx++;
      const centerY = height - PLATFORM_THICKNESS / 2;

      if (kind === "moving") {
        const width = R(2.375, 3.0);
        // If the gap from the previous platform is long, oscillate along the
        // dominant gap axis so the swing periodically closes the distance
        // (guarantees a reachable moment, like the prototype's x-only swings).
        const gapX = Math.abs(posX - prevCenter[0]);
        const gapZ = Math.abs(posZ - prevCenter[2]);
        let axis: MoveAxis;
        if (Math.hypot(gapX, gapZ) > 3.0) {
          axis = gapX >= gapZ ? "x" : "z";
        } else {
          axis = rng.chance(0.5) ? "x" : "z";
        }
        platforms.push({
          id: nextId++,
          kind,
          center: [posX, centerY, posZ],
          size: [width, PLATFORM_THICKNESS, PLATFORM_DEPTH],
          colorIndex,
          axis,
          amplitude: R(1.5, 2.625),
          omega: R(1.1, 1.8),
          phase: rng.next() * Math.PI * 2,
        });
      } else if (kind === "crumbling") {
        platforms.push({
          id: nextId++,
          kind,
          center: [posX, centerY, posZ],
          size: [R(2.375, 3.125), PLATFORM_THICKNESS, PLATFORM_DEPTH],
          colorIndex,
        });
      } else {
        const width = R(2.625, 3.75);
        const p: SolidPlatformDef = {
          id: nextId++,
          kind: "solid",
          role: "normal",
          center: [posX, centerY, posZ],
          size: [width, PLATFORM_THICKNESS, PLATFORM_DEPTH],
          colorIndex,
        };
        // lava brick on one edge of wide solids (prototype: 32×26 px)
        if (width >= 3.125 && rng.chance(sec.hazard)) {
          const side = rng.chance(0.5) ? -1 : 1;
          p.hazard = {
            center: [posX + side * (width / 2 - 0.4), height + 0.325, posZ],
            size: [0.8, 0.65, 0.8],
          };
        }
        platforms.push(p);
      }
      prevCenter = [posX, height, posZ];
    }

    // checkpoint pad between sections (prototype: y -= R(85,95), w = 190 px)
    step(R(2.125, 2.375), 4.2, 2.5, 8);
    const cpIndex = checkpoints.length;
    platforms.push({
      id: nextId++,
      kind: "solid",
      role: "checkpoint",
      center: [posX, height - PLATFORM_THICKNESS / 2, posZ],
      size: [4.75, PLATFORM_THICKNESS, 4.75],
      colorIndex: 0,
    });
    checkpoints.push({ index: cpIndex, center: [posX, height, posZ], radius: 1.5 });
    prevCenter = [posX, height, posZ];
  }

  // summit: last "checkpoint" becomes the golden winner pad (prototype: w = 240 px)
  const summitCp = checkpoints.pop();
  const summitPlatform = platforms[platforms.length - 1];
  if (!summitCp || !summitPlatform || summitPlatform.kind !== "solid") {
    throw new Error("level generation invariant broken: missing summit");
  }
  summitPlatform.role = "winner";
  summitPlatform.size = [6, PLATFORM_THICKNESS, 6];
  const goal = { center: summitCp.center, radius: 1.8 };

  // physical lower bound on finish time: planar path at full speed, or the
  // minimum air time of every required jump — whichever dominates, with slack
  let planar = 0;
  for (let i = 1; i < platforms.length; i++) {
    planar += vec3DistXZ(platforms[i - 1]!.center, platforms[i]!.center);
  }
  const jumpTime = (platforms.length - 1) * 0.45;
  const minFinishSeconds = Math.max(planar / MOVE_SPEED, jumpTime) * 0.8;

  return {
    seed,
    platforms,
    checkpoints,
    goal,
    spawn: [0, 0, 0],
    summitHeight: summitCp.center[1],
    totalStages: checkpoints.length + 1,
    minFinishSeconds,
  };
}
