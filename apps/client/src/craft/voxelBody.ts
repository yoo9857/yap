import { shapeIntersectsBox, rampHeight, isFullCubeShape } from "./shapes.js";
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
/** Ground walk, and the Shift run. Swim and pets stay on {@link MOVE_SPEED}. */
export const WALK_SPEED = 2.7;
export const RUN_SPEED = 5.2;

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
 * The water a body is IN at this cell (its id), or 0: every water cell, falling water included.
 * The game draws falling water as whole cells (water_mesh.rs `build_simple`), so a fall beside a
 * wall is water to swim in like any other. (While falls beside a wall were drawn as thin sheets
 * this let a body walk through them; left in after the shape changed, the robot stood inside a
 * column of water without swimming and the screen stayed dry.)
 */
export function waterBodyAt(world: VoxelWorld, x: number, y: number, z: number): number {
  const id = world.waterAt(x, y, z);
  return isWater(id) ? id : 0;
}

/**
 * How far a point is below the water's surface (m; negative: above it), measured against the
 * surface that is DRAWN — the top of the highest water cell over the point — or null where there
 * is no water under or around it. The underwater screen follows this, not "is the eye in a water
 * cell": a cell is full to 0.875 at most, and a stream's is a tenth of that.
 */
export function waterDepthAt(world: VoxelWorld, x: number, y: number, z: number): number | null {
  const cx = Math.floor(x), cz = Math.floor(z);
  let cy = Math.floor(y);
  if (waterBodyAt(world, cx, cy, cz) === 0) {
    cy--; // just over a surface: the water is the cell below
    if (waterBodyAt(world, cx, cy, cz) === 0) return null;
  }
  while (waterBodyAt(world, cx, cy + 1, cz) !== 0) cy++;
  // The drawn top is not flat at the cell's own height: its four corners are shared with the
  // cells round them (water_mesh.rs `corner_height` — full where one of the four has water over
  // it, else the mean of their heights) and the top is the two triangles (0,1,2), (0,2,3) over
  // them. Measured against the flat height, the eye beside a fall or on a stream's slope was
  // "under" a surface that is drawn well away from it, and the view behind turned to water.
  const corner = (px: number, pz: number): number => {
    let sum = 0, n = 0;
    for (let dx = -1; dx <= 0; dx++) for (let dz = -1; dz <= 0; dz++) {
      const id = waterBodyAt(world, px + dx, cy, pz + dz);
      if (id === 0) continue;
      if (waterBodyAt(world, px + dx, cy + 1, pz + dz) !== 0) return 1;
      sum += waterHeight(id, false);
      n++;
    }
    return sum / n;
  };
  const h0 = corner(cx, cz), h1 = corner(cx, cz + 1), h2 = corner(cx + 1, cz + 1), h3 = corner(cx + 1, cz);
  const u = x - cx, v = z - cz;
  const top = v >= u ? h0 + (h2 - h1) * u + (h1 - h0) * v : h0 + (h3 - h0) * u + (h2 - h3) * v;
  return cy + top - y;
}

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
    const id = waterBodyAt(world, cx, y, cz);
    if (id === 0) continue;
    surface = Math.max(surface, y + waterHeight(id, waterBodyAt(world, cx, y + 1, cz) !== 0));
  }
  if (surface === -Infinity) return 0;
  return Math.min(1, Math.max(0, (surface - body.y) / h));
}

/** Is this point (the camera's eye) underwater? */
export function pointInWater(world: VoxelWorld, x: number, y: number, z: number): boolean {
  const cy = Math.floor(y);
  const id = waterBodyAt(world, Math.floor(x), cy, Math.floor(z));
  if (id === 0) return false;
  return y < cy + waterHeight(id, waterBodyAt(world, Math.floor(x), cy + 1, Math.floor(z)) !== 0);
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
        if (world.isBlocked(ix, iy, iz) && (world.propSolid?.(ix,iy,iz) || isFullCubeShape(world.getShape(ix,iy,iz)) || shapeIntersectsBox(world.getShape(ix,iy,iz),{min:[x-half-ix,y-iy,z-half-iz],max:[x+half-ix,y+heightOf(body)-iy,z+half-iz]}))) return true;
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

/** Body/shape test used by both the placement ghost and the actual stamp. */
export function overlapsShapedVoxel(body:Body,x:number,y:number,z:number,shape:number):boolean {const half=halfOf(body);return shapeIntersectsBox(shape,{min:[body.x-half-x,body.y-y,body.z-half-z],max:[body.x+half-x,body.y+heightOf(body)-y,body.z+half-z]});}
function nearbyRampFloor(world:VoxelWorld,body:Body):number|null {
 const half=halfOf(body);let highest=-Infinity;
 for(let y=Math.floor(body.y-.15);y<=Math.floor(body.y+.15);y++)for(let x=Math.floor(body.x-half);x<=Math.floor(body.x+half-EPS);x++)for(let z=Math.floor(body.z-half);z<=Math.floor(body.z+half-EPS);z++){
  if(!world.isSolid(x,y,z))continue;const shape=world.getShape(x,y,z);
  const x0=Math.max(0,body.x-half-x),x1=Math.min(1,body.x+half-x),z0=Math.max(0,body.z-half-z),z1=Math.min(1,body.z+half-z);
  for(const cx of [x0,x1])for(const cz of [z0,z1]){const h=rampHeight(shape,cx,cz);if(h!==null)highest=Math.max(highest,y+h);}
 }
 return Number.isFinite(highest)?highest:null;
}

/** Sub-step cap keeps fast falls from tunnelling through 1m cells. */
const MAX_STEP = 0.45;
/**
 * The tallest ledge a walking body climbs without jumping: a half block or one stair (0.5 m), never a
 * whole block. Owner's call (2026-11-04): stairs you have to jump up every step are not stairs.
 */
export const STEP_UP = 0.51;

/** Blocked while walking: lift onto the ledge if it is at most STEP_UP tall and there is headroom,
 *  landing exactly on its top (bisected), or leave the body where it was. */
function stepUp(world: VoxelWorld, body: Body): boolean {
  const oldY = body.y;
  body.y = oldY + STEP_UP;
  if (collides(world, body)) { body.y = oldY; return false; }
  let blocked = 0, free = STEP_UP;
  for (let i = 0; i < 12; i++) {
    const mid = (blocked + free) / 2;
    body.y = oldY + mid;
    if (collides(world, body)) blocked = mid; else free = mid;
  }
  body.y = oldY + free;
  return true;
}

/**
 * Move one axis with bisected contact resolution — slides flush against walls
 * and floors with no floaty gap. A full-block ledge stops you, so climbing it is a
 * deliberate jump (auto-climb read as the camera teleporting up while you brushed a
 * wall); only half-block ledges (STEP_UP) are walked up.
 */
function moveAxis(world: VoxelWorld, body: Body, axis: "x" | "y" | "z", amount: number, followRamp=false): void {
  let remaining = amount;
  while (remaining !== 0) {
    const step = Math.sign(remaining) * Math.min(Math.abs(remaining), MAX_STEP);
    remaining -= step;
    const prev = body[axis];
    body[axis] = prev + step;
    if(followRamp&&axis!=="y"){const top=nearbyRampFloor(world,body);if(top!==null&&Math.abs(top-body.y)<=Math.abs(step)+.015){const oldY=body.y;body.y=top+EPS;if(!collides(world,body)){body.vy=0;body.grounded=true;continue;}body.y=oldY;}}
    if (collides(world, body) && followRamp && axis !== "y" && stepUp(world, body)) { body.vy = 0; body.grounded = true; continue; }
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

export function stepBody(
  world: VoxelWorld,
  body: Body,
  dt: number,
  wishX: number,
  wishZ: number,
  jump: boolean,
  pushX = 0,
  pushZ = 0,
): void {
  const wasGrounded=body.grounded;
  const wet = submersion(world, body);
  body.wet = wet;
  const swimming = wet >= SWIM_DEPTH;
  const drag = 1 - (1 - SWIM_SPEED) * Math.min(1, wet / 0.6);
  // A tap's shove is added on top of input. It is not stored on the body:
  // the caller passes what is left of it each tick, or the next step walks it off.
  body.vx = wishX * MOVE_SPEED * drag + pushX;
  body.vz = wishZ * MOVE_SPEED * drag + pushZ;
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
  moveAxis(world, body, "x", body.vx * dt,wasGrounded&&!jump&&!swimming);
  moveAxis(world, body, "z", body.vz * dt,wasGrounded&&!jump&&!swimming);
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
