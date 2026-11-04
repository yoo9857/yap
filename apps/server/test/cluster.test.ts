import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CLASS_PROTOCOL_VERSION } from "@robo/shared";

/**
 * The real cluster: a primary and two shard processes on a throw-away database.
 * Routing and the shared field are checked everywhere; the deploy path (SIGTERM →
 * every shard saves its classes and exits) only where SIGTERM is a signal —
 * on Windows `kill()` is TerminateProcess and nothing gets to save.
 */
const dir = mkdtempSync(join(tmpdir(), "craftyap-cluster-"));
const PORT = 18000 + Math.floor(Math.random() * 2000);
const procs: ChildProcess[] = [];

function boot(): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", SHARDS: "2", LOG_LEVEL: "warn", DB_PATH: join(dir, "records.db"), SERVE_STATIC: "0" },
    stdio: "ignore",
  });
  procs.push(child);
  return child;
}

async function healthy(): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("cluster did not become healthy");
}

type Seat = { ws: WebSocket; key: string; edits: number[][]; you: string };

/** Host or join a class; resolves once the whole field has arrived. */
function enter(room: string, msg: Record<string, unknown>): Promise<Seat> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?mode=class&room=${encodeURIComponent(room)}`);
    const seat: Seat = { ws, key: "", edits: [], you: "" };
    let expected = -1;
    const timer = setTimeout(() => reject(new Error("no welcome")), 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ v: CLASS_PROTOCOL_VERSION, room, ...msg }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { t: string; key?: string; you?: string; editCount?: number; edits?: number[][]; code?: string };
      if (m.t === "s-k-error") { clearTimeout(timer); reject(new Error(m.code)); }
      if (m.t === "s-k-welcome") { seat.key = m.key!; seat.you = m.you!; expected = m.editCount!; }
      if (m.t === "s-k-world") seat.edits.push(...m.edits!);
      if (expected >= 0 && seat.edits.length >= expected) { clearTimeout(timer); resolve(seat); }
    };
  });
}

const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

afterAll(async () => {
  for (const p of procs) if (p.exitCode === null) p.kill();
  await Promise.all(procs.map(exited));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows may hold the WAL briefly */ }
});

describe("cluster (primary + 2 shards)", () => {
  it("routes a teacher and students of one class to the same shard, and shares their field", async () => {
    boot();
    await healthy();
    const metrics = (await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).json()) as { mode: string; up: number };
    expect(metrics.mode).toBe("cluster");
    expect(metrics.up).toBe(2);

    // several classes, so they spread over both shards; each must still meet in one place
    for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) {
      const teacher = await enter(name, { t: "k-host", teacher: `T${name}`, password: "pass1234" });
      // case and spacing differ: same class key, so the same shard
      const student = await enter(` ${name.toLowerCase()} `, { t: "k-join", student: "Kim" });
      const seen = new Promise<boolean>((resolve) => {
        student.ws.addEventListener("message", (e) => { if (String(e.data).includes('"s-k-edit"')) resolve(true); });
        setTimeout(() => resolve(false), 5000);
      });
      teacher.ws.send(JSON.stringify({ t: "k-edit", edits: [[1, 5, 1, 7, 0]] }));
      expect(await seen).toBe(true);
      teacher.ws.close();
      student.ws.close();
    }
  }, 60_000);

  it.skipIf(process.platform === "win32")("a deploy (SIGTERM) saves every shard's classes and takes every shard down with it", async () => {
    const teacher = await enter("Echo", { t: "k-host", teacher: "TEcho", password: "pass1234" });
    teacher.ws.send(JSON.stringify({ t: "k-edit", edits: [[2, 6, 2, 7, 0]] }));
    await new Promise((r) => setTimeout(r, 300)); // well inside the 15 s autosave: only shutdown can save it
    const primary = procs.at(-1)!;
    primary.kill("SIGTERM");
    await exited(primary);
    // nothing listens any more: the shards went with the primary
    await expect(fetch(`http://127.0.0.1:${PORT}/healthz`)).rejects.toThrow();

    boot();
    await healthy();
    const back = await enter("Echo", { t: "k-host", teacher: "TEcho", hostKey: teacher.key });
    expect(back.edits.some(([x, y, z, b]) => x === 2 && y === 6 && z === 2 && b === 7)).toBe(true);
    back.ws.close();
  }, 60_000);
});
