// Block edits under load: how long frames get while many blocks appear and disappear.
//
//   node tools/perf-edits.mjs                 # every scenario on the craft island (needs pnpm dev)
//   ONLY=wall,stream node tools/perf-edits.mjs
//   MODE=field node tools/perf-edits.mjs      # the same on the education field (a wall is built first)
//
// Scenarios (each prints frames, percentiles, how many frames ran over 33 / 50 / 100 ms and the
// worst frame's phases):
//   idle     nothing changes (the floor to compare against)
//   wall     a 12 x 8 wall of the castle taken away, 4 cells a frame            (dense, joined blocks)
//   cube     a 10 x 10 x 10 solid cube set down 20 cells a frame, then removed   (2000 edits in one place)
//   line     400 blocks set down one a frame along a line 100 cells long         (edits crossing chunks)
//   stream   3000 edits scattered over 9 chunks, 30 a frame                      (a class building at once)
//
// The rule the game is held to (docs/WORLD_RUNTIME.md): an edit costs the frame a bounded amount
// whatever the chunk holds. Run on the real GPU (headless Edge, d3d11); numbers from SwiftShader
// say nothing about frame time.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const puppeteer = createRequire(fileURLToPath(new URL("../package.json", import.meta.url)))("puppeteer-core");
const BASE = process.env.BASE ?? "http://localhost:5173", MODE = process.env.MODE ?? "craft";
const only = (process.env.ONLY ?? "").split(",").filter(Boolean);
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new", args: ["--no-sandbox", "--window-size=1600,900", "--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
await page.evaluateOnNewDocument(() => {
  // headless has no pointer lock: grant it at once, so the game runs as with a captured mouse
  Element.prototype.requestPointerLock = function () { Object.defineProperty(document, "pointerLockElement", { get: () => this, configurable: true }); queueMicrotask(() => document.dispatchEvent(new Event("pointerlockchange"))); return Promise.resolve(); };
  globalThis.__frames = [];
  let last = 0;
  const tick = (t) => { if (last) globalThis.__frames.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await page.goto(`${BASE}/?mode=${MODE}&reset=1${process.env.QUERY ?? ""}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.classList.contains("in-game") && globalThis.__roboCraft && document.querySelector("#boot-overlay")?.classList.contains("hidden"), { timeout: 120000, polling: 300 });
await new Promise((r) => setTimeout(r, 2500));
await page.mouse.click(940, 325); // the start card's button
await new Promise((r) => setTimeout(r, 500));
await page.mouse.click(800, 450);
await new Promise((r) => setTimeout(r, 1500));

/** Run `steps` frames of edits in the page (`edit(i)` → an array of [op, x, y, z] to apply that frame), then report. */
const run = async (label, frames, plan) => {
  const r = await page.evaluate(async (frames, planSource) => {
    const c = globalThis.__roboCraft, plan = new Function("i", "ctx", planSource), ctx = {};
    globalThis.__frames.length = 0; c.perf();
    let edits = 0;
    for (let i = 0; i < frames; i++) {
      for (const [op, x, y, z] of plan(i, ctx) ?? []) { if (op === "-" ? c.mineAt(x, y, z) : c.placeAt(x, y, z, op)) edits++; }
      await new Promise((r) => requestAnimationFrame(r));
    }
    for (let i = 0; i < 40; i++) await new Promise((r) => requestAnimationFrame(r)); // let queued rebuilds finish
    const f = globalThis.__frames.slice().sort((a, b) => a - b), q = (v) => f[Math.min(f.length - 1, Math.floor(f.length * v))], p = c.perf();
    return { edits, n: f.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: f[f.length - 1], o33: f.filter((v) => v > 33).length, o50: f.filter((v) => v > 50).length, o100: f.filter((v) => v > 100).length, worst: p.worstFrame, chunks: c.chunks() };
  }, frames, plan);
  const phases = Object.entries(r.worst?.phases ?? {}).filter(([, ms]) => ms >= 1).map(([k, ms]) => `${k} ${ms.toFixed(0)}`).join(", ");
  console.log(`${label.padEnd(7)} ${String(r.edits).padStart(5)} edits | ${r.n} frames  p50 ${r.p50.toFixed(1)}  p95 ${r.p95.toFixed(1)}  p99 ${r.p99.toFixed(1)}  max ${r.max.toFixed(0)} ms | over 33: ${r.o33}  over 50: ${r.o50}  over 100: ${r.o100} | worst frame: ${phases || "-"} | queued ${r.chunks.queued}`);
  return r;
};

// where the scenarios happen: beside the player (the island's spawn stands before the castle wall)
const at = await page.evaluate(() => { const s = globalThis.__roboCraft.snapshot?.() ?? {}; const a = globalThis.__roboCraft.aimInfo?.(); return { pos: s.pos ?? s.position ?? null, aim: a?.voxel ?? null }; });
const [ax, ay, az] = at.aim ?? [39, 10, 70];
console.log(`mode ${MODE}; the wall is at ${ax},${ay},${az}`);
const want = (name) => !only.length || only.includes(name);
const S = `const ax=${ax}, ay=${ay}, az=${az};`;
if (want("idle")) await run("idle", 240, "return [];");
if (MODE !== "craft") // a field has no castle: stand a 14 x 9 wall, two cells thick, to take away
  await run("(build)", 126, S + "const out=[]; for (let k=0;k<2;k++){ const n=i*2+k, x=ax-6+n%14, y=ay+Math.floor(n/14)%9, z=az+2+Math.floor(n/126); out.push(['stone-bricks',x,y,z]); } return out;");
if (want("wall")) await run("wall", 24, S + "const out=[]; for (let k=0;k<4;k++){ const n=i*4+k, x=ax-6+n%12, y=ay-3+Math.floor(n/12); for (let d=0;d<3;d++) out.push(['-',x,y,az+d],['-',x,y,az-d]); } return out;");
if (want("cube")) {
  await run("cube +", 50, S + "const out=[]; for (let k=0;k<20;k++){ const n=i*20+k, x=ax-5+n%10, z=az-14+Math.floor(n/10)%10, y=ay+6+Math.floor(n/100); out.push(['stone-bricks',x,y,z]); } return out;");
  await run("cube -", 50, S + "const out=[]; for (let k=0;k<20;k++){ const n=i*20+k, x=ax-5+n%10, z=az-14+Math.floor(n/10)%10, y=ay+6+Math.floor(n/100); out.push(['-',x,y,z]); } return out;");
}
if (want("line")) await run("line", 400, S + "const x=ax-50+Math.floor(i/4), y=ay+18+i%4; return [['oak-planks',x,y,az-20]];");
if (want("stream")) await run("stream", 100, S + "ctx.s=ctx.s??12345; const out=[]; for (let k=0;k<30;k++){ ctx.s=(Math.imul(ctx.s,1664525)+1013904223)|0; const r=ctx.s>>>0, x=ax-24+r%48, z=az-24+(r>>>8)%48, y=ay+10+(r>>>16)%6; out.push([(r>>>24)%3?'stone-bricks':'-',x,y,z]); } return out;");
// what is drawn after all of it must be what a fresh build draws: every face bordering air (as tools/e2e-holes.mjs)
const audit = await page.evaluate(() => globalThis.__roboCraft.auditFaces?.() ?? null);
console.log("faces after the edits:", JSON.stringify(audit).slice(0, 200));
if (errors.length) console.log("page errors:", errors.slice(0, 3));
await browser.close();
