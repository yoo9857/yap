// Education field E2E: category screen, endless flat field, building, the
// scrolling voxel window (edits survive walking away and back), save
// round-trip. Needs `pnpm dev` running; drives dev debug hooks (__roboCraft).
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const frames = (n) =>
  page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
  }, n);

// 1) category screen → education → field boots
await page.goto(`${BASE}/?play=1&reset=1`, { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForSelector('[data-pick="field"]');
const gamesHidden = await page.$eval('[data-step="games"]', (el) => el.hidden);
check("category screen shows first, game list hidden", gamesHidden);
await page.click('[data-pick="games"]');
const gameCount = await page.$$eval('[data-step="games"] [data-mode]', (els) => els.length);
check("game mode lists the four games", gameCount === 4, String(gameCount));
await page.click(".mode-back");
await page.click('[data-pick="field"]');
// education opens the class lobby: teacher / student / solo
await page.waitForSelector('[data-go="solo"]');
const lobby = await page.$$eval("[data-go]", (els) => els.map((e) => e.dataset.go).join(","));
check("education lobby offers teacher / student / solo", lobby === "teacher,student,solo", lobby);
await page.click('[data-go="solo"]');
await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 15000 });
// the hooks exist from construction; physics starts after the graphics warmup
await page.waitForFunction(() => globalThis.__roboCraft.snapshot().grounded, { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 500));
const s0 = await page.evaluate(() => globalThis.__roboCraft.snapshot());
check("field spawns grounded on the flat top", s0.grounded && s0.pos[1] === 4, JSON.stringify(s0.pos));
check("starter blocks are stocked", s0.inventory["stone-bricks"] === 999);

// 2) the ground goes on past the voxel window
const far = await page.evaluate(() => [
  globalThis.__roboCraft.blockAt(-500, 3, 9000),
  globalThis.__roboCraft.blockAt(-500, 4, 9000),
]);
check("ground exists far outside the window", far[0] !== 0 && far[1] === 0, JSON.stringify(far));

// 3) build, walk 300 m away (window scrolls many times), walk back
const placed = await page.evaluate(() => globalThis.__roboCraft.placePiece(80, 4, 84, "gold-block"));
check("placing a brick works", placed);
await page.evaluate(async () => {
  const c = globalThis.__roboCraft;
  for (let i = 0; i < 300; i++) {
    const p = c.snapshot().pos;
    c.teleport(p[0] + 1, 4, p[2]);
    await new Promise((r) => requestAnimationFrame(r));
  }
});
const away = await page.evaluate(() => globalThis.__roboCraft.snapshot().pos);
check("player stays inside the scrolling window", away[0] > 40 && away[0] < 120, JSON.stringify(away));
await page.evaluate(async () => {
  const c = globalThis.__roboCraft;
  for (let i = 0; i < 300; i++) {
    const p = c.snapshot().pos;
    c.teleport(p[0] - 1, 4, p[2]);
    await new Promise((r) => requestAnimationFrame(r));
  }
});
await frames(5);
// after 300 there and 300 back, the brick is at the same offset from the player
const backPos = await page.evaluate(() => globalThis.__roboCraft.snapshot().pos);
const brickX = Math.floor(backPos[0]) - Math.floor(s0.pos[0]) + 80;
const kept = await page.evaluate((x) => globalThis.__roboCraft.blockAt(x, 4, 84), brickX);
check("brick is still there after walking 300 m out and back", kept !== 0, `x=${brickX}`);

// 4) save round-trip
await page.evaluate(() => globalThis.__roboCraft.saveNow());
await page.goto(`${BASE}/?mode=field`, { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 15000 });
await new Promise((r) => setTimeout(r, 1500));
const reloaded = await page.evaluate((x) => globalThis.__roboCraft.blockAt(x, 4, 84), brickX);
check("brick persists across reload", reloaded !== 0);

check("no browser errors", errors.length === 0, errors.join(" | "));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
