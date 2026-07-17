// Landmark design gallery: screenshots every landmark fully built (plus one
// half-built with the ghost blueprint visible) for visual review.
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const outDir = process.argv[2] ?? ".";
const onlyIndex = process.argv[3] === undefined ? null : Number(process.argv[3]);

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

const landmarks = await page.evaluate(() => globalThis.__roboBuilder.landmarks());
console.log(landmarks.map((l) => `${l.id}: ${l.blocks} blocks`).join("\n"));

for (let i = 0; i < landmarks.length; i++) {
  if (onlyIndex !== null && i !== onlyIndex) continue;
  await page.evaluate((idx) => globalThis.__roboBuilder.jumpTo(idx, 0.999), i);
  // wait for the pour animation to finish so the TOP details are visible
  await page
    .waitForFunction(() => globalThis.__roboBuilder.pourDone?.() === false || true, { timeout: 100 })
    .catch(() => {});
  await page
    .waitForFunction(
      () => {
        const s = globalThis.__roboBuilder.snapshot();
        const lm = globalThis.__roboBuilder.landmarks()[s.landmarkIndex % 7];
        return s.placedBlocks >= lm.blocks - 1 || globalThis.__roboBuilder.pourDone();
      },
      { timeout: 20000, polling: 250 },
    )
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: `${outDir}/lm-${i}-${landmarks[i].id}.png` });
}

if (onlyIndex === null) {
  // one construction-in-progress shot with the ghost visible
  await page.evaluate(() => globalThis.__roboBuilder.jumpTo(3, 0.45));
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: `${outDir}/lm-ghost-eiffel.png` });
}

await browser.close();
console.log("gallery written");
