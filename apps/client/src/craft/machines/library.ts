import {
  MAX_PARTS,
  PART_ORDER,
  validateBlueprint,
  type Blueprint,
  type MachinePart,
} from "./blueprint.js";

/**
 * Every localStorage touch for machine mode lives here, and every value that
 * comes back out is re-validated before it reaches the editor or the engine —
 * a hand-edited storage entry or a pasted share code is hostile input.
 *
 * Storage is best effort: a browser in private mode or with storage denied
 * keeps playing, it just stops remembering.
 */
const LIBRARY_KEY = "craftyap-machine-library-v1";
const SAFE_LIBRARY_KEY = "craftyap-machine-library-v2";
const MISSION_KEY = "craftyap-machine-missions-v1";
export const LIBRARY_SLOTS = 12;
const SHARE_PREFIX = "CYM1.";
const BASE = 36;

export interface LibraryEntry {
  id: string;
  blueprint: Blueprint;
  updated: number;
}
export interface MissionRecord {
  cleared: string[];
  topSpeed: number;
  peakAltitude: number;
  distance: number;
  runs: number;
}
const EMPTY_RECORD: MissionRecord = {
  cleared: [],
  topSpeed: 0,
  peakAltitude: 0,
  distance: 0,
  runs: 0,
};

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw && raw.length < (key === SAFE_LIBRARY_KEY ? 1_600_000 : 400_000) ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

interface LibrarySnapshot {
  entries: LibraryEntry[];
  recovery: LibraryEntry[];
}

function validEntries(raw: unknown): LibraryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: LibraryEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, LIBRARY_SLOTS)) {
    if (!item || typeof item !== "object") continue;
    const { id, blueprint, updated } = item as LibraryEntry;
    const valid = validateBlueprint(blueprint);
    if (!valid || typeof id !== "string" || !id || id.length > 48 || seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, blueprint: valid, updated: Number.isFinite(updated) ? updated : 0 });
  }
  return entries;
}

function librarySnapshot(): LibrarySnapshot {
  const raw = read(SAFE_LIBRARY_KEY) as Partial<LibrarySnapshot> | null;
  if (raw && Array.isArray(raw.entries) && Array.isArray(raw.recovery))
    return { entries: validEntries(raw.entries), recovery: validEntries(raw.recovery) };
  // Keep the original saves intact; migrate only after a successful write.
  return { entries: validEntries(read(LIBRARY_KEY)), recovery: [] };
}

function entryId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `machine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class MachineStore {
  /** True when the last write was rejected, so the UI can say so once. */
  failed = false;
  failure: "full" | "storage" | null = null;

  entries(): LibraryEntry[] {
    return librarySnapshot().entries;
  }

  recovery(): LibraryEntry[] {
    return librarySnapshot().recovery;
  }

  /** A save always gets its own identity, even when its name is unchanged. */
  create(blueprint: Blueprint, now: number): LibraryEntry[] {
    const entries = this.entries();
    const copy = structuredClone(blueprint);
    const base = copy.name || "My machine";
    let name = base, version = 2;
    while (entries.some(entry => entry.blueprint.name === name)) {
      const suffix = ` (${version++})`;
      name = `${base.slice(0, 48 - suffix.length)}${suffix}`;
    }
    copy.name = name;
    return this.put(entryId(), copy, now);
  }

  /** Replacement is explicit; the previous version remains recoverable. */
  put(id: string, blueprint: Blueprint, now: number): LibraryEntry[] {
    const current = librarySnapshot();
    const previous = current.entries.find(entry => entry.id === id);
    if (!previous && current.entries.length >= LIBRARY_SLOTS) return this.full(current);
    const entries = current.entries.filter(entry => entry.id !== id);
    entries.unshift({ id, blueprint: structuredClone(blueprint), updated: now });
    const recovery = previous
      ? [{ ...previous, id: entryId() }, ...current.recovery].slice(0, LIBRARY_SLOTS)
      : current.recovery;
    return this.persist({ entries, recovery }) ? entries : current.entries;
  }

  remove(id: string): LibraryEntry[] {
    const current = librarySnapshot();
    const entry = current.entries.find(entry => entry.id === id);
    if (!entry) return current.entries;
    const entries = current.entries.filter(entry => entry.id !== id);
    const recovery = [entry, ...current.recovery.filter(item => item.id !== id)].slice(0, LIBRARY_SLOTS);
    // Removal and recovery are one atomic storage write.
    return this.persist({ entries, recovery }) ? entries : current.entries;
  }

  restore(id: string): LibraryEntry[] {
    const current = librarySnapshot();
    const entry = current.recovery.find(entry => entry.id === id);
    if (!entry) return current.entries;
    if (current.entries.length >= LIBRARY_SLOTS) return this.full(current);
    const restored = { ...entry, id: current.entries.some(item => item.id === id) ? entryId() : id };
    const entries = [restored, ...current.entries];
    const recovery = current.recovery.filter(entry => entry.id !== id);
    return this.persist({ entries, recovery }) ? entries : current.entries;
  }

  private full(current: LibrarySnapshot): LibraryEntry[] {
    this.failed = true;
    this.failure = "full";
    return current.entries;
  }

  private persist(snapshot: LibrarySnapshot): boolean {
    this.failed = !write(SAFE_LIBRARY_KEY, snapshot);
    this.failure = this.failed ? "storage" : null;
    return !this.failed;
  }

  record(): MissionRecord {
    const raw = read(MISSION_KEY);
    if (!raw || typeof raw !== "object") return { ...EMPTY_RECORD };
    const r = raw as MissionRecord;
    const number = (value: unknown) =>
      Number.isFinite(value) ? Math.max(0, value as number) : 0;
    return {
      cleared: Array.isArray(r.cleared)
        ? r.cleared.filter((id): id is string => typeof id === "string").slice(0, 64)
        : [],
      topSpeed: number(r.topSpeed),
      peakAltitude: number(r.peakAltitude),
      distance: number(r.distance),
      runs: number(r.runs),
    };
  }

  mergeRecord(update: Partial<MissionRecord>): MissionRecord {
    const current = this.record();
    const merged: MissionRecord = {
      cleared: [...new Set([...current.cleared, ...(update.cleared ?? [])])],
      topSpeed: Math.max(current.topSpeed, update.topSpeed ?? 0),
      peakAltitude: Math.max(current.peakAltitude, update.peakAltitude ?? 0),
      distance: Math.max(current.distance, update.distance ?? 0),
      runs: current.runs + (update.runs ?? 0),
    };
    this.failed = !write(MISSION_KEY, merged);
    return merged;
  }
}

/**
 * Share code: one character each for kind, x, y, z and direction, so a 128-part
 * machine fits in a line you can paste into a chat window.
 */
export function encodeShare(blueprint: Blueprint): string {
  if(blueprint.parts.some(p=>p.custom&&Object.keys(p.custom).length))return `CYM2.${encodeURIComponent(JSON.stringify(blueprint))}`;
  const body = blueprint.parts
    .map((p) =>
      [
        PART_ORDER.indexOf(p.kind),
        p.cell[0] + 12,
        p.cell[1] + 12,
        p.cell[2] + 12,
        p.direction,
      ]
        .map((n) => n.toString(BASE))
        .join(""),
    )
    .join("");
  return `${SHARE_PREFIX}${body}.${encodeURIComponent(blueprint.name)}`;
}

export function decodeShare(text: string): Blueprint | null {
  const code = text.trim();
  if(code.startsWith("CYM2.")){
    if(code.length>40_000)return null;
    try{return validateBlueprint(JSON.parse(decodeURIComponent(code.slice(5))));}catch{return null;}
  }
  if (!code.startsWith(SHARE_PREFIX) || code.length > 40_000) return null;
  const split = code.indexOf(".", SHARE_PREFIX.length);
  if (split < 0) return null;
  const body = code.slice(SHARE_PREFIX.length, split);
  if (body.length % 5 !== 0 || body.length / 5 > MAX_PARTS) return null;
  const parts: MachinePart[] = [];
  for (let i = 0; i < body.length; i += 5) {
    const digits = [...body.slice(i, i + 5)].map((c) => parseInt(c, BASE));
    if (digits.some((n) => !Number.isInteger(n))) return null;
    const kind = PART_ORDER[digits[0]!];
    if (!kind) return null;
    parts.push({
      kind,
      cell: [digits[1]! - 12, digits[2]! - 12, digits[3]! - 12],
      direction: digits[4]!,
    });
  }
  let name = "불러온 기계";
  try {
    name = decodeURIComponent(code.slice(split + 1)).slice(0, 48) || name;
  } catch {
    /* keep the fallback name */
  }
  return validateBlueprint({ version: 1, name, parts });
}
