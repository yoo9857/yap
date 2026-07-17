// Camera-director review: captures each cinematic shot type on one landmark.
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const outDir = process.argv[2] ?? ".";
const lmIndex = Number(process.argv[3] ?? 1); // default: Big Ben

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

// 0.9: fully recognizable but never completes mid-shoot (no parade rollover)
await page.evaluate((i) => globalThis.__roboBuilder.jumpTo(i, 0.9), lmIndex);
await new Promise((r) => setTimeout(r, 8000)); // let the pour catch up

for (const shot of ["pushIn","craneRise","spiralUp","detailOrbit","wide","frontier","flyby","lowTrack","topReveal","pullBack"]) {
  await page.evaluate((s) => globalThis.__roboBuilder.pinShot(s), shot);
  await new Promise((r) => setTimeout(r, shot === "craneRise" || shot === "pushIn" ? 6000 : 3500));
  await page.screenshot({ path: `${outDir}/shot-${shot}.png` });
}
await browser.close();
console.log("shots written");
