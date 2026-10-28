import { isWater, waterHeight } from "@robo/shared";
import type { VoxelWorld } from "./voxelWorld.js";

/**
 * Minimal AABB-vs-voxel character physics (no rapier — the grid IS the
 * collision shape). Axis-separated sweep: move each axis independently and
 * clamp against the first overlapping solid cell, the classic Minecraft
 * approach. Pure and deterministic; unit-tested.
 */

export const BODY_WIDTH = 0.6;
export const BODY_HEIGHT = 1.8;
export const GRAVITY = 24;
export const JUMP_SPEED = 8.6;
export const MOVE_SPEED = 4.6;

/**
 * Swimming. Below SWIM_DEPTH of the body underwater it is wading (a puddle
 * only slows you); deeper, gravity and drag change: you sink slowly to
 * -WATER_GRAVITY/WATER_DRAG (-1.5 m/s), Space swims up to
 * (SWIM_ACCEL - WATER_GRAVITY)/WATER_DRAG (+2 m/s), and Space against a bank
 * hops you out (CLIMB_OUT lifts the feet ~0.6 m — over a full block's edge
 * from a surface that sits 1/8 below it).
 */
export const SWIM_DEPTH = 0.35;
const WATER_GRAVITY = 6;
const WATER_DRAG = 4;
const SWIM_ACCEL = 14;
const CLIMB_OUT = 5.6;
/** Horizontal speed when fully under (wading scales toward it). */
const SWIM_SPEED = 0.6;

/**
 * How much of the body is underwater, 0‒1 — sampled down its centre column,
 * each water cell counting up to its own surface height.
 */
export function submersion(world: VoxelWorld, body: Body): number {
  const h = body.h ?? BODY_HEIGHT;
  const cx = Math.floor(body.x);
  const cz = Math.floor(body.z);
  let surface = -Infinity;
  for (let y = Math.floor(body.y); y <= Math.floor(body.y + h); y++) {
    const id = world.get(cx, y, cz);
    if (!isWater(id)) continue;
    surface = Math.max(surface, y + waterHeight(id, isWater(world.get(cx, y + 1, cz))));
  }
  if (surface === -Infinity) return 0;
  return Math.min(1, Math.max(0, (surface - body.y) / h));
}

/** Is this point (the camera's eye) underwater? */
export function pointInWater(world: VoxelWorld, x: number, y: number, z: number): boolean {
  const cy = Math.floor(y);
  const id = world.get(Math.floor(x), cy, Math.floor(z));
  if (!isWater(id)) return false;
  return y < cy + waterHeight(id, isWater(world.get(Math.floor(x), cy + 1, Math.floor(z))));
}

export interface Body {
  /** Feet-center position. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  /** Footprint/height overrides. Omitted = the player's BODY_WIDTH/HEIGHT, so
   *  every existing caller keeps its exact shape; the pet (and anything else
   *  smaller than a robot) fills these in and shares the same sweep. */
  w?: number;
  h?: number;
  /** Hop height override. A pet that launches at the robot's 8.6 m/s reads as
   *  a flea, so small bodies set their own. */
  jumpSpeed?: number;
  /** Set by stepBody: how much of the body was underwater this tick (0‒1). */
  wet?: number;
}

const EPS = 1e-4;

const halfOf = (body: Body): number => (body.w ?? BODY_WIDTH) / 2;
const heightOf = (body: Body): number => body.h ?? BODY_HEIGHT;

/**
 * Camera-relative wish direction from raw input axes (fwd/strafe ∈ [-1,1]),
 * normalized. forward = (sin yaw, cos yaw); screen-right = forward × up =
 * (-cos yaw, sin yaw) — getting this cross product backwards is exactly the
 * "A/D feels inverted" bug, so it lives here under unit test.
 */
export function wishFromInput(yaw: number, fwd: number, strafe: number): [number, number] {
  const len = Math.hypot(fwd, strafe) || 1;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return [(sin * fwd - cos * strafe) / len, (cos * fwd + sin * strafe) / len];
}

function collides(world: VoxelWorld, body: Body): boolean {
  const { x, y, z } = body;
  const half = halfOf(body);
  const x0 = Math.floor(x - half);
  const x1 = Math.floor(x + half - EPS);
  const y0 = Math.floor(y);
  const y1 = Math.floor(y + heightOf(body) - EPS);
  const z0 = Math.floor(z - half);
  const z1 = Math.floor(z + half - EPS);
  for (let ix = x0; ix <= x1; ix++) {
    for (let iy = y0; iy <= y1; iy++) {
      for (let iz = z0; iz <= z1; iz++) {
        if (world.isBlocked(ix, iy, iz)) return true;
      }
    }
  }
  return false;
}

/**
 * After a spawn/respawn/teleport a body can land embedded in terrain (a tree,
 * the castle, a hill). Lift it straight up to the first clear position so it
 * never gets wedged. Returns the settled body.
 */
export function unstick(world: VoxelWorld, body: Body): Body {
  if (!collides(world, body)) return body;
  for (let i = 0; i < WORLD_UNSTICK_LIMIT; i++) {
    body.y += 0.5;
    if (!collides(world, body)) break;
  }
  body.vy = 0;
  body.grounded = false;
  return body;
}

const WORLD_UNSTICK_LIMIT = 120;

/** Test a new posture height without pushing the player through a ceiling. */
export function canOccupy(world: VoxelWorld, body: Body, height: number): boolean {
  return Number.isFinite(height) && height > 0 && !collides(world, { ...body, h: height });
}


/** Would a block placed at this voxel overlap the body? (deny self-burial) */
export function overlapsVoxel(body: Body, vx: number, vy: number, vz: number): boolean {
  const half = halfOf(body);
  return (
    vx + 1 > body.x - half &&
    vx < body.x + half &&
    vy + 1 > body.y &&
    vy < body.y + heightOf(body) &&
    vz + 1 > body.z - half &&
    vz < body.z + half
  );
}

/** Sub-step cap keeps fast falls from tunnelling through 1m cells. */
const MAX_STEP = 0.45;

/**
 * Move one axis with bisected contact resolution — slides flush against walls
 * and floors with no floaty gap. NO auto-step: a full-block ledge stops you,
 * so climbing is a deliberate jump (auto-climb read as the camera teleporting
 * up while you brushed a wall).
 */
function moveAxis(world: VoxelWorld, body: Body, axis: "x" | "y" | "z", amount: number): void {
  let remaining = amount;
  while (remaining !== 0) {
    const step = Math.sign(remaining) * Math.min(Math.abs(remaining), MAX_STEP);
    remaining -= step;
    const prev = body[axis];
    body[axis] = prev + step;
    if (collides(world, body)) {
      let free = 0;
      let blocked = step;
      for (let i = 0; i < 10; i++) {
        const mid = (free + blocked) / 2;
        body[axis] = prev + mid;
        if (collides(world, body)) blocked = mid;
        else free = mid;
      }
      body[axis] = prev + free;
      if (axis === "y") {
        if (amount < 0) body.grounded = true;
        body.vy = 0;
      }
      return;
    }
  }
}

export function stepBody(world: VoxelWorld, body: Body, dt: number, wishX: number, wishZ: number, jump: boolean): void {
  const wet = submersion(world, body);
  body.wet = wet;
  const swimming = wet >= SWIM_DEPTH;
  const drag = 1 - (1 - SWIM_SPEED) * Math.min(1, wet / 0.6);
  body.vx = wishX * MOVE_SPEED * drag;
  body.vz = wishZ * MOVE_SPEED * drag;
  if (swimming) {
    body.vy += ((jump ? SWIM_ACCEL : 0) - WATER_GRAVITY) * dt;
    body.vy *= Math.exp(-WATER_DRAG * dt); // water brakes a dive within a body length
  } else {
    if (jump && body.grounded) {
      body.vy = body.jumpSpeed ?? JUMP_SPEED;
      body.grounded = false;
    }
    body.vy -= GRAVITY * dt;
    if (body.vy < -30) body.vy = -30;
  }

  if (body.vy <= 0) body.grounded = false;
  const startX = body.x;
  const startZ = body.z;
  moveAxis(world, body, "x", body.vx * dt);
  moveAxis(world, body, "z", body.vz * dt);
  // swimming into a bank with Space held: hop out onto it, Minecraft-style
  if (swimming && jump && wet < 0.9) {
    const wanted = Math.hypot(body.vx, body.vz) * dt;
    const moved = Math.hypot(body.x - startX, body.z - startZ);
    if (wanted > 1e-4 && moved < wanted * 0.5) body.vy = Math.max(body.vy, CLIMB_OUT);
  }
  const wasFalling = body.vy < 0;
  const beforeY = body.y;
  moveAxis(world, body, "y", body.vy * dt);
  if (wasFalling && body.y === beforeY) body.grounded = true;
}
