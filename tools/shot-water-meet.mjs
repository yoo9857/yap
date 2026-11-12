// Two streams MEETING on flat ground: springs set apart so their running water meets between them
// (9, 12, 14 and 15 cells apart, straight and off-axis). Shot from above — the water must run on
// across the meeting line, no strip of another look along it. Prints the cells of each pair's row.
//   node tools/shot-water-meet.mjs [outdir]     (needs `pnpm dev`)
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const OUT = process.argv[2] ?? "tmp/water-meet";
await mkdir(OUT, { recursive: true });
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 760 });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto(`${BASE}/?mode=field&reset=1${process.env.QUERY ?? ""}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  await page.addStyleTag({ content: ".craft-hint,.craft-hud,.game-menu{display:none!important}" });
  const frames = async (n) => { for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))); };
  const [X, Y, Z] = await page.evaluate(() => globalThis.__roboCraft.snapshot().pos.map(Math.floor));
  const GAP = Number(process.env.GAP ?? 12), OFF = Number(process.env.OFF ?? 3);
  const ax = X - Math.floor(GAP / 2), bx = ax + GAP, az = Z - 10, bz = az + OFF;
  await page.evaluate((ax, az, bx, bz, Y, STEP) => {
    const c = globalThis.__roboCraft;
    c.pourAt(ax, Y, az); c.pourAt(bx, Y, bz);
    // STEP=1: a platform one block high between them with a spring on it — water of two heights
    // meets all round its foot
    if (STEP) {
      const px = Math.floor((ax + bx) / 2), pz = Math.floor((az + bz) / 2);
      for (let x = px - 2; x <= px + 2; x++) for (let z = pz - 1; z <= pz + 1; z++) c.placeAt(x, Y, z, "oak-planks");
      c.pourAt(px, Y + 1, pz);
    }
    c.renderFlags({ robot: false });
  }, ax, az, bx, bz, Y, process.env.STEP === "1");
  for (let i = 0; i < 8; i++) { await frames(60); await new Promise((r) => setTimeout(r, 400)); }
  const rows = await page.evaluate((ax, bx, az, bz, Y) => {
    const c = globalThis.__roboCraft, out = [];
    for (let z = Math.min(az, bz) - 2; z <= Math.max(az, bz) + 2; z++) { let row = ""; for (let x = ax - 2; x <= bx + 2; x++) { const id = c.blockAt(x, Y, z); row += id === 0 ? "." : id === 19 ? "S" : id >= 20 && id <= 26 ? String(id - 19) : "?"; } out.push(row); }
    return out;
  }, ax, bx, az, bz, Y);
  console.log(rows.join("\n"));
  await page.evaluate(() => globalThis.__roboCraft.firstPerson(true));
  const shot = async (name, pos, yaw, pitch) => {
    for (let i = 0; i < 20; i++) await page.evaluate(([p, y, pi]) => new Promise((done) => { const c = globalThis.__roboCraft; c.teleport(...p); c.look(y, pi); requestAnimationFrame(() => done()); }), [pos, yaw, pitch]);
    await page.screenshot({ path: `${OUT}/${name}.png` });
  };
  const mx = (ax + bx) / 2 + 0.5, mz = (az + bz) / 2 + 0.5;
  await shot(`meet-${GAP}-${OFF}-high`, [mx, Y + 7, mz + 5], Math.PI, -1.0);
  await shot(`meet-${GAP}-${OFF}-low`, [mx, Y + 1.5, mz + 6], Math.PI, -0.45);
  // (yaw π looks toward -z, -π/2 toward -x)
  await shot(`meet-${GAP}-${OFF}-side`, [mx + 1.5, Y + 1.4, mz + 5.5], Math.PI * 1.08, -0.5);
  await shot(`meet-${GAP}-${OFF}-end`, [mx + 6.5, Y + 1.0, mz + 0.5], -Math.PI / 2, -0.35);
} finally {
  await browser.close();
}
