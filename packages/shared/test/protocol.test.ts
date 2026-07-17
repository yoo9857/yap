import { describe, expect, it } from "vitest";
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from "../src/index.js";

describe("protocol", () => {
  it("round-trips every client message type", () => {
    const messages: ClientMessage[] = [
      { t: "c-hello", v: 1, name: "철수" },
      {
        t: "c-move",
        seq: 42,
        pos: [1, 2, 3],
        vel: [0, -1, 0],
        yaw: 1.5,
        anim: "run",
        grounded: true,
      },
      { t: "c-checkpoint", index: 2 },
      { t: "c-finish" },
      { t: "c-respawn", reason: "death" },
      { t: "c-pong", nonce: 7 },
    ];
    for (const msg of messages) {
      const result = decodeClientMessage(encodeMessage(msg));
      expect(result).toEqual({ ok: true, msg });
    }
  });

  it("round-trips representative server messages", () => {
    const messages: ServerMessage[] = [
      {
        t: "s-welcome",
        playerId: "p1",
        roomId: "r1",
        seed: 123,
        serverTimeMs: 1000,
        snapshotHz: 15,
        players: [{ id: "p2", name: "영희", checkpoint: -1 }],
        dateStr: "2026-07-17",
        dayNumber: 1,
        dayStartMs: 1_784_646_000_000,
        nextDayStartMs: 1_784_732_400_000,
        board: [{ name: "철수", timeMs: 42_000, rank: 1 }],
      },
      {
        t: "s-daily-board",
        dateStr: "2026-07-17",
        entries: [{ name: "영희", timeMs: 30_000, rank: 1 }],
      },
      { t: "s-notice", kind: "new-day", dateStr: "2026-07-18" },
      {
        t: "s-snapshot",
        serverTimeMs: 2000,
        players: [{ id: "p2", pos: [0, 1, 0], yaw: 0, anim: "idle", grounded: true }],
      },
      { t: "s-correction", pos: [0, 0, 0], reason: "speed" },
      { t: "s-error", code: "room-full", msg: "full" },
    ];
    for (const msg of messages) {
      const result = decodeServerMessage(encodeMessage(msg));
      expect(result).toEqual({ ok: true, msg });
    }
  });

  it("rejects malformed frames", () => {
    expect(decodeClientMessage(42).ok).toBe(false);
    expect(decodeClientMessage("not json").ok).toBe(false);
    expect(decodeClientMessage('{"t":"nope"}').ok).toBe(false);
    expect(decodeClientMessage(JSON.stringify({ t: "c-finish", extra: 1 })).ok).toBe(true); // extra keys stripped
    expect(decodeClientMessage("x".repeat(5000)).ok).toBe(false);
  });

  it("rejects non-finite vectors (NaN never crosses the wire)", () => {
    const bad = `{"t":"c-move","seq":1,"pos":[null,0,0],"vel":[0,0,0],"yaw":0,"anim":"run","grounded":true}`;
    expect(decodeClientMessage(bad).ok).toBe(false);
    const nan = `{"t":"c-move","seq":1,"pos":[1e999,0,0],"vel":[0,0,0],"yaw":0,"anim":"run","grounded":true}`;
    expect(decodeClientMessage(nan).ok).toBe(false);
  });

  it("rejects bad player names", () => {
    expect(decodeClientMessage(JSON.stringify({ t: "c-hello", v: 1, name: "" })).ok).toBe(false);
    expect(
      decodeClientMessage(JSON.stringify({ t: "c-hello", v: 1, name: "a".repeat(17) })).ok,
    ).toBe(false);
    expect(
      decodeClientMessage(
        JSON.stringify({ t: "c-hello", v: 1, name: `a${String.fromCharCode(7)}b` }),
      ).ok,
    ).toBe(false);
  });
});
