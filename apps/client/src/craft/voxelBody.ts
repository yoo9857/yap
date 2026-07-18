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

export interface Body {
  /** Feet-center position. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
}

const HALF = BODY_WIDTH / 2;
const EPS = 1e-4;

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

function collides(world: VoxelWorld, x: number, y: number, z: number): boolean {
  const x0 = Math.floor(x - HALF);
  const x1 = Math.floor(x + HALF - EPS);
  const y0 = Math.floor(y);
  const y1 = Math.floor(y + BODY_HEIGHT - EPS);
  const z0 = Math.floor(z - HALF);
  const z1 = Math.floor(z + HALF - EPS);
  for (let ix = x0; ix <= x1; ix++) {
    for (let iy = y0; iy <= y1; iy++) {
      for (let iz = z0; iz <= z1; iz++) {
        if (world.isSolid(ix, iy, iz)) return true;
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
  if (!collides(world, body.x, body.y, body.z)) return body;
  for (let i = 0; i < WORLD_UNSTICK_LIMIT; i++) {
    body.y += 0.5;
    if (!collides(world, body.x, body.y, body.z)) break;
  }
  body.vy = 0;
  body.grounded = false;
  return body;
}

const WORLD_UNSTICK_LIMIT = 120;

/** Would a block placed at this voxel overlap the body? (deny self-burial) */
export function overlapsVoxel(body: Body, vx: number, vy: number, vz: number): boolean {
  return (
    vx + 1 > body.x - HALF &&
    vx < body.x + HALF &&
    vy + 1 > body.y &&
    vy < body.y + BODY_HEIGHT &&
    vz + 1 > body.z - HALF &&
    vz < body.z + HALF
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
    if (collides(world, body.x, body.y, body.z)) {
      let free = 0;
      let blocked = step;
      for (let i = 0; i < 10; i++) {
        const mid = (free + blocked) / 2;
        body[axis] = prev + mid;
        if (collides(world, body.x, body.y, body.z)) blocked = mid;
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
  body.vx = wishX * MOVE_SPEED;
  body.vz = wishZ * MOVE_SPEED;
  if (jump && body.grounded) {
    body.vy = JUMP_SPEED;
    body.grounded = false;
  }
  body.vy -= GRAVITY * dt;
  if (body.vy < -30) body.vy = -30;

  if (body.vy <= 0) body.grounded = false;
  moveAxis(world, body, "x", body.vx * dt);
  moveAxis(world, body, "z", body.vz * dt);
  const wasFalling = body.vy < 0;
  const beforeY = body.y;
  moveAxis(world, body, "y", body.vy * dt);
  if (wasFalling && body.y === beforeY) body.grounded = true;
}
