// Run: pnpm --filter @robo/server exec node --expose-gc --import tsx ../../tools/stress-water-server.mjs [--raw]
// In-memory classrooms only; no live sockets or user save/database writes.
import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { ClassRoom } from "../apps/server/src/classroom/classRoom.js";
import { WATER } from "../packages/shared/src/fluid.js";

const gc = () => globalThis.gc?.();
const heap = () => { gc(); return process.memoryUsage().heapUsed / 1048576; };
const initial = new ClassRoom("Stress", { passHash: "", salt: "" });
const saved = initial.toSaved();
for (let i = 0; i < 50_000; i++) saved.edits.push([3 * (i % 200), 20, 3 * Math.floor(i / 200), WATER, 0]);
const budgetMs = process.argv.includes("--raw") ? Infinity : 6;
const before = heap(), start = performance.now();
const room = new ClassRoom("Stress", { passHash: "", salt: "" }, saved);
const restoreMs = performance.now() - start, restoreHeapMiB = heap() - before;
const samples = []; let changes = 0;
for (let i = 0; i < 24; i++) {
  const t = performance.now(); changes += room.stepFluids(budgetMs); samples.push(performance.now() - t);
}
samples.sort((a, b) => a - b);
const result = { label: budgetMs === Infinity ? "same 4096-cell work budget as baseline" : "bounded production steps",
  sources: 50000, restoreMs, restoreHeapMiB, changes, stored: room.editCount,
  medianStepMs: samples[12], maxStepMs: samples.at(-1) };
console.log(JSON.stringify(result));
await mkdir("../../tmp/water-load", { recursive: true });
await writeFile(`../../tmp/water-load/server-${budgetMs === Infinity ? "raw" : "bounded"}.json`, JSON.stringify(result, null, 2));
