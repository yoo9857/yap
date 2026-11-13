// node tools/perf-fire.mjs [query] — what the fire drill costs: what is downloaded, what the scene
// holds (draw calls, triangles, materials, textures), how long the rules' maps take to work out,
// and the frame's CPU side. Headless: GPU fill cost is NOT measured here (software renderer).
import puppeteer from "puppeteer-core";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,720"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const assets = [];
page.on("response", async (r) => {
  const url = r.url();
  if (!/\.(glb|webp|png|jpg|mp3|wasm|json)(\?|$)/.test(url)) return;
  try { assets.push([url.replace(BASE, "").split("?")[0], (await r.buffer()).length]); } catch { /* aborted */ }
});
const t0 = Date.now();
await page.goto(`${BASE}/?mode=field&theme=fire${process.argv[2] ?? ""}`, { waitUntil: "networkidle2", timeout: 90000 });
await page.waitForFunction(() => !!globalThis.__roboCraft?.fire?.(), { timeout: 60000 });
console.log("boot to drill ready:", Date.now() - t0, "ms");
await new Promise((r) => setTimeout(r, 3000));
assets.sort((a, b) => b[1] - a[1]);
console.log("downloaded assets:", (assets.reduce((s, a) => s + a[1], 0) / 1e6).toFixed(2), "MB in", assets.length, "files");
for (const [u, n] of assets.slice(0, 14)) console.log(`  ${(n / 1024).toFixed(0).padStart(6)} KB  ${u}`);
const maps = await page.evaluate(async () => {
  const m = await import("/src/craft/fire/drillRules.ts");
  const time = (f) => { const a = performance.now(); f(); return +(performance.now() - a).toFixed(1); };
  return { note: "already cached by the game: these are second calls unless 0", burnField: time(() => m.burnField()), smokeField: time(() => m.smokeField()) };
});
console.log("rules maps:", JSON.stringify(maps));
await page.evaluate(() => { globalThis.__roboCraft.firePlay(true); globalThis.__roboCraft.fireSet({ time: 150 }); });
await new Promise((r) => setTimeout(r, 1500));
const scene = await page.evaluate(() => globalThis.__roboCraft.scene?.() ?? null);
console.log("scene:", JSON.stringify(scene)?.slice(0, 900));
console.log("perf:", JSON.stringify(await page.evaluate(() => globalThis.__roboCraft.perf?.() ?? null)));
await browser.close();
