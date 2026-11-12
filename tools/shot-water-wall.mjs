// Water SET AGAINST A WALL: a spring on the ground beside a wall, one in a corner of two walls, one
// placed half-way up a wall (it runs down the wall). Shot from the side, from above and along the
// wall — the water must sit on the wall, no gap showing its inside.
//   node tools/shot-water-wall.mjs [outdir]     (needs `pnpm dev`)
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const OUT = process.argv[2] ?? "tmp/water-wall";
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
  const wx = X, wz = Z - 8;
  await page.evaluate((wx, wz, Y) => {
    const c = globalThis.__roboCraft;
    // a wall along x, 9 wide and 4 high, with a wing at its left end (a corner)
    for (let x = wx - 4; x <= wx + 4; x++) for (let y = Y; y < Y + 4; y++) c.placeAt(x, y, wz, "stone");
    for (let z = wz + 1; z <= wz + 2; z++) for (let y = Y; y < Y + 4; y++) c.placeAt(wx - 4, y, z, "stone");
    c.pourAt(wx - 3, Y, wz + 1);      // in the corner, on the ground
    c.pourAt(wx, Y + 2, wz + 1);      // half-way up the wall
    c.pourAt(wx + 3, Y, wz + 1);      // on the ground beside the wall
    c.renderFlags({ robot: false });
  }, wx, wz, Y);
  for (let i = 0; i < 8; i++) { await frames(60); await new Promise((r) => setTimeout(r, 400)); }
  await page.evaluate(() => globalThis.__roboCraft.firstPerson(true));
  const shot = async (name, pos, yaw, pitch) => {
    for (let i = 0; i < 20; i++) await page.evaluate(([p, y, pi]) => new Promise((done) => { const c = globalThis.__roboCraft; c.teleport(...p); c.look(y, pi); requestAnimationFrame(() => done()); }), [pos, yaw, pitch]);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(name);
  };
  // (the field window does not scroll: every stand is within a few cells of the spawn)
  await shot("front", [wx + 0.5, Y + 1.2, wz + 5.5], Math.PI, -0.35);
  await shot("above-ground-spring", [wx + 3.5, Y + 2.2, wz + 2.6], Math.PI, -1.1);
  await shot("along-wall", [wx + 5.6, Y + 0.2, wz + 1.5], Math.PI / 2, -0.25);
  await shot("above-high-spring", [wx + 0.5, Y + 4.2, wz + 2.4], Math.PI, -1.15);
  // close along the wall's face at the fall: the slot between the water and the wall would show here
  await shot("slot-a", [wx + 1.9, Y + 1.0, wz + 1.25], Math.PI / 2, 0.1);
  await shot("slot-b", [wx + 1.9, Y + 1.0, wz + 1.25], -Math.PI / 2, 0.1);
  await shot("slot-c", [wx - 0.9, Y + 1.0, wz + 1.25], Math.PI / 2, 0.1);
  await shot("slot-d", [wx - 0.9, Y + 1.0, wz + 1.25], -Math.PI / 2, 0.1);
  // the wall's END, where the water runs round the last block's corner (it was dented in there)
  await shot("end-a", [wx + 6.4, Y + 0.3, wz + 2.6], -Math.PI * 0.75, -0.45);
  await shot("end-b", [wx + 5.5, Y + 1.6, wz + 1.6], -Math.PI * 0.7, -0.9);
  await shot("corner", [wx - 1.5, Y + 1.4, wz + 3.2], Math.PI * 0.75, -0.7);
} finally {
  await browser.close();
}
