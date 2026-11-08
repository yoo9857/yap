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
  /** Vertical field of view (degrees) of the voxel modes' camera; running adds 5.5. */
  fov: number;
  /** Mouse/drag up looks down. */
  invertY: boolean;
  /** HUD, hotbar, bag and corner chips scale (1 = as designed). */
  uiScale: number;
  /** View distance preset: 0 short, 1 normal, 2 far (craft's O key cycles it). */
  view: number;
  /** Hide the always-on control hints (key strip, shape hint); H and the pause card keep them. */
  hideHints: boolean;
  /** Graphics preset (render/display.ts qualityProfile); auto adapts the resolution to the frame rate. */
  graphics: "auto" | "low" | "medium" | "high";
}

export const SENSITIVITY_RANGE = { min: 0.3, max: 2.5 } as const;
export const FOV_RANGE = { min: 60, max: 100 } as const;
export const UI_SCALE_RANGE = { min: 0.8, max: 1.3 } as const;
const KEY = "craftyap.settings";
/** Before the view distance lived here, craft kept it under its own key: read once as a default. */
const LEGACY_VIEW_KEY = "craftyap-view-distance";
const DEFAULTS: Settings = { lang: "ko", sensitivity: 1, music: 1, sfx: 1, fov: 70, invertY: false, uiScale: 1, view: 1, hideHints: false, graphics: "auto" };

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
    fov: Math.round(clamp(data.fov, FOV_RANGE.min, FOV_RANGE.max, DEFAULTS.fov)),
    invertY: data.invertY === true,
    uiScale: Math.round(clamp(data.uiScale, UI_SCALE_RANGE.min, UI_SCALE_RANGE.max, DEFAULTS.uiScale) * 20) / 20,
    view: Math.round(clamp(data.view, 0, 2, DEFAULTS.view)),
    // the old "hints" key (an opt-IN after a 3-minute onboarding) is ignored: hints show by default
    hideHints: data.hideHints === true,
    graphics: data.graphics === "low" || data.graphics === "medium" || data.graphics === "high" ? data.graphics : "auto",
  };
}

/** The stored language: a `?lang=` page view must not become it. */
let storedLang: Lang = "ko";
/** The saved choice (what a page without `?lang=` opens in). */
export const savedLanguage = (): Lang => storedLang;

function load(): Settings {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    /* storage blocked: defaults for this visit */
  }
  const s = parseSettings(raw);
  // the view distance used to be craft's own key: carry it over once
  try {
    const stored: unknown = raw ? JSON.parse(raw) : {};
    const legacy = localStorage.getItem(LEGACY_VIEW_KEY);
    if (legacy !== null && !(stored && typeof stored === "object" && "view" in stored)) s.view = parseSettings(JSON.stringify({ view: Number(legacy) })).view;
  } catch {
    /* defaults */
  }
  storedLang = s.lang;
  const forced = typeof location !== "undefined" ? new URLSearchParams(location.search).get("lang") : null;
  if (forced === "en" || forced === "ko") s.lang = forced;
  return s;
}

/** Live settings. Read freely; change only through `updateSettings`. */
export const settings: Settings = load();

/** The settings that live on the page itself (CSS): UI scale and the hint override. */
function applyToDocument(s: Settings): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--ui-scale", String(s.uiScale));
  document.body?.classList.toggle("hud-hints-hidden", s.hideHints);
}
if (typeof document !== "undefined") {
  if (document.body) applyToDocument(settings);
  else document.addEventListener("DOMContentLoaded", () => applyToDocument(settings), { once: true });
}

const listeners = new Set<(s: Settings) => void>();

export function updateSettings(patch: Partial<Settings>): void {
  const next = parseSettings(JSON.stringify({ ...settings, ...patch }));
  Object.assign(settings, next);
  // only an explicit language choice is saved; otherwise the stored one stays (not the ?lang= view's)
  if (patch.lang !== undefined) storedLang = next.lang;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...settings, lang: storedLang }));
  } catch {
    /* kept for this visit only */
  }
  applyToDocument(settings);
  for (const fn of listeners) fn(settings);
}

/** Subscribe to changes; returns the unsubscribe. */
export function onSettings(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
