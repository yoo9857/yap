import {
  BRICK_COLORS,
  LEVEL_SECTIONS,
  MOVE_SPEED,
  PLATFORM_DEPTH,
  PLATFORM_THICKNESS,
} from "../constants.js";
import { clamp, type Vec3 } from "../math/index.js";
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
 * Deterministic multi-route tower generation. Pure function of the seed:
 * client and server produce identical output.
 *
 * Shape: the tower is a stack of SECTIONS separated by shared checkpoint pads
 * (the single sequential spine the server anti-cheat validates). Inside each
 * section 3–4 parallel LANES fan out from the pad below and re-converge on the
 * pad above — so the climber picks a route, and every route is independently
 * reachable. Lanes share one vertical schedule (so the pad above is an equal
 * hop from every lane top) and each carries its own colour + character
 * (calm-solid / moving / crumbling), which is what makes the routes read as
 * genuinely different ways up.
 *
 * Reachability is guaranteed by construction: consecutive platforms in a lane
 * are one shared `dy` apart and their planar step is capped to the jump
 * envelope `dMax`; lane ends taper back toward the pad so the pad is always
 * within a hop of every lane.
 *
 * World column x,z ∈ [-12, 12]; platform y is its TOP height (baseplate = 0).
 */

// Wider play column (the tower now sprawls to fit more routes side by side). The
// server anti-cheat allows |x|,|z| up to 18, so lanes at ±14 keep ample slack.
const LANE_BOUND = 14.0;
/** Home targets are pre-clamped to this tighter box so the forced min-step is
 *  computed against an in-bounds goal — otherwise the LANE_BOUND wall could
 *  shorten a step below MIN_STEP and strand a platform overhead its parent. */
const HOME_BOUND = 12.5;
const PAD_BOUND = 5; // pads sit near the middle so radial lanes have room to sprawl
/** Minimum planar hop between consecutive lane platforms — below this a platform
 *  sits (nearly) directly above its parent and the climb is physically blocked. */
const MIN_STEP = 2.85;
/** Where lanes aim their final approach relative to the shared pad — a clean,
 *  reachable hop out on the lane's own bearing. */
const PAD_APPROACH = 3.6;
/** How far the pad is lifted (toward centre) from lane 0's top: a guaranteed
 *  jumpable hop, so that lane always tops out and the checkpoint is reachable. */
const PAD_LIFT = 3.2;

/** Planar jump envelope for a given rise — the prototype's dxMax curve. */
function jumpReach(dy: number): number {
  return Math.max(3.0, 6.125 - dy);
}

export function generateLevel(seed: number): LevelDef {
  const rng = createRng(seed);
  const R = (a: number, b: number) => rng.range(a, b);

  const platforms: PlatformDef[] = [];
  const checkpoints: CheckpointDef[] = [];
  let nextId = 0;

  // green baseplate, top at height 0
  platforms.push({
    id: nextId++,
    kind: "solid",
    role: "ground",
    center: [0, -0.5, 0],
    size: [29, 1, 29],
    colorIndex: 0,
  });

  let laneColor = 0; // walks BRICK_COLORS so adjacent lanes never share a hue
  let base: Vec3 = [0, 0, 0]; // section start pad centre (x, TOP height, z)
  let goalCenter: Vec3 = [0, 0, 0];

  // fastest-route accounting for the min-finish-time lower bound
  let fastestPlanar = 0;
  let totalHops = 0;

  const numSections = LEVEL_SECTIONS.length;

  LEVEL_SECTIONS.forEach((sec, sIdx) => {
    // more routes now, trending up as the tower climbs: 4 low → up to 6 high
    const routeCount = 4 + (sIdx >= 1 && rng.chance(0.5) ? 1 : 0) + (sIdx >= 3 && rng.chance(0.5) ? 1 : 0);
    const count = sec.count;
    const isSummit = sIdx === numSections - 1;

    // One vertical schedule shared by every lane → the pad above is an equal hop
    // from all lane tops. Every rung is ≥ 2.45 m apart: since ALL platforms live
    // on this shared ladder, the smallest vertical gap between any two is ≥ 2.45,
    // so the clearance under the next platform (gap − thickness ≈ 1.9 m) always
    // exceeds the 1.8 m character — the head can never catch on an overhang (the
    // reported bug), no matter how the routes overlap horizontally.
    const dys: number[] = [];
    for (let i = 0; i < count; i++) dys.push(R(2.45, 2.65));
    const heights: number[] = [];
    let h = base[1];
    for (let i = 0; i < count; i++) {
      h += dys[i]!;
      heights.push(h);
    }
    const padDy = R(2.45, 2.6);
    const padHeight = heights[count - 1]! + padDy;

    // Lanes fan out RADIALLY around the section's spine, each on its own compass
    // bearing — this uses the square play column far better than a single lateral
    // line. Bearings are evenly spaced but jittered, and each lane wanders its own
    // radius/tangent as it climbs, so no two towers look alike and the routes
    // sprawl instead of forming a tidy fan. The shared pad is placed a clean hop
    // from LANE 0's actual top (see below) — that lane always tops out, so the
    // checkpoint is guaranteed reachable no matter how the others wandered.
    const sectionAngle = rng.next() * Math.PI * 2;
    const laneKinds = laneArchetypes(sec.types, routeCount);

    // Build one lane toward (targetX,targetZ), returning its top. All the
    // per-step wander + forced-min-step live here.
    const buildLane = (k: number, targetX: number, targetZ: number): { tx: number; tz: number; planar: number } => {
      const bearing = sectionAngle + (k * Math.PI * 2) / routeCount + R(-0.22, 0.22);
      const ox = Math.cos(bearing);
      const oz = Math.sin(bearing);
      const zx = -oz; // tangential axis (perpendicular to the lane's bearing)
      const zz = ox;
      const laneSpread = R(5.0, 7.5); // this lane's own reach from the spine (wider column)
      const laneCol = laneColor++ % BRICK_COLORS.length;
      const pref = laneKinds[k]!;
      let wanderRad = 0;
      let wanderTan = R(-1.2, 1.2);
      let prevX = base[0];
      let prevZ = base[2];
      let prevY = base[1];
      let lanePlanar = 0;

      for (let i = 0; i < count; i++) {
        const t = (i + 1) / count;
        const env = 0.5 + 0.5 * Math.sin(Math.PI * t);
        wanderRad = clamp(wanderRad + R(-1.0, 1.0), -1.6, 2.0);
        const zig = i % 2 === 0 ? 0.7 : -0.7;
        wanderTan = clamp(wanderTan + R(-0.9, 0.9) + zig, -1.9, 1.9);
        // env-taper the whole offset: lanes bulge out through the middle but
        // re-gather toward the spine at both ends
        const off = (laneSpread + wanderRad) * env;
        let hx = base[0] + (targetX - base[0]) * t + ox * off + zx * wanderTan * env;
        let hz = base[2] + (targetZ - base[2]) * t + oz * off + zz * wanderTan * env;
        // over the last stretch, blend toward an approach spot a hop out from the
        // target on the lane's bearing, so the lane re-gathers from its wander
        const wTop = clamp((t - 0.6) / 0.4, 0, 1);
        hx += (targetX + ox * PAD_APPROACH - hx) * wTop;
        hz += (targetZ + oz * PAD_APPROACH - hz) * wTop;
        hx = clamp(hx, -HOME_BOUND, HOME_BOUND);
        hz = clamp(hz, -HOME_BOUND, HOME_BOUND);

        const y = heights[i]!;
        // step from the ACTUAL previous platform, FORCED into the jump window: a
        // hard MINIMUM so nothing lands stacked directly overhead (blocks the
        // climb — the reported bug), and a max so the next hop is reachable
        const sx = hx - prevX;
        const sz = hz - prevZ;
        const len = Math.hypot(sx, sz) || 1;
        const step = Math.max(MIN_STEP, Math.min(jumpReach(y - prevY) * 0.9, len));
        let px = prevX + (sx / len) * step;
        let pz = prevZ + (sz / len) * step;
        // if the honest step would leave the column, take the SAME-length step
        // toward the centre instead (prev is always well inside) — a wall-clamped
        // step could shorten below MIN_STEP and strand a platform overhead
        if (Math.abs(px) > LANE_BOUND || Math.abs(pz) > LANE_BOUND) {
          const cl = Math.hypot(prevX, prevZ) || 1;
          px = prevX - (prevX / cl) * step;
          pz = prevZ - (prevZ / cl) * step;
        }
        const centerY = y - PLATFORM_THICKNESS / 2;
        const kind = pickKind(pref, sec.types, rng);
        platforms.push(buildBrick(nextId++, kind, [px, centerY, pz], y, sec.hazard, laneCol, R, rng));
        lanePlanar += Math.hypot(px - prevX, pz - prevZ);
        prevX = px;
        prevZ = pz;
        prevY = y;
      }
      return { tx: prevX, tz: prevZ, planar: lanePlanar };
    };

    // Build lane 0 toward a rough wander target, then pin the real pad a clean
    // hop from its top (pulled toward centre so pads stay reasonably central).
    const rough = nextPad(base, R, rng);
    const lane0 = buildLane(0, rough[0], rough[1]);
    const cl0 = Math.hypot(lane0.tx, lane0.tz) || 1;
    const pad: [number, number] = [
      clamp(lane0.tx - (lane0.tx / cl0) * PAD_LIFT, -PAD_BOUND - 1, PAD_BOUND + 1),
      clamp(lane0.tz - (lane0.tz / cl0) * PAD_LIFT, -PAD_BOUND - 1, PAD_BOUND + 1),
    ];
    let sectionShortest = lane0.planar + Math.hypot(pad[0] - lane0.tx, pad[1] - lane0.tz);
    for (let k = 1; k < routeCount; k++) {
      const ln = buildLane(k, pad[0], pad[1]);
      sectionShortest = Math.min(sectionShortest, ln.planar + Math.hypot(pad[0] - ln.tx, pad[1] - ln.tz));
    }
    fastestPlanar += sectionShortest;

    // shared checkpoint / winner pad above every lane
    const padCenterY = padHeight - PLATFORM_THICKNESS / 2;
    platforms.push({
      id: nextId++,
      kind: "solid",
      role: isSummit ? "winner" : "checkpoint",
      center: [pad[0], padCenterY, pad[1]],
      size: isSummit ? [6, PLATFORM_THICKNESS, 6] : [4.75, PLATFORM_THICKNESS, 4.75],
      colorIndex: 0,
    });
    const padTop: Vec3 = [pad[0], padHeight, pad[1]];
    if (isSummit) {
      goalCenter = padTop;
    } else {
      checkpoints.push({ index: checkpoints.length, center: padTop, radius: 1.5 });
    }

    totalHops += count + 1; // count lane hops + the hop onto the pad
    base = padTop;
  });

  // fastest route (sum of each section's shortest lane) → min-finish bound
  const jumpTime = totalHops * 0.45;
  const minFinishSeconds = Math.max(fastestPlanar / MOVE_SPEED, jumpTime) * 0.8;

  return {
    seed,
    platforms,
    checkpoints,
    goal: { center: goalCenter, radius: 1.8 },
    spawn: [0, 0, 0],
    summitHeight: goalCenter[1],
    totalStages: checkpoints.length + 1,
    minFinishSeconds,
  };
}

/** Bounded planar wander for the next pad, kept near the column centre. */
function nextPad(base: Vec3, R: (a: number, b: number) => number, rng: ReturnType<typeof createRng>): [number, number] {
  const bx = base[0];
  const bz = base[2];
  const dirX = bx < -4 ? 1 : bx > 4 ? -1 : rng.chance(0.5) ? -1 : 1;
  const dirZ = bz < -4 ? 1 : bz > 4 ? -1 : rng.chance(0.5) ? -1 : 1;
  const nx = clamp(bx + dirX * R(2.0, 4.5), -PAD_BOUND, PAD_BOUND);
  const nz = clamp(bz + dirZ * R(1.5, 4.0), -PAD_BOUND, PAD_BOUND);
  return [nx, nz];
}

/** Give each lane a preferred platform kind drawn from the section's palette. */
function laneArchetypes(types: readonly PlatformKind[], count: number): PlatformKind[] {
  const out: PlatformKind[] = [];
  for (let k = 0; k < count; k++) out.push(types[k % types.length]!);
  return out;
}

/** 70% the lane's character, otherwise a section-random kind (keeps it lively). */
function pickKind(
  pref: PlatformKind,
  types: readonly PlatformKind[],
  rng: ReturnType<typeof createRng>,
): PlatformKind {
  return rng.chance(0.7) ? pref : rng.pick(types);
}

function buildBrick(
  id: number,
  kind: PlatformKind,
  center: Vec3,
  topHeight: number,
  hazardChance: number,
  colorIndex: number,
  R: (a: number, b: number) => number,
  rng: ReturnType<typeof createRng>,
): PlatformDef {
  const [posX, , posZ] = center;
  if (kind === "moving") {
    const width = R(2.0, 2.5);
    const axis: MoveAxis = rng.chance(0.5) ? "x" : "z";
    const axisPos = Math.abs(axis === "x" ? posX : posZ);
    const amplitude = clamp(R(1.2, 2.2), 0.8, Math.max(0.8, 15.5 - axisPos));
    return {
      id,
      kind,
      center,
      size: [width, PLATFORM_THICKNESS, PLATFORM_DEPTH],
      colorIndex,
      axis,
      amplitude,
      omega: R(1.1, 1.8),
      phase: rng.next() * Math.PI * 2,
    };
  }
  if (kind === "crumbling") {
    return {
      id,
      kind,
      center,
      size: [R(1.9, 2.4), PLATFORM_THICKNESS, PLATFORM_DEPTH],
      colorIndex,
    };
  }
  // compact so parallel lanes stay distinct instead of merging with their
  // same-height neighbours
  const width = R(2.1, 2.6);
  const p: SolidPlatformDef = {
    id,
    kind: "solid",
    role: "normal",
    center,
    size: [width, PLATFORM_THICKNESS, PLATFORM_DEPTH],
    colorIndex,
  };
  if (width >= 2.35 && rng.chance(hazardChance)) {
    const side = rng.chance(0.5) ? -1 : 1;
    p.hazard = {
      center: [posX + side * (width / 2 - 0.4), topHeight + 0.325, posZ],
      size: [0.8, 0.65, 0.8],
    };
  }
  return p;
}
