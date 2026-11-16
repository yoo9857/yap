import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { CLASS_MAX_PLANTS, loadPlants, type ClassEdit, type ClassSettings, type ClassFurniture, type ClassTheme, type PlantSite } from "@robo/shared";
import { log } from "../log.js";

const nativeRequire = createRequire(import.meta.url);

/** Everything a class keeps between lessons and server restarts. */
export interface SavedClass {
  /** The class's name. Classes saved before named classes have none: their
   *  key was the teacher's name, so the teacher's name IS their class name. */
  roomName?: string;
  teacherName: string;
  /** scrypt(password, salt) — the password itself is never stored. */
  passHash: string;
  salt: string;
  teacherKey: string;
  students: { name: string; key: string }[];
  settings: ClassSettings;
  edits: ClassEdit[];
  furniture?: ClassFurniture[];
  /** The teacher's plots (F2 → 자리 배치), so a deploy or restart mid-lesson keeps them — late
   *  students still get theirs and the class stays on its plots. Optional: older rows have none,
   *  and an older server (rollback) simply ignores it. */
  seating?: SavedSeating;
  /** The lesson's state (F2): students frozen, and a running timer's end (epoch ms) and length.
   *  Optional like `seating`: a deploy mid-countdown keeps it; older rows and servers do without. */
  lesson?: SavedLesson;
  /** The class's power plants (science mode): [kind, x, y, z, rot, filled, on, owner's name].
   *  Optional like `seating`: older rows have none and an older server ignores it. */
  plants?: SavedPlant[];
  /** The learning theme the class was made with (absent: the sandbox). A themed class stores no
   *  field: it is rebuilt from code. An older server (rollback) ignores this and opens an empty field. */
  theme?: ClassTheme;
  /** The teacher's ACCOUNT this class belongs to (docs/ACCOUNTS.md). Optional: classes made before
   *  accounts, or without signing in, have none; an older server (rollback) ignores it. */
  owner?: number;
  /** The fire drill as the teacher left it (teams, which are set off, the run counter), so a deploy
   *  mid-lesson does not send a running class back to the briefing. Optional; progress is not kept. */
  drill?: SavedDrill;
}

export interface SavedDrill {
  size: number;
  teams: [string, number][];
  go: number[];
  run: number;
}

/** A saved drill, checked field by field; anything malformed means none. */
function readDrill(raw: unknown): SavedDrill | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(d.size, 0, 8) || !int(d.run, 0, 1_000_000_000) || !Array.isArray(d.teams) || !Array.isArray(d.go)) return undefined;
  const teams = d.teams.filter((t): t is [string, number] => Array.isArray(t) && t.length === 2 && typeof t[0] === "string" && t[0].length <= 64 && int(t[1], 1, 100)).slice(0, 400);
  return { size: d.size, run: d.run, teams, go: d.go.filter((g): g is number => int(g, 0, 100)).slice(0, 101) };
}

export type SavedPlant = [string, number, number, number, number, number, number, string];

/** Saved plants, row by row through the shared rules (loadPlants): a bad row is dropped, never the rest. */
export function readSavedPlants(raw: unknown): (PlantSite & { owner: string })[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: (PlantSite & { owner: string })[] = [];
  for (const row of raw.slice(0, CLASS_MAX_PLANTS)) {
    if (!Array.isArray(row) || row.length !== 8 || typeof row[7] !== "string" || row[7].length > 64) continue;
    const site = loadPlants([row.slice(0, 7)])[0];
    if (site) out.push({ ...site, owner: row[7] });
  }
  return out;
}

export interface SavedLesson {
  frozen: boolean;
  timerEnd?: number;
  timerTotal?: number;
}

/** A saved lesson state, checked field by field; malformed means none. */
function readLesson(raw: unknown): SavedLesson | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Record<string, unknown>;
  const timer = typeof d.timerEnd === "number" && Number.isFinite(d.timerEnd) && typeof d.timerTotal === "number" &&
    Number.isInteger(d.timerTotal) && d.timerTotal > 0 && d.timerTotal <= 3_600_000;
  const lesson: SavedLesson = { frozen: d.frozen === true, ...(timer ? { timerEnd: d.timerEnd as number, timerTotal: d.timerTotal as number } : {}) };
  return lesson.frozen || lesson.timerEnd !== undefined ? lesson : undefined;
}

export interface SavedSeating {
  seats: { name: string; pos: [number, number, number]; yaw: number }[];
  origin: { pos: [number, number, number]; yaw: number };
  roam: boolean;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const vec3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(finite);

/** A saved seating, checked field by field; anything malformed means "no seating" (never a throw). */
function readSeating(raw: unknown): SavedSeating | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Record<string, unknown>;
  const origin = d.origin as Record<string, unknown> | undefined;
  if (!Array.isArray(d.seats) || !origin || !vec3(origin.pos) || !finite(origin.yaw)) return undefined;
  const seats = d.seats
    .filter((s): s is { name: string; pos: [number, number, number]; yaw: number } => {
      const r = s as Record<string, unknown> | null;
      return !!r && typeof r.name === "string" && r.name.length <= 64 && vec3(r.pos) && finite(r.yaw);
    })
    .slice(0, 400)
    .map((s) => ({ name: s.name, pos: [s.pos[0], s.pos[1], s.pos[2]] as [number, number, number], yaw: s.yaw }));
  if (seats.length === 0) return undefined;
  return { seats, origin: { pos: [origin.pos[0], origin.pos[1], origin.pos[2]], yaw: origin.yaw }, roam: d.roam === true };
}

/** One line of a teacher's class list (/teacher/ → 수업 관리): what the row says, never the field. */
export interface OwnedClass {
  name: string;
  teacher: string;
  theme: ClassTheme;
  students: number;
  updatedAt: number;
}

/** The small part of a save the class list shows — written beside the row so listing never parses a field. */
const summaryOf = (key: string, d: SavedClass) => JSON.stringify({ name: d.roomName ?? d.teacherName ?? key, teacher: d.teacherName, theme: d.theme ?? "craft", students: d.students.length });

function readOwned(summary: unknown, updatedAt: unknown): OwnedClass | null {
  try {
    const d = JSON.parse(String(summary)) as Record<string, unknown>;
    if (typeof d.name !== "string" || typeof d.teacher !== "string") return null;
    return { name: d.name, teacher: d.teacher, theme: d.theme === "fire" ? "fire" : "craft", students: typeof d.students === "number" ? d.students : 0, updatedAt: typeof updatedAt === "number" ? updatedAt : 0 };
  } catch {
    return null;
  }
}

/** At most this many classes are listed for one account (newest first). */
const OWNED_MAX = 60;

export interface ClassStore {
  /** The classes an account owns, newest first (docs/ACCOUNTS.md). */
  owned(owner: number): OwnedClass[];
  load(key: string): SavedClass | null;
  /** Whose class this is, without reading its whole field (the lobby's confirm card asks this). */
  meta(key: string): { teacherName: string; roomName?: string } | null;
  save(key: string, data: SavedClass): void;
  /** The class is gone for good (its owner deleted it: classAdmin.ts). */
  remove(key: string): void;
  close(): void;
}

/**
 * A stored row, checked before it becomes a ClassRoom: a damaged or hand-edited
 * row is refused here (logged, treated as missing) instead of throwing inside
 * the constructor and taking the whole server down. Unknown extra fields pass.
 */
export function readSaved(raw: unknown): SavedClass | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string";
  if (!str(d.teacherName) || !str(d.passHash) || !str(d.salt) || !str(d.teacherKey)) return null;
  if (d.roomName !== undefined && !str(d.roomName)) return null;
  if (!Array.isArray(d.edits) || !Array.isArray(d.students)) return null;
  if (!d.settings || typeof d.settings !== "object") return null;
  const edits = d.edits.filter((e): e is ClassEdit => Array.isArray(e) && e.length === 5 && e.every((n) => Number.isInteger(n)));
  const students = d.students.filter((s): s is { name: string; key: string } =>
    !!s && typeof s === "object" && str((s as { name?: unknown }).name) && str((s as { key?: unknown }).key));
  const settings = d.settings as Record<string, unknown>;
  return {
    ...(d as unknown as SavedClass),
    edits,
    students,
    settings: { chatLocked: settings.chatLocked === true, buildLocked: settings.buildLocked === true, ...(settings.tapsLocked === undefined ? {} : { tapsLocked: settings.tapsLocked === true }),
      ...(settings.plantsLocked === true ? { plantsLocked: true } : {}), ...(settings.petsOff === true ? { petsOff: true } : {}) },
    furniture: Array.isArray(d.furniture) ? (d.furniture as ClassFurniture[]) : undefined,
    seating: readSeating(d.seating),
    lesson: readLesson(d.lesson),
    plants: Array.isArray(d.plants) ? (d.plants as SavedPlant[]) : undefined,
    theme: d.theme === "fire" ? "fire" : undefined,
    drill: readDrill(d.drill),
    owner: typeof d.owner === "number" && Number.isInteger(d.owner) && d.owner > 0 ? d.owner : undefined,
  };
}

function parseSaved(key: string, data: string): SavedClass | null {
  try {
    const saved = readSaved(JSON.parse(data));
    if (!saved) log.error({ key }, "saved class has a bad shape — ignored");
    return saved;
  } catch (err) {
    log.error({ key, err }, "unreadable saved class");
    return null;
  }
}

/** Classes untouched this long are deleted at boot. */
const RETENTION_MS = 180 * 24 * 60 * 60_000;

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): { hash: string; salt: string } {
  return { hash: scryptSync(password, salt, 32).toString("hex"), salt };
}

export function checkPassword(password: string, saved: { passHash: string; salt: string }): boolean {
  const { hash } = hashPassword(password, saved.salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(saved.passHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Host/seat keys compared in constant time (a plain === leaks how many leading characters matched). */
export function sameKey(given: string, stored: string): boolean {
  const a = Buffer.from(given), b = Buffer.from(stored);
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}

class SqliteClassStore implements ClassStore {
  private readonly db: import("better-sqlite3").Database;

  constructor(dbPath: string, Database: typeof import("better-sqlite3")) {
    mkdirSync(dirname(dbPath), { recursive: true });
    // several cluster shards share this file: wait for another writer instead of failing at once
    this.db = new Database(dbPath, { timeout: 10_000 });
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS classes (
        class_key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // The class list of an account (owned()): the owner and a few words about the class beside the
    // row, so the list is an index lookup and never parses a several-MB field. ADDED columns only:
    // the previous server (rollback, the other deploy colour) names its columns and ignores these.
    // Several shards boot together: the one that loses the race finds the column already there.
    const has = new Set((this.db.pragma("table_info(classes)") as { name: string }[]).map((c) => c.name));
    try {
      if (!has.has("owner")) {
        this.db.exec(`ALTER TABLE classes ADD COLUMN owner INTEGER`);
        // classes claimed before this column existed (done once, by whoever adds the column)
        this.db.exec(`UPDATE classes SET owner = json_extract(data, '$.owner') WHERE data LIKE '%"owner":%'`);
      }
      if (!has.has("summary")) this.db.exec(`ALTER TABLE classes ADD COLUMN summary TEXT`);
    } catch (err) {
      if (!/duplicate column/i.test(String((err as Error).message))) throw err;
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS classes_owner ON classes (owner) WHERE owner IS NOT NULL`);
    const purged = this.db.prepare(`DELETE FROM classes WHERE updated_at < ?`).run(Date.now() - RETENTION_MS);
    if (purged.changes > 0) log.info({ purged: purged.changes }, "old classes purged");
  }

  // prepared once: these run on every peek, host and 15 s save
  private readonly selectData = () => (this.selectDataStmt ??= this.db.prepare(`SELECT data FROM classes WHERE class_key = ?`));
  private readonly selectMeta = () => (this.selectMetaStmt ??= this.db.prepare(
    `SELECT json_extract(data, '$.teacherName') AS teacherName, json_extract(data, '$.roomName') AS roomName FROM classes WHERE class_key = ?`));
  private readonly upsert = () => (this.upsertStmt ??= this.db.prepare(
    `INSERT INTO classes (class_key, data, updated_at, owner, summary) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (class_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, owner = excluded.owner, summary = excluded.summary`));
  private selectDataStmt: import("better-sqlite3").Statement | null = null;
  private selectMetaStmt: import("better-sqlite3").Statement | null = null;
  private upsertStmt: import("better-sqlite3").Statement | null = null;

  load(key: string): SavedClass | null {
    const row = this.selectData().get(key) as { data: string } | undefined;
    return row ? parseSaved(key, row.data) : null;
  }

  meta(key: string): { teacherName: string; roomName?: string } | null {
    try {
      // json_extract reads the two names in SQLite, without parsing a several-MB field into JS
      const row = this.selectMeta().get(key) as { teacherName: unknown; roomName: unknown } | undefined;
      if (!row || typeof row.teacherName !== "string") return null;
      return { teacherName: row.teacherName, ...(typeof row.roomName === "string" ? { roomName: row.roomName } : {}) };
    } catch {
      const saved = this.load(key); // a SQLite built without JSON1
      return saved ? { teacherName: saved.teacherName, roomName: saved.roomName } : null;
    }
  }

  save(key: string, data: SavedClass): void {
    this.upsert().run(key, JSON.stringify(data), Date.now(), data.owner ?? null, summaryOf(key, data));
  }

  owned(owner: number): OwnedClass[] {
    return ownedRows(this.db, owner);
  }

  remove(key: string): void {
    this.db.prepare(`DELETE FROM classes WHERE class_key = ?`).run(key);
  }

  close(): void {
    this.db.close();
  }
}

/** A row saved by a server from before the summary column has none: its few words are read out of the save (rare, and only then). */
function ownedRows(db: import("better-sqlite3").Database, owner: number): OwnedClass[] {
  const rows = db.prepare(
    `SELECT updated_at AS updatedAt, summary,
            CASE WHEN summary IS NULL THEN json_object('name', coalesce(json_extract(data, '$.roomName'), json_extract(data, '$.teacherName')),
              'teacher', json_extract(data, '$.teacherName'), 'theme', coalesce(json_extract(data, '$.theme'), 'craft'),
              'students', json_array_length(data, '$.students')) END AS made
     FROM classes WHERE owner = ? ORDER BY updated_at DESC LIMIT ${OWNED_MAX}`).all(owner) as { updatedAt: number; summary: string | null; made: string | null }[];
  return rows.map((r) => readOwned(r.summary ?? r.made, r.updatedAt)).filter((c): c is OwnedClass => c !== null);
}

/**
 * The class list for the process that answers the site's API. In a cluster that is the primary,
 * which holds no classes: it reads the shards' file (read-only; WAL readers never block a writer).
 * Opened at the first question and again after any failure — the file or its columns may not be
 * there yet while the shards boot — and a failure is an empty list, never a failed page.
 */
export function createClassIndex(dbPath: string): { owned(owner: number): OwnedClass[]; close(): void } {
  let db: import("better-sqlite3").Database | null = null;
  const drop = () => { try { db?.close(); } catch { /* already closed */ } db = null; };
  return {
    owned(owner) {
      try {
        db ??= new (nativeRequire("better-sqlite3") as typeof import("better-sqlite3"))(dbPath, { readonly: true, fileMustExist: true, timeout: 2000 });
        return ownedRows(db, owner);
      } catch (err) {
        log.warn({ err: (err as Error).message }, "class list unavailable");
        drop();
        return [];
      }
    },
    close: drop,
  };
}

/** In-memory fallback (and the unit tests' store). */
export class MemoryClassStore implements ClassStore {
  private readonly classes = new Map<string, string>();
  private readonly saved = new Map<string, number>();
  owned(owner: number): OwnedClass[] {
    const out: OwnedClass[] = [];
    for (const [key, raw] of this.classes) {
      const d = parseSaved(key, raw);
      if (d?.owner === owner) { const c = readOwned(summaryOf(key, d), this.saved.get(key) ?? 0); if (c) out.push(c); }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, OWNED_MAX);
  }
  load(key: string): SavedClass | null {
    const raw = this.classes.get(key);
    return raw ? parseSaved(key, raw) : null;
  }
  meta(key: string): { teacherName: string; roomName?: string } | null {
    const saved = this.load(key);
    return saved ? { teacherName: saved.teacherName, roomName: saved.roomName } : null;
  }
  save(key: string, data: SavedClass): void {
    this.classes.set(key, JSON.stringify(data));
    this.saved.set(key, Date.now());
  }
  remove(key: string): void {
    this.classes.delete(key);
    this.saved.delete(key);
  }
  close(): void {
    this.classes.clear();
  }
}

/**
 * `strict` (cluster shards): only a missing/broken native module may fall back to memory. A
 * database that fails to OPEN (busy past the timeout while N shards boot together, permissions)
 * must crash the shard so it restarts — in memory it would hide every saved class and lose edits.
 */
export function createClassStore(dbPath: string, strict = false): ClassStore {
  let Database: typeof import("better-sqlite3");
  try {
    // dynamic require keeps a broken native binary from killing boot
    Database = nativeRequire("better-sqlite3") as typeof import("better-sqlite3");
  } catch (err) {
    log.error({ err }, "better-sqlite3 unavailable — classes are kept in memory only");
    return new MemoryClassStore();
  }
  try {
    const store = new SqliteClassStore(dbPath, Database);
    log.info({ dbPath }, "class store: sqlite");
    return store;
  } catch (err) {
    if (strict) throw err;
    log.error({ err }, "sqlite open failed — classes are kept in memory only");
    return new MemoryClassStore();
  }
}
