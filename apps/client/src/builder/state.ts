/**
 * Robo Builder — idle landmark construction. All economy math lives here as
 * pure functions of the state, so the per-tick sim, the offline settlement
 * and the tests all share one source of truth.
 */
import { landmarkAt, tourMultiplier, tourOf } from "./landmarks.js";

export const WALK_DISTANCE_M = 6; // brick pile ↔ construction site, one way
export const OFFLINE_CAP_HOURS = 8;
export const MAX_VISUAL_WORKERS = 12;

export interface BuilderState {
  gold: number;
  /** How many landmarks have been completed EVER (tours keep counting up). */
  landmarkIndex: number;
  /** Blocks placed on the landmark under construction. */
  placedBlocks: number;
  workers: number;
  speedLevel: number;
  valueLevel: number;
  crane: boolean;
  goalIndex: number;
  totalBlocks: number;
  /** Per-worker cycle progress [0,1) — staggered so deliveries spread out. */
  workerProgress: number[];
}

export function createInitialState(): BuilderState {
  return {
    gold: 0,
    landmarkIndex: 0,
    placedBlocks: 0,
    workers: 1,
    speedLevel: 0,
    valueLevel: 0,
    crane: false,
    goalIndex: 0,
    totalBlocks: 0,
    workerProgress: [0],
  };
}

// ---------------------------------------------------------------- economy

export function walkSpeed(state: BuilderState): number {
  return 2 * 1.25 ** state.speedLevel; // m/s
}

/** Seconds for one full pile→site→pile delivery cycle. */
export function cycleTime(state: BuilderState): number {
  const fixed = state.crane ? 0.75 : 1.5; // pickup + place
  return (2 * WALK_DISTANCE_M) / walkSpeed(state) + fixed;
}

/** Gold per block — upgrade curve × world-tour multiplier. */
export function blockValue(state: BuilderState): number {
  return 1.4 ** state.valueLevel * tourMultiplier(tourOf(state.landmarkIndex));
}

/** Average DELIVERIES per second across the whole crew (economy unit). */
export function deliveriesPerSecond(state: BuilderState): number {
  return state.workers / cycleTime(state);
}

/** Voxels appearing per second — deliveries × bundle size (HUD display). */
export function voxelsPerSecond(state: BuilderState): number {
  return deliveriesPerSecond(state) * currentLandmark(state).deliverySize;
}

export const CRANE_COST = 300;

export function workerCost(state: BuilderState): number {
  return Math.ceil(10 * 1.5 ** (state.workers - 1));
}

export function speedCost(state: BuilderState): number {
  return Math.ceil(5 * 1.6 ** state.speedLevel);
}

export function valueCost(state: BuilderState): number {
  return Math.ceil(8 * 1.7 ** state.valueLevel);
}

export type ShopItem = "worker" | "speed" | "value" | "crane";

export function itemCost(state: BuilderState, item: ShopItem): number {
  switch (item) {
    case "worker":
      return workerCost(state);
    case "speed":
      return speedCost(state);
    case "value":
      return valueCost(state);
    case "crane":
      return CRANE_COST;
  }
}

/** Attempt a purchase; mutates and returns true on success. */
export function buy(state: BuilderState, item: ShopItem): boolean {
  if (item === "crane" && state.crane) return false;
  const cost = itemCost(state, item);
  if (state.gold < cost) return false;
  state.gold -= cost;
  switch (item) {
    case "worker":
      state.workers++;
      // stagger the newcomer half a cycle away from worker 0
      state.workerProgress.push(((state.workerProgress[0] ?? 0) + 0.5) % 1);
      break;
    case "speed":
      state.speedLevel++;
      break;
    case "value":
      state.valueLevel++;
      break;
    case "crane":
      state.crane = true;
      break;
  }
  return true;
}

// ---------------------------------------------------------------- landmark helpers

export function currentLandmark(state: BuilderState) {
  return landmarkAt(state.landmarkIndex);
}

export function currentLandmarkTotal(state: BuilderState): number {
  return currentLandmark(state).blocks.length;
}

/** Completion bonus for the CURRENT landmark, tour multiplier applied. */
export function currentLandmarkBonus(state: BuilderState): number {
  return currentLandmark(state).bonus * tourMultiplier(tourOf(state.landmarkIndex));
}
