// Capture each VR viewpoint station for visual review (flat-screen preview).
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const outDir = process.argv[2];
const landmark = Number(process.argv[3] ?? 3); // a tall one by default
const fraction = Number(process.argv[4] ?? 1); // how far along the build is
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto(`http://localhost:5173/?mode=builder&vr=1&reset=1`, {
  waitUntil: "networkidle2",
  timeout: 30000,
});
await page.waitForFunction(() => !!globalThis.__roboBuilder, { timeout: 15000 });
await page.evaluate(([i, f]) => globalThis.__roboBuilder.jumpTo(i, f), [landmark, fraction]);
await sleep(3000); // let the pour catch up
await page.evaluate(() => globalThis.__roboBuilder.vrPreview(true));

const seen = new Set();
for (let i = 0; i < 14 && seen.size < 4; i++) {
  await sleep(1400); // past the fade-in
  const s = await page.evaluate(() => globalThis.__roboBuilder.vrStatus());
  if (!seen.has(s.station)) {
    seen.add(s.station);
    await page.screenshot({ path: `${outDir}/vr-${s.station}.png` });
    console.log(`${s.station}  rig=[${s.rig.map((v) => v.toFixed(1))}]  yaw=${s.yaw.toFixed(2)}`);
  }
  await page.evaluate(() => globalThis.__roboBuilder.vrSkip());
  await sleep(700);
}
await browser.close();
