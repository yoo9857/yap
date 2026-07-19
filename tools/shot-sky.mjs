// Visual capture of the atmosphere/scenery at several altitudes.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = process.argv[2] || "C:\\robo\\scratchpad-shots";
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/?mode=tower", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 20000 });
await page.click("#app");
await page.evaluate(() => { globalThis.__robo.startRun("sky"); globalThis.__robo.offline(); });
const meta = await page.evaluate(() => globalThis.__robo.levelMeta());
const summit = meta.summitHeight;
console.log("summit height:", summit.toFixed(1));

const bands = [
  { name: "ground", frac: 0.04 },
  { name: "sky", frac: 0.45 },
  { name: "ozone", frac: 0.72 },
  { name: "space", frac: 0.96 },
];
for (const b of bands) {
  const y = summit * b.frac;
  // hold altitude by re-teleporting (offline gravity would otherwise drop us
  // out of the band before the height-driven blend settles)
  await page.evaluate(async (yy) => {
    await new Promise((resolve) => {
      let n = 0;
      const id = setInterval(() => {
        globalThis.__robo.teleport(0, yy, 0);
        if (++n > 22) { clearInterval(id); resolve(); }
      }, 120);
    });
  }, y);
  await page.screenshot({ path: `${OUT}\\sky-${b.name}.png` });
  console.log(`${b.name}: y=${y.toFixed(1)}`);
}
await browser.close();
console.log("shots →", OUT);
