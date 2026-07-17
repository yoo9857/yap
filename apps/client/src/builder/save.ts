import { z } from "zod";
import {
  OFFLINE_CAP_HOURS,
  createInitialState,
  currentLandmarkTotal,
  type BuilderState,
} from "./state.js";
import { settleOffline, type OfflineGains } from "./sim.js";

const SAVE_KEY = "robo-builder-save-v1"; // key stays; payload carries `v`

const saveSchemaV2 = z.object({
  v: z.literal(2),
  gold: z.number().finite().nonnegative(),
  landmarkIndex: z.number().int().nonnegative(),
  placedBlocks: z.number().int().nonnegative(),
  workers: z.number().int().positive().max(10_000),
  speedLevel: z.number().int().nonnegative().max(1000),
  valueLevel: z.number().int().nonnegative().max(1000),
  crane: z.boolean(),
  goalIndex: z.number().int().nonnegative(),
  totalBlocks: z.number().int().nonnegative(),
  savedAtMs: z.number().finite().positive(),
});

/** The floor-tower era save — upgrades and gold carry over on migration. */
const saveSchemaV1 = z.object({
  v: z.literal(1),
  gold: z.number().finite().nonnegative(),
  workers: z.number().int().positive().max(10_000),
  speedLevel: z.number().int().nonnegative().max(1000),
  valueLevel: z.number().int().nonnegative().max(1000),
  crane: z.boolean(),
  totalBlocks: z.number().int().nonnegative(),
  savedAtMs: z.number().finite().positive(),
});

export type SaveData = z.infer<typeof saveSchemaV2>;

/** Minimal storage seam so the pure logic is testable without a browser. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function serialize(state: BuilderState, nowMs: number): string {
  const data: SaveData = {
    v: 2,
    gold: state.gold,
    landmarkIndex: state.landmarkIndex,
    placedBlocks: state.placedBlocks,
    workers: state.workers,
    speedLevel: state.speedLevel,
    valueLevel: state.valueLevel,
    crane: state.crane,
    goalIndex: state.goalIndex,
    totalBlocks: state.totalBlocks,
    savedAtMs: nowMs,
  };
  return JSON.stringify(data);
}

/** Wipe the save entirely — next load starts a fresh game. */
export function clearSave(storage: { removeItem(key: string): void }): void {
  try {
    storage.removeItem(SAVE_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

export function save(state: BuilderState, storage: KeyValueStorage, nowMs: number): void {
  try {
    storage.setItem(SAVE_KEY, serialize(state, nowMs));
  } catch {
    // storage full/unavailable — the game keeps running, just unsaved
  }
}

export interface LoadResult {
  state: BuilderState;
  /** Non-null when time passed since the save — show the welcome-back modal. */
  offline: OfflineGains | null;
}

/**
 * Load + settle offline progress. A corrupt/missing/hostile save falls back
 * to a fresh game; a v1 (floor-tower era) save migrates its economy but
 * restarts the world tour.
 */
export function load(storage: KeyValueStorage, nowMs: number): LoadResult {
  let raw: string | null = null;
  try {
    raw = storage.getItem(SAVE_KEY);
  } catch {
    /* unavailable */
  }
  if (!raw) return { state: createInitialState(), offline: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: createInitialState(), offline: null };
  }

  let state: BuilderState;
  let savedAtMs: number;

  const v2 = saveSchemaV2.safeParse(parsed);
  if (v2.success) {
    const d = v2.data;
    state = {
      gold: d.gold,
      landmarkIndex: d.landmarkIndex,
      placedBlocks: d.placedBlocks,
      workers: d.workers,
      speedLevel: d.speedLevel,
      valueLevel: d.valueLevel,
      crane: d.crane,
      goalIndex: d.goalIndex,
      totalBlocks: d.totalBlocks,
      workerProgress: Array.from({ length: d.workers }, (_, i) => i / d.workers),
    };
    savedAtMs = d.savedAtMs;
  } else {
    const v1 = saveSchemaV1.safeParse(parsed);
    if (!v1.success) return { state: createInitialState(), offline: null };
    const d = v1.data;
    state = {
      ...createInitialState(),
      gold: d.gold,
      workers: d.workers,
      speedLevel: d.speedLevel,
      valueLevel: d.valueLevel,
      crane: d.crane,
      totalBlocks: d.totalBlocks,
      workerProgress: Array.from({ length: d.workers }, (_, i) => i / d.workers),
    };
    savedAtMs = d.savedAtMs;
  }

  // clamp a corrupt-but-schema-valid placedBlocks into the blueprint
  state.placedBlocks = Math.min(state.placedBlocks, Math.max(0, currentLandmarkTotal(state) - 1));

  const elapsed = nowMs - savedAtMs;
  if (elapsed < 5000) return { state, offline: null }; // quick reload — no modal

  const gains = settleOffline(state, elapsed, OFFLINE_CAP_HOURS * 3_600_000);
  return { state, offline: gains.blocks > 0 ? gains : null };
}
