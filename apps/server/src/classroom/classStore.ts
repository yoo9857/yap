import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { ClassEdit, ClassSettings, ClassFurniture } from "@robo/shared";
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
}

export interface ClassStore {
  load(key: string): SavedClass | null;
  /** Whose class this is, without reading its whole field (the lobby's confirm card asks this). */
  meta(key: string): { teacherName: string; roomName?: string } | null;
  save(key: string, data: SavedClass): void;
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
    settings: { chatLocked: settings.chatLocked === true, buildLocked: settings.buildLocked === true, ...(settings.tapsLocked === undefined ? {} : { tapsLocked: settings.tapsLocked === true }) },
    furniture: Array.isArray(d.furniture) ? (d.furniture as ClassFurniture[]) : undefined,
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
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS classes (
        class_key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const purged = this.db.prepare(`DELETE FROM classes WHERE updated_at < ?`).run(Date.now() - RETENTION_MS);
    if (purged.changes > 0) log.info({ purged: purged.changes }, "old classes purged");
  }

  // prepared once: these run on every peek, host and 15 s save
  private readonly selectData = () => (this.selectDataStmt ??= this.db.prepare(`SELECT data FROM classes WHERE class_key = ?`));
  private readonly selectMeta = () => (this.selectMetaStmt ??= this.db.prepare(
    `SELECT json_extract(data, '$.teacherName') AS teacherName, json_extract(data, '$.roomName') AS roomName FROM classes WHERE class_key = ?`));
  private readonly upsert = () => (this.upsertStmt ??= this.db.prepare(
    `INSERT INTO classes (class_key, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (class_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`));
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
    this.upsert().run(key, JSON.stringify(data), Date.now());
  }

  close(): void {
    this.db.close();
  }
}

/** In-memory fallback (and the unit tests' store). */
export class MemoryClassStore implements ClassStore {
  private readonly classes = new Map<string, string>();
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
  }
  close(): void {
    this.classes.clear();
  }
}

export function createClassStore(dbPath: string): ClassStore {
  try {
    const Database = nativeRequire("better-sqlite3") as typeof import("better-sqlite3");
    const store = new SqliteClassStore(dbPath, Database);
    log.info({ dbPath }, "class store: sqlite");
    return store;
  } catch (err) {
    log.error({ err }, "better-sqlite3 unavailable — classes are kept in memory only");
    return new MemoryClassStore();
  }
}
