// Verifies the even bottom-up recap pour + hologram-blue ghost.
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
await page.goto("http://localhost:5173/?mode=builder", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => !!globalThis.__roboBuilder, { timeout: 10000 });
await page.evaluate(() => {
  globalThis.__roboBuilder.pinShot("wide");
  globalThis.__roboBuilder.jumpTo(1, 0.85); // Big Ben, 85% built in the SIM
});
await new Promise((r) => setTimeout(r, 2000));
await page.screenshot({ path: `${outDir}/pour-2s.png` });
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: `${outDir}/pour-5s.png` });
await browser.close();
console.log("pour shots written");
