import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DailyBoardEntry } from "@robo/shared";
import { log } from "../log.js";

const nativeRequire = createRequire(import.meta.url);

export interface RecordStore {
  /** Keeps the best time per (date, name). Returns the player's rank. */
  submitBest(dateStr: string, name: string, timeMs: number): { rank: number; improved: boolean };
  board(dateStr: string, limit?: number): DailyBoardEntry[];
  rankOf(dateStr: string, name: string): number | null;
  close(): void;
}

const BOARD_LIMIT = 50;

/** SQLite-backed store — records survive server restarts and redeploys. */
class SqliteRecordStore implements RecordStore {
  private readonly db: import("better-sqlite3").Database;

  constructor(dbPath: string, Database: typeof import("better-sqlite3")) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_records (
        date TEXT NOT NULL,
        name TEXT NOT NULL,
        time_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (date, name)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_records_date_time
        ON daily_records (date, time_ms);
    `);
  }

  submitBest(dateStr: string, name: string, timeMs: number): { rank: number; improved: boolean } {
    const t = Math.round(timeMs);
    const result = this.db
      .prepare(
        `INSERT INTO daily_records (date, name, time_ms, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (date, name) DO UPDATE SET
           time_ms = excluded.time_ms, created_at = excluded.created_at
         WHERE excluded.time_ms < daily_records.time_ms`,
      )
      .run(dateStr, name, t, Date.now());
    const rank = this.rankOf(dateStr, name) ?? 1;
    return { rank, improved: result.changes > 0 };
  }

  board(dateStr: string, limit = BOARD_LIMIT): DailyBoardEntry[] {
    const rows = this.db
      .prepare(
        `SELECT name, time_ms FROM daily_records
         WHERE date = ? ORDER BY time_ms ASC, created_at ASC LIMIT ?`,
      )
      .all(dateStr, limit) as { name: string; time_ms: number }[];
    return rows.map((r, i) => ({ name: r.name, timeMs: r.time_ms, rank: i + 1 }));
  }

  rankOf(dateStr: string, name: string): number | null {
    const mine = this.db
      .prepare(`SELECT time_ms FROM daily_records WHERE date = ? AND name = ?`)
      .get(dateStr, name) as { time_ms: number } | undefined;
    if (!mine) return null;
    const better = this.db
      .prepare(`SELECT COUNT(*) AS n FROM daily_records WHERE date = ? AND time_ms < ?`)
      .get(dateStr, mine.time_ms) as { n: number };
    return better.n + 1;
  }

  close(): void {
    this.db.close();
  }
}

/** In-memory fallback so a broken native module degrades, not crashes. */
class MemoryRecordStore implements RecordStore {
  private readonly days = new Map<string, Map<string, number>>();

  submitBest(dateStr: string, name: string, timeMs: number): { rank: number; improved: boolean } {
    let day = this.days.get(dateStr);
    if (!day) {
      day = new Map();
      this.days.set(dateStr, day);
    }
    const prev = day.get(name);
    const improved = prev === undefined || timeMs < prev;
    if (improved) day.set(name, Math.round(timeMs));
    return { rank: this.rankOf(dateStr, name) ?? 1, improved };
  }

  board(dateStr: string, limit = BOARD_LIMIT): DailyBoardEntry[] {
    const day = this.days.get(dateStr);
    if (!day) return [];
    return [...day.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([name, timeMs], i) => ({ name, timeMs, rank: i + 1 }));
  }

  rankOf(dateStr: string, name: string): number | null {
    const day = this.days.get(dateStr);
    const mine = day?.get(name);
    if (day === undefined || mine === undefined) return null;
    let better = 0;
    for (const t of day.values()) if (t < mine) better++;
    return better + 1;
  }

  close(): void {
    this.days.clear();
  }
}

export function createRecordStore(dbPath: string): RecordStore {
  try {
    // dynamic require keeps a broken native binary from killing boot
    const Database = nativeRequire("better-sqlite3") as typeof import("better-sqlite3");
    const store = new SqliteRecordStore(dbPath, Database);
    log.info({ dbPath }, "record store: sqlite");
    return store;
  } catch (err) {
    log.error({ err }, "better-sqlite3 unavailable — falling back to in-memory records");
    return new MemoryRecordStore();
  }
}

export { MemoryRecordStore };
