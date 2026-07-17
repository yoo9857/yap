// Visual check: screenshots of the title screen and in-game view.
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const outDir = process.argv[2] ?? ".";
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/?mode=tower", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(
  () => document.getElementById("boot-overlay")?.classList.contains("hidden"),
  { timeout: 20000 },
);
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: `${outDir}/title.png` });

// start the run and walk forward a bit for an in-game shot
await page.evaluate(() => globalThis.__robo.startRun("스크린샷"));
await page.keyboard.down("KeyW");
await new Promise((r) => setTimeout(r, 900));
await page.keyboard.up("KeyW");
await page.keyboard.down("Space");
await new Promise((r) => setTimeout(r, 120));
await page.keyboard.up("Space");
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: `${outDir}/ingame.png` });

// clear screen: teleport to goal
await page.evaluate(() => {
  const g = globalThis.__robo.goal();
  globalThis.__robo.teleport(g.center[0], g.center[1] + 0.1, g.center[2]);
});
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: `${outDir}/clear.png` });

await browser.close();
console.log("screenshots written");
