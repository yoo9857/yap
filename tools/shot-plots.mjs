// Dev look at the teacher's 자리 배치 without a class: the solo field, F2 (sample plots with
// stand-in students), shot from the ground and from above. Needs `pnpm dev`.
// node tools/shot-plots.mjs <outdir> [count]
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? ".";
const count = Number(process.argv[3] ?? 12);
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
const R = (fn, ...a) => page.evaluate(fn, ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto("http://localhost:5173/?mode=field&reset=1", { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 30000 });
await page.addStyleTag({ content: ".craft-hint{display:none!important}" });
await wait(1500);
await R(() => globalThis.__roboCraft.look(0, 0));
await wait(300);
console.log("plots", await R((n) => globalThis.__roboCraft.samplePlots(n), count));
await wait(1200);
await R(() => globalThis.__roboCraft.look(0, -0.3));
await wait(800);
await page.screenshot({ path: join(out, "plots-ground.png") });
// from above: the whole layout
await R(() => {
  const c = globalThis.__roboCraft;
  const p = c.snapshot().pos;
  c.teleport(p[0], p[1] + 16, p[2] - 3);
  c.look(0, -0.62);
});
await wait(150);
await page.screenshot({ path: join(out, "plots-air.png") });
await browser.close();
