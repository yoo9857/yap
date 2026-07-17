// Builder-mode E2E: mode select → instant boot (no WASM) → goal card →
// gold flows → shop works → floors & goals complete → offline settlement
// modal matches the closed-form economy.
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
let page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

// ---- 1. mode selector appears on a bare URL; builder boots instantly
await page.goto("http://localhost:5173/", { waitUntil: "networkidle2", timeout: 30000 });
const modeButtons = await page.$$(".mode-btn");
check("mode selector offers the two games", modeButtons.length === 2);
const bootStart = Date.now();
await page.click('.mode-btn[data-mode="builder"]');
await page.waitForFunction(() => !!globalThis.__roboBuilder, { timeout: 10000 });
check("builder boots fast (no physics WASM)", Date.now() - bootStart < 5000, `${Date.now() - bootStart} ms`);

const snap = () => page.evaluate(() => globalThis.__roboBuilder.snapshot());

// ---- 2. the goal card + ghost blueprint are visible immediately
const goalText = await page.evaluate(
  () => document.querySelector('[data-id="goal-title"]')?.textContent ?? "",
);
check("first goal is presented immediately", goalText.includes("15 blocks"), goalText);
const hudSub = await page.evaluate(
  () => document.querySelector('[data-id="floors"]')?.textContent ?? "",
);
check("world tour HUD shows the first landmark", hudSub.includes("Pyramid"), hudSub);

// ---- 3. gold flows in by itself (the single worker delivers)
const g0 = (await snap()).gold;
await sleep(9000);
const g1 = (await snap()).gold;
check("gold accrues without any input", g1 > g0, `${g0.toFixed(1)} → ${g1.toFixed(1)}`);

// ---- 4. shop: buying a worker raises the crew & the rate
await page.evaluate(() => globalThis.__roboBuilder.addGold(1000));
await page.evaluate(() => globalThis.__roboBuilder.buy("worker"));
await page.evaluate(() => globalThis.__roboBuilder.buy("worker"));
await page.evaluate(() => globalThis.__roboBuilder.buy("speed"));
const s4 = await snap();
check("shop purchases apply", s4.workers === 3 && s4.speedLevel === 1, `workers=${s4.workers} speedLv=${s4.speedLevel}`);

// ---- 5. blocks accumulate and the goal chain advances
await page.evaluate(() => {
  globalThis.__roboBuilder.addGold(3000);
  for (let i = 0; i < 6; i++) globalThis.__roboBuilder.buy("worker");
  for (let i = 0; i < 4; i++) globalThis.__roboBuilder.buy("speed");
});
let s5 = await snap();
for (let i = 0; i < 60 && s5.goalIndex < 1; i++) {
  await sleep(1000);
  s5 = await snap();
}
check(
  "blocks fill the blueprint and the first goal completes",
  s5.totalBlocks >= 15 && s5.goalIndex >= 1,
  `blocks=${s5.totalBlocks} goalIndex=${s5.goalIndex} placed=${s5.placedBlocks}`,
);

// ---- 6. offline settlement PRECISION: craft a save on a same-origin page
// with no game code (the running game would overwrite our timestamp on
// unload), then boot and compare against the closed-form economy exactly.
// workers=4, no upgrades → cycle 7.5 s → 0.5333 blocks/s → 1920 blocks/h,
// walked through the world-tour blueprints with completion bonuses.
const landmarkMeta = await page.evaluate(() => globalThis.__roboBuilder.landmarks());
// age the save PAST the 8 h offline cap: elapsed clamps to exactly 8 h, so
// navigation time can never leak into the expected delivery count
const EXPECT_DELIVERIES = Math.floor((4 / 7.5) * 8 * 3600); // capped window
let expDeliveries = EXPECT_DELIVERIES;
let expGold = 0;
let expVoxels = 0;
let expLandmarkIndex = 0;
let expPlaced = 0;
while (expDeliveries > 0) {
  const lm = landmarkMeta[expLandmarkIndex % landmarkMeta.length];
  const need = lm.blocks - expPlaced;
  const tourMult = 1.5 ** Math.floor(expLandmarkIndex / landmarkMeta.length);
  const deliveriesNeeded = Math.ceil(need / lm.deliverySize);
  const spending = Math.min(expDeliveries, deliveriesNeeded);
  const placing = Math.min(spending * lm.deliverySize, need);
  expGold += spending * tourMult; // per-delivery value × world-tour multiplier
  expVoxels += placing;
  expPlaced += placing;
  expDeliveries -= spending;
  if (expPlaced >= lm.blocks) {
    expGold += lm.bonus * tourMult;
    expLandmarkIndex++;
    expPlaced = 0;
  }
}

// the running builder page renders ~70k instanced voxels under SwiftShader —
// navigating IT can stall, so craft the save from a fresh lightweight tab
// (and give the software renderer a moment to release the old scene)
await page.close();
await sleep(2000);
page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/__e2e_blank", {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});
await page.evaluate(() => {
  const save = {
    v: 2,
    gold: 0,
    landmarkIndex: 0,
    placedBlocks: 0,
    workers: 4,
    speedLevel: 0,
    valueLevel: 0,
    crane: false,
    goalIndex: 0,
    totalBlocks: 0,
    savedAtMs: Date.now() - 9 * 3_600_000, // beyond the 8 h cap
  };
  localStorage.setItem("robo-builder-save-v1", JSON.stringify(save));
});
await page.goto("http://localhost:5173/?mode=builder", { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForFunction(() => !!globalThis.__roboBuilder, { timeout: 60000, polling: 500 });
const modalText = await page.evaluate(
  () => document.querySelector(".b-offline-stats")?.textContent ?? "",
);
check("welcome-back modal appears after absence", modalText.length > 0, modalText.trim().replace(/\s+/g, " ").slice(0, 60));

const after = await snap();
check(
  "offline settlement matches the closed-form economy EXACTLY (landmarks + bonuses)",
  after.totalBlocks === expVoxels &&
    after.landmarkIndex === expLandmarkIndex &&
    after.placedBlocks === expPlaced &&
    Math.round(after.gold) === Math.round(expGold),
  `voxels=${after.totalBlocks}/${expVoxels} lm=${after.landmarkIndex}/${expLandmarkIndex} placed=${after.placedBlocks}/${expPlaced} gold=${Math.round(after.gold)}/${Math.round(expGold)}`,
);
check("sim is paused while the modal is open", after.paused === true);

// close the modal → sim resumes
await page.click('[data-id="ok"]');
await sleep(400);
check("closing the modal resumes the sim", (await snap()).paused === false);

await page.screenshot({
  path: (process.argv[2] ?? ".") + "/builder.png",
});
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
