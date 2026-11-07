// Touch play (phones / tablets) on the education field, as a phone in landscape (844 × 390, touch
// only): Play from the menu, joystick walks, a drag looks, ⬆️ jumps, ⛏ digs, 🧱 places, 🎒 opens
// the bag (controls step aside) and closing it plays on, ☰ pauses.
//   node tools/e2e-touch.mjs [shotdir]     (needs the client dev server: pnpm dev, or vite alone)
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:5173";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const SHOTS = process.argv[2] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
};

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage();
await page.emulate({
  viewport: { width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true, deviceScaleFactor: 2 },
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
});
await page.goto(`${BASE}/?mode=field&reset=1&touch=1`, { waitUntil: "networkidle2", timeout: 90000 });
await page.waitForFunction(() => !!globalThis.__roboCraft?.snapshot, { timeout: 90000 });
await sleep(2500);
const snap = () => page.evaluate(() => globalThis.__roboCraft.snapshot());
const playing = () => page.evaluate(() => globalThis.__roboCraft.aimInfo().locked);
const controlsShown = () => page.evaluate(() => { const r = document.querySelector(".tc-root"); return !!r && !r.hidden; });
const center = (sel) => page.evaluate((s) => {
  const r = document.querySelector(s)?.getBoundingClientRect();
  return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}, sel);
const tapAt = async (p) => { await page.touchscreen.touchStart(p.x, p.y); await sleep(60); await page.touchscreen.touchEnd(); };
const drag = async (from, to, steps = 12, hold = 0) => {
  await page.touchscreen.touchStart(from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await page.touchscreen.touchMove(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await sleep(16);
  }
  if (hold) await sleep(hold);
  await page.touchscreen.touchEnd();
};
const shot = (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

check(await page.evaluate(() => document.body.classList.contains("touch")), "touch layout on");
check(!(await controlsShown()), "controls hidden while the menu is up");
await shot("1-menu");

const play = await center('[data-id="gm-play"]');
check(!!play, "menu has a Play button");
if (play) await tapAt(play);
await sleep(500);
check(await playing(), "Play starts touch play (no pointer lock needed)");
check(await controlsShown(), "controls shown in play");
await shot("2-play");

// joystick: thumb lands bottom-left, pushes up = forward
let before = await snap();
await drag({ x: 120, y: 240 }, { x: 120, y: 170 }, 10, 1200);
await sleep(300);
let after = await snap();
const walked = Math.hypot(after.pos[0] - before.pos[0], after.pos[2] - before.pos[2]);
check(walked > 1, "joystick walks", `${walked.toFixed(2)} m`);

// look: a drag on the view turns the camera
before = await snap();
await drag({ x: 560, y: 150 }, { x: 460, y: 150 });
after = await snap();
check(Math.abs(after.yaw - before.yaw) > 0.3, "drag looks around", `yaw ${before.yaw.toFixed(2)} → ${after.yaw.toFixed(2)}`);

// look down at the ground for digging
await drag({ x: 560, y: 120 }, { x: 560, y: 260 });
await sleep(200);

// jump
const jump = await center(".tc-jump");
const y0 = (await snap()).pos[1];
await page.touchscreen.touchStart(jump.x, jump.y);
let peak = y0;
for (let i = 0; i < 10; i++) { await sleep(40); peak = Math.max(peak, (await snap()).pos[1]); }
await page.touchscreen.touchEnd();
check(peak - y0 > 0.3, "⬆️ jumps", `+${(peak - y0).toFixed(2)} m`);
await sleep(800);

// dig: hold ⛏ on the aimed ground block
const aimBefore = await page.evaluate(() => globalThis.__roboCraft.aimInfo().voxel);
check(!!aimBefore, "aiming at the ground");
const mine = await center(".tc-mine");
await page.touchscreen.touchStart(mine.x, mine.y);
await sleep(2500);
await page.touchscreen.touchEnd();
await sleep(300);
const aimAfter = await page.evaluate(() => globalThis.__roboCraft.aimInfo().voxel);
check(!!aimBefore && JSON.stringify(aimBefore) !== JSON.stringify(aimAfter), "⛏ digs the aimed block", `${JSON.stringify(aimBefore)} → ${JSON.stringify(aimAfter)}`);

// place: tap 🧱 puts a block back where the aim is
const place = await center(".tc-place");
const aimHole = await page.evaluate(() => globalThis.__roboCraft.aimInfo().voxel);
await tapAt(place);
await sleep(400);
const aimPlaced = await page.evaluate(() => globalThis.__roboCraft.aimInfo().voxel);
check(JSON.stringify(aimHole) !== JSON.stringify(aimPlaced), "🧱 places a block", `${JSON.stringify(aimHole)} → ${JSON.stringify(aimPlaced)}`);
await shot("3-built");

// bag: opens over play, controls step aside; closing it plays on
await tapAt(await center(".tc-top button:nth-child(2)"));
await sleep(500);
check(await page.evaluate(() => !!document.querySelector('[data-id="bag-close"]')?.getClientRects().length), "🎒 opens the bag");
check(!(await controlsShown()) && !(await playing()), "controls step aside under the bag");
await shot("4-bag");
const close = await center('[data-id="bag-close"]');
if (close) await tapAt(close);
await sleep(500);
check(await playing() && (await controlsShown()), "closing the bag plays on");

// ☰ pauses to the menu card
const menuBtn = await center(".tc-top button:last-child");
await tapAt(menuBtn);
await sleep(400);
check(!(await playing()) && !(await controlsShown()), "☰ pauses");
check(await page.evaluate(() => !!document.querySelector('[data-id="gm-play"]')?.getClientRects().length), "the menu card is back");
const title = await page.evaluate(() => document.querySelector('[data-id="gm-title"]')?.textContent ?? "");
check(/일시정지|Paused/.test(title), "it reads as paused, not 'tap to start'", title);
await shot("5-paused");

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall touch checks passed");
process.exit(failed ? 1 : 0);
