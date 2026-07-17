// Jump-off-moving-platform probe with 60 ms sampling.
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

await page.evaluate(() => {
  const p = globalThis.__robo.level().find((q) => q.kind === "moving");
  const pos = globalThis.__robo.platformPos(p.id);
  globalThis.__robo.teleport(pos[0], pos[1] + p.size[1] / 2 + 0.05, pos[2]);
});
await new Promise((r) => setTimeout(r, 1500)); // settle on the platform

await page.keyboard.down("Space");
for (let i = 0; i < 14; i++) {
  await new Promise((r) => setTimeout(r, 60));
  if (i === 3) await page.keyboard.up("Space");
  const s = await page.evaluate(() => globalThis.__robo.snapshot());
  console.log(
    `t=${(i + 1) * 60}ms y=${s.feet[1].toFixed(2)} velY=${s.vel[1].toFixed(1)} velX=${s.vel[0].toFixed(2)} grounded=${s.grounded} anim=${s.anim} frame=${JSON.stringify({ jp: s.lastFrame?.jumpPressed, jh: s.lastFrame?.jumpHeld })}`,
  );
}
await browser.close();
