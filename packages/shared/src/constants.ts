/**
 * Gameplay constants ported from the 2.5D prototype at SCALE = 40 px/m.
 * These numbers define the game feel — do not tweak casually.
 */

// --- simulation & networking rates ---
export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;
export const SEND_HZ = 20; // client → server move reports (every 3rd tick)
export const SNAPSHOT_HZ = 15; // server → client broadcast
export const MAX_PLAYERS_PER_ROOM = 8;
export const PROTOCOL_VERSION = 2;

// --- character physics (meters, seconds) ---
export const GRAVITY = 62.5;
export const MOVE_SPEED = 6.9;
export const JUMP_VELOCITY = 20;
export const MAX_FALL_SPEED = 32.5;
export const GROUND_ACCEL = 85;
export const AIR_ACCEL = 52.5;
export const COYOTE_TICKS = 6; // 0.10 s
export const JUMP_BUFFER_TICKS = 7; // 0.12 s
export const JUMP_RELEASE_CLAMP = 6.5; // variable jump: cap vy on release

// --- character body ---
export const CAPSULE_HALF_HEIGHT = 0.55;
export const CAPSULE_RADIUS = 0.35;
export const CHARACTER_HEIGHT = 2 * (CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS);

// --- world ---
export const WORLD_HALF_EXTENT = 12; // tower platforms wander in a 24×24 m column
export const KILL_PLANE_Y = -10;
export const PLATFORM_THICKNESS = 0.55;
export const PLATFORM_DEPTH = 3.0;

// --- crumbling platform FSM (seconds) ---
export const CRUMBLE_SHAKE_S = 0.55;
export const CRUMBLE_GONE_S = 3.0;

// --- moving platform validation allowance: max |amp·ω| ---
export const MAX_PLATFORM_SPEED = 4.7;

// --- level generation (identical difficulty curve to the prototype) ---
export const LEVEL_SECTIONS = [
  { count: 9, types: ["solid"], hazard: 0 },
  { count: 9, types: ["solid", "moving", "solid"], hazard: 0 },
  { count: 9, types: ["crumbling", "solid", "crumbling"], hazard: 0.3 },
  { count: 11, types: ["moving", "crumbling", "solid", "moving"], hazard: 0.4 },
] as const;

export const DEFAULT_SEED = 20260717;

// classic obby rainbow brick colors (Tower of Hell style)
export const BRICK_COLORS = [
  "#e2231a",
  "#f5802b",
  "#f9d71c",
  "#4bb54a",
  "#00a2ac",
  "#0f6cbd",
  "#7b4fd0",
  "#e5418f",
] as const;
