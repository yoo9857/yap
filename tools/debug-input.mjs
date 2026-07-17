// Focused input debug: hold W, sample the game state every 300 ms.
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
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

await page.click("#app"); // ensure focus on the document/canvas
await page.keyboard.down("KeyW");
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 300));
  const s = await page.evaluate(() => globalThis.__robo?.snapshot?.() ?? null);
  console.log(
    `t=${(i + 1) * 300}ms feet=[${s.feet.map((v) => v.toFixed(2)).join(",")}] vel=[${s.vel
      .map((v) => v.toFixed(2))
      .join(",")}] frame=${JSON.stringify(s.lastFrame)} camYaw=${s.camYaw.toFixed(2)} anim=${s.anim}`,
  );
}
await page.keyboard.up("KeyW");

// jump check
await page.keyboard.down("Space");
await new Promise((r) => setTimeout(r, 100));
await page.keyboard.up("Space");
await new Promise((r) => setTimeout(r, 250));
const s = await page.evaluate(() => globalThis.__robo?.snapshot?.() ?? null);
console.log(`after jump: feet=[${s.feet.map((v) => v.toFixed(2)).join(",")}] anim=${s.anim}`);

await browser.close();
