// Water where ramps, corners and stairs touch a pool WALL, seen from the water's side, from above and
// from just under the surface. Players: "the wall beside a corner/stairs breaks", "water flips".
//   node tools/shot-water-walls.mjs [outdir]     (needs `pnpm dev`)
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const OUT = process.argv[2] ?? "tmp/water-walls";
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
    const x0 = X - 4, x1 = X + 4, z0 = Z - 10, z1 = Z - 5;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { c.mineAt(x, Y - 1, z); c.mineAt(x, Y - 2, z); }
    // a tall back wall (above the surface too) and stone sides/floor
    for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) {
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) { c.placeAt(x, Y - 3, z, "stone"); continue; }
      for (let y = Y - 3; y <= (z === z0 - 1 ? Y + 1 : Y - 1); y++) c.placeAt(x, y, z, z === z0 - 1 ? "red-bricks" : "stone");
    }
    const put = (i, r, t, x, y, z, k) => { c.setPieceShape(i, r, t); c.give(k, 2); c.placePiece(x, y, z, k); };
    // against the back wall: corner, stairs (both turns), triangle; on both levels
    put(2, 0, 0, X - 3, Y - 2, z0, "oak-planks");
    put(2, 1, 0, X - 2, Y - 2, z0, "oak-planks");
    put(5, 0, 0, X, Y - 2, z0, "cobblestone");
    put(5, 2, 0, X + 1, Y - 2, z0, "cobblestone");
    put(1, 0, 0, X + 3, Y - 2, z0, "birch-planks");
    put(5, 0, 0, X - 1, Y - 1, z0, "cobblestone"); // at the surface
    put(2, 2, 0, X + 2, Y - 1, z0, "oak-planks");  // corner at the surface
    for (let x = x0; x <= x1; x += 2) { c.give("water", 1); c.placeAt(x, Y - 2, z1, "water"); }
    c.renderFlags({ robot: false });
  }, P);
  for (let i = 0; i < 8; i++) { await frames(60); await new Promise((r) => setTimeout(r, 500)); }
  const views = [
    ["front", [P[0] + 0.5, P[1] + 0.8, P[2] - 3], Math.PI, -0.45],
    ["above", [P[0] + 0.5, P[1] + 2.5, P[2] - 6], Math.PI, -1.1],
    ["low", [P[0] - 1.5, P[1] - 0.6, P[2] - 6], Math.PI + 0.25, -0.1],
    ["angle", [P[0] + 4, P[1] + 0.6, P[2] - 6.5], Math.PI + 0.9, -0.35],
  ];
  for (const [name, pos, yaw, pitch] of views) {
    await page.evaluate(([p, y, pi]) => { const c = globalThis.__roboCraft; c.teleport(...p); c.look(y, pi); }, [pos, yaw, pitch]);
    await frames(50);
    await page.screenshot({ path: `${OUT}/${name}.png` });
  }
  console.log(JSON.stringify({ errors }));
} finally {
  await browser.close();
}
