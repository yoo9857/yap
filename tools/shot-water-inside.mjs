// The camera IN water, the way it is played: third person swimming in a pond (looking up, level,
// down), and first/third person inside a fall and in the water round its foot. Prints the water
// state at each and shoots it — for judging "does it look like being in water" by eye.
//   node tools/shot-water-inside.mjs [outdir]     (needs `pnpm dev`)
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const OUT = process.argv[2] ?? "tmp/water-inside";
await mkdir(OUT, { recursive: true });
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 680 });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto(`${BASE}/?mode=field&reset=1${process.env.QUERY ?? ""}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  await page.addStyleTag({ content: ".craft-hint,.craft-hud,.game-menu{display:none!important}" });
  const frames = async (n) => { for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))); };
  const [X, Y, Z] = await page.evaluate(() => globalThis.__roboCraft.snapshot().pos.map(Math.floor));
  const cx = X, cz = Z - 14;
  await page.evaluate((cx, cz, Y) => {
    const c = globalThis.__roboCraft;
    // a pond 10 × 10, three deep
    for (let x = cx - 5; x < cx + 5; x++) for (let z = cz - 5; z < cz + 5; z++) for (let y = Y - 3; y <= Y - 1; y++) c.mineAt(x, y, z);
    for (let x = cx - 5; x < cx + 5; x++) for (let z = cz - 5; z < cz + 5; z++) c.pourAt(x, Y - 1, z);
    // a fall off a pillar onto open ground, away from the pond
    for (let y = Y; y <= Y + 4; y++) c.placeAt(cx + 14, y, cz, "stone");
    c.pourAt(cx + 14, Y + 5, cz);
  }, cx, cz, Y);
  for (let i = 0; i < 12; i++) { await frames(60); await new Promise((r) => setTimeout(r, 400)); }
  const origin = () => page.evaluate(() => { const c = globalThis.__roboCraft, a = c.absolute(), p = c.snapshot().pos; return [Math.round(a[0] - p[0]), Math.round(a[1] - p[2])]; });
  const o0 = await origin();
  const here = async (pos) => { const o = await origin(); return [pos[0] + o0[0] - o[0], pos[1], pos[2] + o0[1] - o[1]]; };
  const at = async (name, pos, yaw, pitch, first) => {
    await page.evaluate((f) => globalThis.__roboCraft.firstPerson(f), !!first);
    // hold the body there (it would sink or float away while the frames run); the first teleport
    // may scroll the field window, so the grid place is read again every time
    for (let i = 0; i < 30; i++) await page.evaluate(([p, y, pi]) => new Promise((done) => { const c = globalThis.__roboCraft; c.teleport(...p); c.look(y, pi); requestAnimationFrame(() => done()); }), [await here(pos), yaw, pitch]);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    const s = await page.evaluate(() => { const c = globalThis.__roboCraft, w = c.water(); return { underwater: w.underwater, cover: w.cover, cam: c.cameraState?.() ?? null }; });
    console.log(name, JSON.stringify(s).slice(0, 220));
  };
  const pond = [cx + 0.5, Y - 2.6, cz + 0.5];
  if (!process.env.FALL) for (const [n, pitch] of [["up", 0.6], ["level", 0], ["down", -0.6], ["steep", -1.2]]) await at(`pond-3p-${n}`, pond, Math.PI, pitch, false);
  if (!process.env.FALL) await at("pond-3p-surface", [cx + 0.5, Y - 1.2, cz + 0.5], Math.PI, -0.3, false);
  if (!process.env.FALL) await at("pond-3p-edge", [cx + 0.5, Y - 2.6, cz + 4.5], Math.PI, -0.2, false);
  if (!process.env.FALL) await at("pond-1p-level", pond, Math.PI, 0, true);
  // the fall: its column runs down the pillar's four sides
  const fall = [cx + 14.5, Y + 0.05, cz + 1.5];
  if (!process.env.LINE) for (const [n, yaw, pitch] of [["out", 0, 0], ["wall", Math.PI, 0], ["side", Math.PI / 2, 0], ["up", Math.PI, 0.9], ["down", 0, -0.8]]) await at(`fall-1p-${n}`, fall, yaw, pitch, true);
  for (const [n, yaw, pitch] of [["a", 0, -0.2], ["b", Math.PI / 2, -0.4], ["c", Math.PI, -0.6]]) await at(`fall-3p-${n}`, fall, yaw, pitch, false);
  // the third-person camera down in the shallow running water (looking up at the robot), and the
  // eye at the level of a surface: the spring on top of the pillar, the pond's waterline
  if (!process.env.LINE) for (const [n, pitch] of [["a", 0.3], ["b", 0.6], ["c", 0.9]]) await at(`stream-3p-up-${n}`, [cx + 14.5, Y + 0.05, cz + 3.5], Math.PI, pitch, false);
  for (const [n, pitch] of [["a", 0.3], ["b", 0.6]]) await at(`stream-3p-side-${n}`, [cx + 16.5, Y + 0.05, cz + 0.5], Math.PI / 2, pitch, false);
  for (const [n, dy] of [["a", 3.2], ["b", 3.3], ["c", 3.4]]) await at(`top-1p-${n}`, [cx + 14.5, Y + dy, cz + 1.5], Math.PI, 0, true);
  for (const [n, dy] of [["a", -2.45], ["b", -2.35]]) await at(`line-3p-${n}`, [cx + 0.5, Y + dy, cz + 0.5], Math.PI, 0.25, false);
  // the eye lowered through a SLOPING surface (the cell beside the fall's foot: full at the fall,
  // shallow away from it), 4 cm at a time: shot wherever the waterline is on screen
  await page.evaluate(() => globalThis.__roboCraft.firstPerson(true));
  for (const [tag, yaw] of [["away", 0], ["along", Math.PI / 2], ["fall", Math.PI]]) for (let h = 1.1; h > 0.2; h -= 0.04) {
    const cover = await page.evaluate(([p, yaw]) => new Promise((done) => {
      const c = globalThis.__roboCraft; c.teleport(...p); c.look(yaw, 0);
      requestAnimationFrame(() => requestAnimationFrame(() => done(c.water().cover)));
    }), [await here([cx + 14.5, Y + h - 1.6, cz + 2.3]), yaw]);
    if (cover > 0.05 && cover < 0.95) { await page.screenshot({ path: `${OUT}/slope-${tag}-${h.toFixed(2)}.png` }); console.log("slope", tag, h.toFixed(2), cover.toFixed(2)); }
  }
  // the eye moved sideways into the fall's side, 2 cm at a time: the wash comes in from that side
  for (let dx = -0.2; dx < 0.2; dx += 0.02) {
    const cover = await page.evaluate(([p]) => new Promise((done) => {
      const c = globalThis.__roboCraft; c.teleport(...p); c.look(Math.PI, 0);
      requestAnimationFrame(() => requestAnimationFrame(() => done(c.water().cover)));
    }), [await here([cx + 14 + dx, Y + 1.05, cz + 1.5])]);
    console.log("side", dx.toFixed(2), cover.toFixed(2));
    if (cover > 0.02 && cover < 0.98) await page.screenshot({ path: `${OUT}/side-${dx.toFixed(2)}.png` });
  }
  if (process.env.LINE) process.exit(0);
  await at("foot-1p", [cx + 14.5, Y + 0.05, cz + 2.5], Math.PI, 0.1, true);
  await at("foot-3p", [cx + 14.5, Y + 0.05, cz + 3.5], Math.PI, -0.3, false);
} finally {
  await browser.close();
}
