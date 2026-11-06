import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HANDOFF_MAX_MS, handoffPending, setHandoffFile } from "../src/net/handoff.js";

describe("deploy hand-over lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-"));
  const lock = join(dir, "handoff.lock");
  afterEach(() => {
    rmSync(lock, { force: true });
    setHandoffFile(null);
  });

  it("is off without a configured file or without the lock", () => {
    expect(handoffPending()).toBe(false);
    setHandoffFile(lock);
    expect(handoffPending()).toBe(false);
  });

  it("refuses new game sockets while a fresh lock exists", () => {
    setHandoffFile(lock);
    writeFileSync(lock, "");
    expect(handoffPending()).toBe(true);
  });

  it("ignores a stale lock (a deploy that died mid-way never locks the games out)", () => {
    setHandoffFile(lock);
    writeFileSync(lock, "");
    const old = (Date.now() - HANDOFF_MAX_MS - 5000) / 1000;
    utimesSync(lock, old, old);
    expect(handoffPending()).toBe(false);
  });
});
