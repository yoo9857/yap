/**
 * Player settings shared by every mode: language, mouse sensitivity and the
 * two volume sliders. One small localStorage record, read once at load and
 * validated field by field, so a hand-edited or stale value can never break
 * the game — it just falls back to the default.
 *
 * `?lang=en` / `?lang=ko` overrides the language for that page view only
 * (screenshots, sharing a link) without touching the saved choice.
 */
export type Lang = "ko" | "en";

export interface Settings {
  lang: Lang;
  /** Multiplier on each mode's base look speed. */
  sensitivity: number;
  /** 0–1, scales each mode's own music level. */
  music: number;
  /** 0–1, scales every sound effect. */
  sfx: number;
}

export const SENSITIVITY_RANGE = { min: 0.3, max: 2.5 } as const;
const KEY = "craftyap.settings";
const DEFAULTS: Settings = { lang: "ko", sensitivity: 1, music: 1, sfx: 1 };

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** Pure: whatever was stored → a valid Settings. Unit-tested. */
export function parseSettings(raw: string | null): Settings {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    /* corrupt record: defaults */
  }
  return {
    lang: data.lang === "en" ? "en" : "ko",
    sensitivity: clamp(data.sensitivity, SENSITIVITY_RANGE.min, SENSITIVITY_RANGE.max, DEFAULTS.sensitivity),
    music: clamp(data.music, 0, 1, DEFAULTS.music),
    sfx: clamp(data.sfx, 0, 1, DEFAULTS.sfx),
  };
}

function load(): Settings {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    /* storage blocked: defaults for this visit */
  }
  const s = parseSettings(raw);
  const forced = typeof location !== "undefined" ? new URLSearchParams(location.search).get("lang") : null;
  if (forced === "en" || forced === "ko") s.lang = forced;
  return s;
}

/** Live settings. Read freely; change only through `updateSettings`. */
export const settings: Settings = load();

const listeners = new Set<(s: Settings) => void>();

export function updateSettings(patch: Partial<Settings>): void {
  const next = parseSettings(JSON.stringify({ ...settings, ...patch }));
  Object.assign(settings, next);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* kept for this visit only */
  }
  for (const fn of listeners) fn(settings);
}

/** Subscribe to changes; returns the unsubscribe. */
export function onSettings(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
