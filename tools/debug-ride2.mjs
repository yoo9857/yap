// Ride stability after settling + jump-off momentum inheritance.
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/?mode=tower", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(
  () => document.getElementById("boot-overlay")?.classList.contains("hidden"),
  { timeout: 20000 },
);
await page.click("#app");

const moving = await page.evaluate(() => {
  const p = globalThis.__robo.level().find((q) => q.kind === "moving");
  const pos = globalThis.__robo.platformPos(p.id);
  globalThis.__robo.teleport(pos[0], pos[1] + p.size[1] / 2 + 0.05, pos[2]);
  return p;
});

// settle 2 s, then measure relative offset drift over ~1.5 swing periods
await new Promise((r) => setTimeout(r, 2000));
const offsets = [];
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 150));
  const s = await page.evaluate((id) => {
    const snap = globalThis.__robo.snapshot();
    return { feet: snap.feet, plat: globalThis.__robo.platformPos(id), grounded: snap.grounded };
  }, moving.id);
  offsets.push(Math.hypot(s.feet[0] - s.plat[0], s.feet[2] - s.plat[2]));
  if (!s.grounded) console.log(`LOST GROUND at sample ${i}`);
}
const min = Math.min(...offsets);
const max = Math.max(...offsets);
console.log(`offset drift over 6 s: min=${min.toFixed(3)} max=${max.toFixed(3)} Δ=${(max - min).toFixed(3)} m`);

// jump off: hold forward briefly + jump at a fast phase; player should carry momentum
const before = await page.evaluate(() => globalThis.__robo.snapshot());
await page.keyboard.down("Space");
await new Promise((r) => setTimeout(r, 120));
await page.keyboard.up("Space");
await new Promise((r) => setTimeout(r, 250));
const mid = await page.evaluate(() => globalThis.__robo.snapshot());
console.log(
  `jump-off: before vel=[${before.vel.map((v) => v.toFixed(2))}] mid-air vel=[${mid.vel.map((v) => v.toFixed(2))}] anim=${mid.anim}`,
);
await browser.close();
