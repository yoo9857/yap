// Fine-grained moving-platform ride debug: 100 ms samples of player vs platform.
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

const moving = await page.evaluate(() => {
  const p = globalThis.__robo.level().find((q) => q.kind === "moving");
  const pos = globalThis.__robo.platformPos(p.id);
  globalThis.__robo.teleport(pos[0], pos[1] + p.size[1] / 2 + 0.05, pos[2]);
  return p;
});
console.log("moving platform:", JSON.stringify(moving));

for (let i = 0; i < 25; i++) {
  await new Promise((r) => setTimeout(r, 100));
  const s = await page.evaluate((id) => {
    const snap = globalThis.__robo.snapshot();
    return { ...snap, plat: globalThis.__robo.platformPos(id) };
  }, moving.id);
  console.log(
    `t=${(i + 1) * 100}ms feet=[${s.feet.map((v) => v.toFixed(2)).join(",")}] plat=[${s.plat
      .map((v) => v.toFixed(2))
      .join(",")}] grounded=${s.grounded} standingOn=${s.standingOn} vel=[${s.vel
      .map((v) => v.toFixed(1))
      .join(",")}]`,
  );
}
await browser.close();
