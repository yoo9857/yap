import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { ClassEdit, ClassSettings } from "@robo/shared";
import { log } from "../log.js";

const nativeRequire = createRequire(import.meta.url);

/** Everything a class keeps between lessons and server restarts. */
export interface SavedClass {
  teacherName: string;
  /** scrypt(password, salt) — the password itself is never stored. */
  passHash: string;
  salt: string;
  teacherKey: string;
  students: { name: string; key: string }[];
  settings: ClassSettings;
  edits: ClassEdit[];
}

export interface ClassStore {
  load(key: string): SavedClass | null;
  save(key: string, data: SavedClass): void;
  close(): void;
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

  load(key: string): SavedClass | null {
    const row = this.db.prepare(`SELECT data FROM classes WHERE class_key = ?`).get(key) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as SavedClass;
    } catch (err) {
      log.error({ key, err }, "unreadable saved class");
      return null;
    }
  }

  save(key: string, data: SavedClass): void {
    this.db
      .prepare(
        `INSERT INTO classes (class_key, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (class_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(data), Date.now());
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
    return raw ? (JSON.parse(raw) as SavedClass) : null;
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
