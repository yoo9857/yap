import puppeteer from "puppeteer-core";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await browser.newPage();
await page.goto("http://localhost:5173/?mode=tower", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 20000 });
const data = await page.evaluate(() => ({ level: globalThis.__robo.level(), meta: globalThis.__robo.levelMeta() }));
console.log("CLIENT SEED:", data.meta.seed, "| ground size:", data.level.find((q) => q.role === "ground")?.size[0]);
await browser.close();

const bricks = data.level.filter((p) => !(p.kind === "solid" && p.role === "ground"));
const half = (p) => Math.max(p.size[0], p.size[2]) / 2;
let tooClose = 0; const gaps = [];
for (const p of bricks) {
  let nearestEdge = Infinity;
  for (const q of bricks) {
    if (q === p) continue;
    if (Math.abs(p.center[1] - q.center[1]) > 0.4) continue;
    const d = Math.hypot(p.center[0] - q.center[0], p.center[2] - q.center[2]);
    nearestEdge = Math.min(nearestEdge, d - half(p) - half(q));
  }
  if (nearestEdge < 0.4) tooClose++;
  if (nearestEdge < Infinity) gaps.push(nearestEdge);
}
gaps.sort((a, b) => a - b);
const pct = (arr, f) => arr[Math.floor(arr.length * f)]?.toFixed(2);
console.log("total bricks:", bricks.length);
console.log("same-height neighbours with <0.4m edge gap (merge/overlap):", tooClose, "/", gaps.length);
console.log("edge-gap p10:", pct(gaps, 0.1), "p25:", pct(gaps, 0.25), "p50:", pct(gaps, 0.5), "p75:", pct(gaps, 0.75));

// VERTICAL-STACK check: nearest parent one hop below (dy in [1.8,2.7]) — its
// planar (centre) distance. If ~0, the platform is directly overhead and the
// climb is blocked. Bricks want a parent at ~2.6-3.6 planar.
const parentPlanar = [];
let stacked = 0;
const wide = (q) => Math.max(q.size[0], q.size[2]) >= 4; // pad/baseplate: any offset ok
for (const p of bricks) {
  let bestGood = Infinity; // nearest CLIMBABLE parent (offset enough, or a wide pad)
  for (const q of data.level) {
    if (q === p) continue;
    const dy = p.center[1] - q.center[1];
    if (dy < 1.8 || dy > 3.0) continue;
    const d = Math.hypot(p.center[0] - q.center[0], p.center[2] - q.center[2]);
    if (d <= 3.95 && (d >= 2.3 || wide(q))) bestGood = Math.min(bestGood, d);
  }
  if (bestGood === Infinity) {
    stacked++;
    const band = data.level
      .filter((q) => q !== p && p.center[1] - q.center[1] >= 1.8 && p.center[1] - q.center[1] <= 3.0)
      .map((q) => `id${q.id}:${Math.hypot(p.center[0] - q.center[0], p.center[2] - q.center[2]).toFixed(2)}${wide(q) ? "(wide)" : ""}`);
    console.log(`  STACKED id${p.id} (${p.kind}) y=${p.center[1].toFixed(1)} band=[${band.join(",")}]`);
  } else parentPlanar.push(bestGood);
}
parentPlanar.sort((a, b) => a - b);
console.log("bricks with NO climbable parent (STACKED/overhead-blocked):", stacked, "/", bricks.length);
console.log("climbable parent-planar p10:", pct(parentPlanar, 0.1), "p25:", pct(parentPlanar, 0.25), "p50:", pct(parentPlanar, 0.5));
const firstCrumble = data.level.find((p) => p.kind === "crumbling");
if (firstCrumble) {
  let best = Infinity, bestP = null;
  for (const q of bricks) {
    if (q === firstCrumble || Math.abs(firstCrumble.center[1] - q.center[1]) > 0.4) continue;
    const d = Math.hypot(firstCrumble.center[0] - q.center[0], firstCrumble.center[2] - q.center[2]);
    if (d < best) { best = d; bestP = q; }
  }
  console.log("first crumble y=", firstCrumble.center[1].toFixed(1), "nearest same-height edge gap=", (best - half(firstCrumble) - (bestP ? half(bestP) : 0)).toFixed(2));
}
// --- head-clearance / overhang hazards ---
// character capsule is 1.8 m tall; standing on P, the head is at P.top + 1.8.
// A platform Q whose UNDERSIDE sits in (P.top, P.top+1.8) and overlaps P
// horizontally will catch the head.
const THICK = 0.55, CHAR_H = 1.8;
const top = (p) => p.center[1] + THICK / 2;
const bottom = (p) => p.center[1] - THICK / 2;
let headHazards = 0;
const hitPlats = new Set();
for (const p of data.level) {
  const pt = top(p);
  for (const q of data.level) {
    if (q === p) continue;
    const qb = bottom(q);
    if (qb <= pt + 0.15 || qb >= pt + CHAR_H) continue; // Q not in the head band
    const d = Math.hypot(p.center[0] - q.center[0], p.center[2] - q.center[2]);
    if (d < half(p) + half(q) - 0.05) { // footprints overlap → overhang
      headHazards++;
      hitPlats.add(p.id);
    }
  }
}
console.log("HEAD-CLEARANCE overhangs:", headHazards, "affecting", hitPlats.size, "/", data.level.length, "platforms");
console.log("summit:", data.meta.summitHeight.toFixed(1), "minFinish:", data.meta.minFinishSeconds.toFixed(1));
