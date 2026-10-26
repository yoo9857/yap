// Local transport simulation, including 40 simultaneous students and 300k
// stored cells. Run via the server's tsx loader, never against production:
// pnpm --filter @robo/server exec node --expose-gc --import tsx ../../tools/stress-classroom.mjs
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { ClassManager } from "../apps/server/src/classroom/classManager.js";
import { MemoryClassStore, hashPassword } from "../apps/server/src/classroom/classStore.js";
import { CLASS_PROTOCOL_VERSION } from "../packages/shared/src/index.js";
class Peer extends EventEmitter {
  OPEN = 1; readyState = 1; bufferedAmount = 0; world = 0; expected = -1; updates = 0; buffers = []; ended = false;
  send(raw) {
    const buffer = Buffer.from(raw); this.buffers.push(buffer); this.bufferedAmount += buffer.length;
    const msg = JSON.parse(raw);
    if (msg.t === "s-k-world") this.world += msg.edits.length;
    if (msg.t === "s-k-welcome") this.expected = msg.editCount;
    if (msg.t === "s-k-edit") this.updates += msg.edits.length;
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.ended = true; this.emit("close"); }
  terminate() { this.close(); }
  ping() { this.emit("pong"); }
  say(msg) { this.emit("message", Buffer.from(JSON.stringify(msg)), false); }
  drain() { this.bufferedAmount = 0; this.buffers = []; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const gc = () => globalThis.gc?.();
const memory = () => { gc(); const m = process.memoryUsage(); return { heapMiB: m.heapUsed / 1048576, rssMiB: m.rss / 1048576 }; };
const store = new MemoryClassStore(), auth = hashPassword("1234");
let saved = { teacherName: "Teacher", roomName: "Stress", teacherKey: "key", passHash: auth.hash, salt: auth.salt,
  students: [], settings: { buildLocked: false, chatLocked: false },
  edits: Array.from({ length: 300000 }, (_, i) => [i % 1000 - 500, 4, Math.floor(i / 1000) - 150, 19, 0]) };
store.save("stress", saved); saved = null;
const before = memory(), manager = new ClassManager(store), peers = [];
const add = (msg) => { const p = new Peer(); peers.push(p); manager.accept(p, "local-stress"); p.say(msg); return p; };
const teacher = add({ t: "k-host", v: CLASS_PROTOCOL_VERSION, room: "Stress", teacher: "Teacher", hostKey: "key" });
for (let i = 0; i < 40; i++) add({ t: "k-join", v: CLASS_PROTOCOL_VERSION, room: "Stress", student: `Student${i}` });
const queued = memory(), start = performance.now(); let peakRssMiB = queued.rssMiB;
const drain = setInterval(() => { for (const p of peers) p.drain(); peakRssMiB = Math.max(peakRssMiB, process.memoryUsage().rss / 1048576); }, 20);
try {
  teacher.say({ t: "k-edit", edits: [[0, 4, 0, 17, 0]] });
  while (peers.some((p) => p.world !== p.expected)) {
    if (peers.some((p) => p.ended)) throw new Error("A joining participant was disconnected");
    if (performance.now() - start > 90000) throw new Error("World transfer did not finish");
    await wait(50);
  }
  const loaded = memory(); manager.shutdown(); clearInterval(drain); for (const p of peers) p.drain();
  await wait(50); const after = memory();
  const cleanupHeapGrowthMiB = after.heapMiB - before.heapMiB;
  const ok = peers.every((p) => p.expected === 300000 && p.world === 300000) && peers.slice(1).every((p) => p.updates === 1) && peakRssMiB < 400 && cleanupHeapGrowthMiB < 16;
  const report = { peers: peers.length, cells: 300000, before, queued, loaded, after, peakRssMiB,
    loadMs: performance.now() - start, cleanupHeapGrowthMiB, updates: peers.map((p) => p.updates), ok };
  await mkdir("../../tmp/world-load-final", { recursive: true });
  await writeFile("../../tmp/world-load-final/server.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); process.exitCode = ok ? 0 : 1;
} finally { clearInterval(drain); manager.shutdown(); }
