// Water frame cost, plain path against the water pipeline, standing and flowing: the frame
// interval (median / p90 / worst) and where the worst frame went (the game's own phase timer).
//   node tools/perf-water.mjs     (needs `pnpm dev`; headless software GL: compare, do not quote)
//   GPU=1 the real GPU, uncapped (the interval is a frame's cost; a scene the GPU cannot draw at
//   that rate stalls in bursts — an artefact); GPU=1 CAP=1 at the screen's rate: what a player sees.
//   SCENE=many N=40: dozens of springs poured one after another, measured while they spread.
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new", args: process.env.GPU === "1"
  // the real GPU, frame rate uncapped: the interval IS the cost of a frame
  ? ["--no-sandbox", "--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", ...(process.env.CAP === "1" ? [] : ["--disable-gpu-vsync", "--disable-frame-rate-limit"])]
  : ["--enable-unsafe-swiftshader", "--no-sandbox"] });
const rows = [];
for (const q of (process.env.CONFIGS ?? "&water2=0,&water2=1").split(",")) {
  const page = await browser.newPage();
  await page.setViewport({ width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 720), deviceScaleFactor: Number(process.env.DPR ?? 1) });
  if (rows.length === 0) console.log("renderer:", await page.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl?.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?"; }));
  await page.goto(`${BASE}/?mode=field&reset=1${q}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  const [X, Y, Z] = await page.evaluate(() => globalThis.__roboCraft.snapshot().pos.map(Math.floor));
  // a pond 20 × 20 three deep, blocks hanging over it with water poured on them, a wall with a fall
  await page.evaluate((X, Y, Z) => { const c = globalThis.__roboCraft;
    for (let x = X - 10; x < X + 10; x++) for (let z = Z - 24; z < Z - 4; z++) { for (let y = Y - 3; y <= Y - 1; y++) c.mineAt(x, y, z); c.pourAt(x, Y - 1, z); }
    for (let i = 0; i < 6; i++) { const x = X - 8 + i * 3; c.placeAt(x, Y + 2, Z - 12, "stone"); c.placeAt(x, Y + 3, Z - 12, "stone"); c.pourAt(x, Y + 4, Z - 12); }
    c.look(Math.PI, -0.3); }, X, Y, Z);
  const measure = (ms) => page.evaluate((ms) => new Promise((done) => {
    const t = []; let last = performance.now(); const end = last + ms;
    const raw = []; const tick = () => { const now = performance.now(); t.push(now - last); raw.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else { t.sort((a, b) => a - b); const p = globalThis.__roboCraft.perf(); done({ long: raw.map((d, i) => [i, Math.round(d)]).filter((x) => x[1] > 40).slice(0, 12), frames: t.length, median: +t[t.length >> 1].toFixed(1), p90: +t[Math.floor(t.length * 0.9)].toFixed(1), worst: +t[t.length - 1].toFixed(1), calls: p.drawCalls, tris: p.triangles, worstFrame: Object.fromEntries(Object.entries(p.worstFrame.phases).map(([k, v]) => [k, +v.toFixed(1)])) }); } };
    requestAnimationFrame(tick);
  }), ms);
  if (process.env.SCENE === "many") {
    // dozens of springs put down one after another on open ground, every third on a pillar:
    // measured WHILE they spread (the frames a player feels), then once everything has settled
    const N = Number(process.env.N ?? 40);
    const pour = page.evaluate((X, Y, Z, N) => new Promise((done) => { const c = globalThis.__roboCraft; let i = 0;
      const id = setInterval(() => {
        const x = X - 28 + (i * 37) % 57, z = Z - 34 + (i * 23) % 31;
        if (i % 3 === 0) { c.placeAt(x, Y, z, "stone"); c.placeAt(x, Y + 1, z, "stone"); c.pourAt(x, Y + 2, z); } else c.pourAt(x, Y, z);
        if (++i >= N) { clearInterval(id); done(); } }, 150); }), X, Y, Z, N);
    rows.push([q, "pouring", await measure(N * 150 + 3000)]);
    await pour;
    await new Promise((r) => setTimeout(r, 6000));
    rows.push([q, "settled", await measure(4000)]);
    rows.push([q, "stats", await page.evaluate(() => ({ ...globalThis.__roboCraft.waterStats(), cells: globalThis.__roboCraft.water().cells }))]);
    await page.close();
    continue;
  }
  await new Promise((r) => setTimeout(r, 8000));
  rows.push([q, "standing", await measure(4000)]);
  // keep the water moving: open and close a hole in the pond's wall
  const flow = page.evaluate((X, Y, Z) => new Promise((done) => { const c = globalThis.__roboCraft; let n = 0;
    const id = setInterval(() => { if (n++ % 2 === 0) c.mineAt(X, Y - 1, Z - 3); else c.placeAt(X, Y - 1, Z - 3, "stone"); if (n > 8) { clearInterval(id); done(); } }, 600); }), X, Y, Z);
  rows.push([q, "flowing", await measure(5000)]);
  await flow;
  await page.close();
}
for (const [q, what, m] of rows) console.log(q.padEnd(10), what.padEnd(9), JSON.stringify(m));
await browser.close();
