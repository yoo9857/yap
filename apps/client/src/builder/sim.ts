import type { Landmark } from "./landmarks.js";
import {
  blockValue,
  currentLandmark,
  currentLandmarkBonus,
  currentLandmarkTotal,
  cycleTime,
  deliveriesPerSecond,
  type BuilderState,
} from "./state.js";

export type SimEvent =
  | { type: "block"; workerIndex: number; value: number }
  /** Crossed another 10% of the blueprint — small celebration. */
  | { type: "milestone"; fraction: number }
  | { type: "landmark"; landmark: Landmark; bonus: number };

/**
 * Advance the live simulation. Each worker walks its delivery cycle; a
 * cycle wrap lays one blueprint block. Pure — the render layer consumes the
 * returned events for effects/sfx.
 */
export function tick(state: BuilderState, dt: number): SimEvent[] {
  const events: SimEvent[] = [];
  const cycle = cycleTime(state);

  for (let i = 0; i < state.workers; i++) {
    const progress = (state.workerProgress[i] ?? 0) + dt / cycle;
    if (progress >= 1) {
      state.workerProgress[i] = progress % 1;
      layBlock(state, i, events);
    } else {
      state.workerProgress[i] = progress;
    }
  }
  return events;
}

function layBlock(state: BuilderState, workerIndex: number, events: SimEvent[]): void {
  const value = blockValue(state);
  const total = currentLandmarkTotal(state);
  const before = state.placedBlocks;

  // one delivery = one bundle of voxels (gold is paid per DELIVERY)
  const bundle = Math.min(currentLandmark(state).deliverySize, total - before);
  state.gold += value;
  state.totalBlocks += bundle;
  state.placedBlocks += bundle;
  events.push({ type: "block", workerIndex, value });

  const decile = (n: number) => Math.floor((n * 10) / total);
  if (state.placedBlocks < total && decile(state.placedBlocks) > decile(before)) {
    events.push({ type: "milestone", fraction: decile(state.placedBlocks) / 10 });
  }

  if (state.placedBlocks >= total) {
    const landmark = currentLandmark(state);
    const bonus = currentLandmarkBonus(state);
    state.gold += bonus;
    state.landmarkIndex++;
    state.placedBlocks = 0;
    events.push({ type: "landmark", landmark, bonus });
  }
}

export interface OfflineGains {
  seconds: number;
  blocks: number;
  landmarks: number;
  gold: number;
}

/**
 * Deterministic offline settlement from the average delivery rate. Walks
 * through as many blueprints as the elapsed time affords, paying per-DELIVERY
 * gold (with the tour multiplier of each landmark) and completion bonuses —
 * identical economy math as the live tick, just integrated.
 */
export function settleOffline(state: BuilderState, elapsedMs: number, capMs: number): OfflineGains {
  const seconds = Math.max(0, Math.min(elapsedMs, capMs)) / 1000;
  let deliveries = Math.floor(deliveriesPerSecond(state) * seconds);
  if (deliveries <= 0) return { seconds, blocks: 0, landmarks: 0, gold: 0 };

  let gold = 0;
  let placedTotal = 0;
  let landmarksDone = 0;

  while (deliveries > 0) {
    const bundle = currentLandmark(state).deliverySize;
    const total = currentLandmarkTotal(state);
    const need = total - state.placedBlocks;
    const deliveriesNeeded = Math.ceil(need / bundle);
    const spending = Math.min(deliveries, deliveriesNeeded);
    const placing = Math.min(spending * bundle, need);

    gold += spending * blockValue(state); // tour multiplier of THIS landmark
    state.placedBlocks += placing;
    placedTotal += placing;
    deliveries -= spending;

    if (state.placedBlocks >= total) {
      gold += currentLandmarkBonus(state);
      state.landmarkIndex++;
      state.placedBlocks = 0;
      landmarksDone++;
    }
  }

  state.gold += gold;
  state.totalBlocks += placedTotal;
  return { seconds, blocks: placedTotal, landmarks: landmarksDone, gold };
}
