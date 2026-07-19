// Visual capture of the crayon jump: fires a Space jump and grabs frames
// across the arc (rise=stretch, apex, land=squash+doodle ring).
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
await page.waitForFunction(
  () => document.getElementById("boot-overlay")?.classList.contains("hidden"),
  { timeout: 20000 },
);
await page.click("#app");
await page.evaluate(() => {
  globalThis.__robo.startRun("점프");
  globalThis.__robo.offline();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(500);

// jump and sample the arc
await page.focus("#app");
await page.keyboard.down("Space");
await sleep(60);
await page.keyboard.up("Space");

for (let i = 0; i < 22; i++) {
  const t = i * 40;
  const s = await page.evaluate(() => globalThis.__robo.snapshot());
  await page.screenshot({ path: `${OUT}\\jump-${String(t).padStart(3, "0")}.png` });
  console.log(`t=${t}ms  feet.y=${s.feet[1].toFixed(2)}  vy=${s.vel[1].toFixed(1)}  anim=${s.anim}`);
  await sleep(40);
}

await browser.close();
console.log("shots →", OUT);
