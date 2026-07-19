// Capture the multi-route tower from a few heights.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = process.argv[2] || "C:\\robo\\scratchpad-shots";
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/?mode=tower", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 20000 });
await page.click("#app");
await page.evaluate(() => { globalThis.__robo.startRun("tower"); globalThis.__robo.offline(); });
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: `${OUT}\\tower-spawn.png` });

const heights = [12, 30, 55];
for (const y of heights) {
  await page.evaluate(async (yy) => {
    await new Promise((resolve) => {
      let n = 0;
      const id = setInterval(() => { globalThis.__robo.teleport(0.5, yy, 0.5); if (++n > 12) { clearInterval(id); resolve(); } }, 120);
    });
  }, y);
  await page.screenshot({ path: `${OUT}\\tower-h${y}.png` });
}
console.log("shots →", OUT);
await browser.close();
