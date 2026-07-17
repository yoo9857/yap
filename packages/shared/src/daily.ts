import { hashString } from "./level/rng.js";

/**
 * Daily tower: one tower per calendar day, identical for every player.
 * The seed is a pure function of the date string, so client and server —
 * and an offline client — independently derive the same tower. The tower
 * timezone is fixed by a UTC offset (default KST, +540 min) so "midnight"
 * is one global moment, not each browser's local midnight.
 */

export const DAY_MS = 86_400_000;
export const DEFAULT_DAY_UTC_OFFSET_MIN = 540; // Asia/Seoul
/** Day #1 — launch date (in tower timezone). */
export const DAILY_EPOCH_DATE = "2026-07-17";

export interface DayInfo {
  /** YYYY-MM-DD in the tower timezone. */
  dateStr: string;
  /** 1-based day count since DAILY_EPOCH_DATE. */
  dayNumber: number;
  /** UTC ms when this tower day started / ends. */
  dayStartMs: number;
  nextDayStartMs: number;
  seed: number;
}

export function dailySeed(dateStr: string): number {
  return hashString(`robo-tower-daily-${dateStr}`);
}

function dateStrOfDayIndex(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function dayIndexOfDateStr(dateStr: string): number {
  return Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / DAY_MS);
}

export function dayInfoAt(nowUtcMs: number, offsetMin = DEFAULT_DAY_UTC_OFFSET_MIN): DayInfo {
  const offsetMs = offsetMin * 60_000;
  const dayIndex = Math.floor((nowUtcMs + offsetMs) / DAY_MS);
  const dateStr = dateStrOfDayIndex(dayIndex);
  return {
    dateStr,
    dayNumber: dayIndex - dayIndexOfDateStr(DAILY_EPOCH_DATE) + 1,
    dayStartMs: dayIndex * DAY_MS - offsetMs,
    nextDayStartMs: (dayIndex + 1) * DAY_MS - offsetMs,
    seed: dailySeed(dateStr),
  };
}

/**
 * Shared moving-platform timeline: seconds since the tower day started, in
 * SERVER time. Every client evaluates the analytic platform positions on
 * this axis, so all peers (and the server, if it ever needs to) agree on
 * where every moving platform is. Day-relative keeps the float small.
 */
export function timelineSeconds(serverNowMs: number, dayStartMs: number): number {
  return (serverNowMs - dayStartMs) / 1000;
}
