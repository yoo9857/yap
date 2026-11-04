// Water against shaped blocks (triangle, corner, half block, stairs): a walled pool with shapes standing
// in it and along its edge, filled from sources, shot from above and from the side.
//   node tools/shot-water-shapes.mjs [outdir]     (needs `pnpm dev`)
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const OUT = process.argv[2] ?? "tmp/water-shapes";
await mkdir(OUT, { recursive: true });
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 680 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?mode=field&reset=1`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  await page.addStyleTag({ content: ".craft-hint,.craft-hud,.game-menu{display:none!important}" });
  const frames = async (n) => { for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))); };
  const P = await page.evaluate(() => globalThis.__roboCraft.snapshot().pos.map(Math.floor));
  await page.evaluate(([X, Y, Z]) => {
    const c = globalThis.__roboCraft;
    const x0 = X - 4, x1 = X + 4, z0 = Z - 10, z1 = Z - 4;
    // a pool two deep: dig it out, wall it with stone
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { c.mineAt(x, Y - 1, z); c.mineAt(x, Y - 2, z); }
    for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) {
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) { c.placeAt(x, Y - 3, z, "stone"); continue; }
      for (let y = Y - 3; y <= Y - 1; y++) c.placeAt(x, y, z, "stone");
    }
    // shapes standing on the pool floor and along its rim (piece index, yaw, tilt)
    const put = (i, r, t, x, y, z, k) => { c.setPieceShape(i, r, t); c.give(k, 2); c.placePiece(x, y, z, k); };
    put(1, 0, 0, X - 3, Y - 2, Z - 8, "oak-planks");   // triangle on the floor
    put(2, 0, 0, X - 1, Y - 2, Z - 8, "oak-planks");   // corner
    put(4, 0, 0, X + 1, Y - 2, Z - 8, "birch-planks"); // half block
    put(5, 0, 0, X + 3, Y - 2, Z - 8, "cobblestone");  // stairs
    put(5, 2, 0, X + 3, Y - 2, Z - 6, "cobblestone");  // stairs, turned
    put(1, 2, 0, X - 3, Y - 2, Z - 6, "red-bricks");   // triangle, turned
    put(4, 0, 2, X + 1, Y - 2, Z - 6, "birch-planks"); // half block upside down
    // fill: sources along the back
    for (let x = x0; x <= x1; x += 2) { c.give("water", 1); c.placeAt(x, Y - 2, z0, "water"); }
    c.renderFlags({ robot: false });
  }, P);
  // let it flow and settle
  for (let i = 0; i < 6; i++) { await frames(60); await new Promise((r) => setTimeout(r, 500)); }
  await page.evaluate(([X, Y, Z]) => { const c = globalThis.__roboCraft; c.teleport(X + 0.5, Y + 3, Z - 2); c.look(Math.PI, -0.75); }, P);
  await frames(60);
  await page.screenshot({ path: `${OUT}/above.png` });
  await page.evaluate(([X, Y, Z]) => { const c = globalThis.__roboCraft; c.teleport(X + 6.5, Y + 0.6, Z - 3); c.look(Math.PI + 0.75, -0.35); }, P);
  await frames(60);
  await page.screenshot({ path: `${OUT}/side.png` });
  const cells = await page.evaluate(([X, Y, Z]) => { const c = globalThis.__roboCraft, out = {}; for (const [n, x, z] of [["above-half", X + 1, Z - 8], ["above-stairs", X + 3, Z - 8], ["beside-triangle", X - 2, Z - 8]]) out[n] = [c.blockAt(x, Y - 2, z), c.blockAt(x, Y - 1, z)]; return out; }, P);
  console.log(JSON.stringify({ cells, errors }));
} finally {
  await browser.close();
}
