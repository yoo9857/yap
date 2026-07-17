import { describe, expect, it } from "vitest";
import { MemoryRecordStore } from "../src/game/records.js";

describe("record store (memory implementation, same contract as sqlite)", () => {
  it("keeps only the best time per player per day", () => {
    const store = new MemoryRecordStore();
    store.submitBest("2026-07-17", "영희", 30_000);
    const worse = store.submitBest("2026-07-17", "영희", 35_000);
    expect(worse.improved).toBe(false);
    const better = store.submitBest("2026-07-17", "영희", 25_000);
    expect(better.improved).toBe(true);

    const board = store.board("2026-07-17");
    expect(board).toHaveLength(1);
    expect(board[0]).toEqual({ name: "영희", timeMs: 25_000, rank: 1 });
  });

  it("ranks players by time within a day and isolates days", () => {
    const store = new MemoryRecordStore();
    store.submitBest("2026-07-17", "A", 20_000);
    store.submitBest("2026-07-17", "B", 18_000);
    store.submitBest("2026-07-18", "C", 1_000);

    const board = store.board("2026-07-17");
    expect(board.map((e) => e.name)).toEqual(["B", "A"]);
    expect(store.rankOf("2026-07-17", "A")).toBe(2);
    expect(store.board("2026-07-18")).toHaveLength(1);
    expect(store.rankOf("2026-07-18", "A")).toBeNull();
  });
});
