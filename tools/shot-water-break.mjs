// Water in MOTION: a walled tank is opened (one wall block mined), then closed again, and the
// screen is shot every ~130 ms into two contact sheets. How the stream starts, runs and dries up
// can only be judged frame by frame.
//   node tools/shot-water-break.mjs [outdir]     (needs `pnpm dev`)
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";

const OUT = process.argv[2] ?? "tmp/water-break";
await mkdir(OUT, { recursive: true });
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const QUERY = process.env.QUERY ?? ""; // e.g. QUERY="&water=finite"
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 720, height: 440 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?mode=field&reset=1${QUERY}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  await page.addStyleTag({ content: ".craft-hint,.craft-hud,.game-menu,#craft-hud,.chip,.machine-chip{display:none!important}" });
  const frames = async (n) => { for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))); };
  const [X, Y, Z] = await page.evaluate(() => globalThis.__roboCraft.snapshot().pos.map(Math.floor));
  const cx = X, cz = Z - 9;
  await page.evaluate((cx, cz, Y) => {
    const c = globalThis.__roboCraft;
    // a tank 4 × 3 inside, walls two high, filled by one bucket per cell on the floor
    for (let x = cx - 3; x <= cx + 2; x++) for (let z = cz - 2; z <= cz + 2; z++) {
      const wall = x === cx - 3 || x === cx + 2 || z === cz - 2 || z === cz + 2;
      if (wall) for (let y = Y; y <= Y + 1; y++) c.placeAt(x, y, z, "red-bricks");
    }
    for (let x = cx - 2; x <= cx + 1; x++) for (let z = cz - 1; z <= cz + 1; z++) c.pourAt(x, Y, z);
    c.renderFlags({ robot: false });
    c.teleport(cx + 0.5, Y + 3.2, cz + 7.5); c.look(Math.PI, -0.62);
  }, cx, cz, Y);
  for (let i = 0; i < 6; i++) { await frames(60); await new Promise((r) => setTimeout(r, 300)); }
  const cells = () => page.evaluate(() => globalThis.__roboCraft.water());
  const strip = async (name, act, count = Number(process.env.FRAMES ?? 24), gap = Number(process.env.GAP ?? 130)) => {
    const shots = [];
    await act();
    for (let i = 0; i < count; i++) {
      shots.push(await page.screenshot({ type: "png" }));
      await new Promise((r) => setTimeout(r, gap));
    }
    for (let i = 0; i < shots.length; i++) await writeFile(`${OUT}/${name}-${String(i).padStart(2, "0")}.png`, shots[i]);
    return (await cells());
  };
  const before = await cells();
  const opened = await strip("open", () => page.evaluate((cx, cz, Y) => { globalThis.__roboCraft.mineAt(cx, Y, cz + 2); }, cx, cz, Y));
  for (let i = 0; i < 20; i++) { await frames(30); await new Promise((r) => setTimeout(r, 250)); }
  const settled = await cells();
  const closed = await strip("close", () => page.evaluate((cx, cz, Y) => { globalThis.__roboCraft.placeAt(cx, Y, cz + 2, "red-bricks"); }, cx, cz, Y));
  for (let i = 0; i < 20; i++) { await frames(30); await new Promise((r) => setTimeout(r, 250)); }
  console.log(JSON.stringify({ errors, before, opened, settled, closed, end: await cells() }));
} finally {
  await browser.close();
}
