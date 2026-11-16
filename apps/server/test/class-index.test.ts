import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClassIndex, createClassStore, type SavedClass } from "../src/classroom/classStore.js";

/**
 * 수업 관리's class list on the real SQLite file: the owner and a few words are kept beside each
 * row (added columns), a file from before those columns is brought along once, and the API's
 * process reads it read-only beside the games' own connection.
 */
const require = createRequire(import.meta.url);
let Database: typeof import("better-sqlite3") | null = null;
try { Database = require("better-sqlite3") as typeof import("better-sqlite3"); new Database(":memory:").close(); } catch { Database = null; }

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const file = () => { const d = mkdtempSync(join(tmpdir(), "cy-classes-")); dirs.push(d); return join(d, "records.db"); };
const saved = (over: Partial<SavedClass>): SavedClass => ({ teacherName: "김선생", passHash: "h", salt: "s", teacherKey: "k", students: [], settings: { chatLocked: false, buildLocked: false }, edits: [], ...over });

describe.skipIf(!Database)("an account's class list (SQLite)", () => {
  it("lists what an account owns, newest first, read by a second read-only connection", () => {
    const path = file(), store = createClassStore(path, true), index = createClassIndex(path);
    store.save("햇살반", saved({ roomName: "햇살반", owner: 7, theme: "fire", students: [{ name: "민지", key: "a" }, { name: "준호", key: "b" }] }));
    store.save("달빛반", saved({ roomName: "달빛반", owner: 7 }));
    store.save("남의반", saved({ roomName: "남의 반", owner: 8 }));
    store.save("옛반", saved({}));
    for (const list of [store.owned(7), index.owned(7)]) {
      expect(list.map((c) => c.name).sort()).toEqual(["달빛반", "햇살반"]);
      expect(list.find((c) => c.name === "햇살반")).toMatchObject({ teacher: "김선생", theme: "fire", students: 2 });
      expect(list[0]!.updatedAt).toBeGreaterThanOrEqual(list[1]!.updatedAt);
    }
    expect(index.owned(9)).toEqual([]);
    // a class that gets an owner later (claimed at its next opening) joins the list
    store.save("옛반", saved({ owner: 9 }));
    expect(index.owned(9).map((c) => c.name)).toEqual(["김선생"]); // no class name of its own: the teacher's name is its name
    index.close(); store.close();
  });

  it("brings a file from before the columns along: owned rows are found, their words read from the save", () => {
    const path = file(), old = new Database!(path);
    old.exec(`CREATE TABLE classes (class_key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    const put = old.prepare(`INSERT INTO classes VALUES (?, ?, ?)`);
    put.run("햇살반", JSON.stringify(saved({ roomName: "햇살반", owner: 7, students: [{ name: "민지", key: "a" }] })), Date.now());
    put.run("옛반", JSON.stringify(saved({})), Date.now());
    old.close();
    const store = createClassStore(path, true);
    expect(store.owned(7)).toMatchObject([{ name: "햇살반", teacher: "김선생", theme: "craft", students: 1 }]);
    expect(store.load("옛반")?.teacherName).toBe("김선생");
    store.close();
    // …and the previous server's statements still work on the changed table (rollback)
    const back = new Database!(path);
    back.prepare(`INSERT INTO classes (class_key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (class_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run("햇살반", JSON.stringify(saved({ roomName: "햇살반", owner: 7 })), Date.now());
    back.close();
    const again = createClassStore(path, true);
    expect(again.owned(7).map((c) => c.name)).toEqual(["햇살반"]);
    again.close();
  });

  it("answers an empty list when the file is not there yet", () => {
    const index = createClassIndex(join(file(), "..", "nothing.db"));
    expect(index.owned(7)).toEqual([]);
    index.close();
  });
});
