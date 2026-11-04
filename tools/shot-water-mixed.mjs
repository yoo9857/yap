// Water where shaped blocks touch EACH OTHER (triangle + round, rows of shapes, clusters, against a
// wall), at the water's surface, in the pool's rim, and in a stream flowing over open ground past
// them: does the water flow into every open part and meet every face? Shots + a check that every
// shaped cell the water reaches holds it.   node tools/shot-water-mixed.mjs [outdir]  (needs `pnpm dev`)
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const OUT = process.argv[2] ?? "tmp/water-mixed";
await mkdir(OUT, { recursive: true });
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 680 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?mode=field&reset=1${process.env.EXTRA_QUERY ?? ""}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  await page.addStyleTag({ content: ".craft-hint,.craft-hud,.game-menu{display:none!important}" });
  const frames = async (n) => { for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))); };
  const P = await page.evaluate(() => globalThis.__roboCraft.snapshot().pos.map(Math.floor));
  await page.evaluate(([X, Y, Z]) => {
    const c = globalThis.__roboCraft;
    const x0 = X - 5, x1 = X + 5, z0 = Z - 11, z1 = Z - 4;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { c.mineAt(x, Y - 1, z); c.mineAt(x, Y - 2, z); }
    for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) {
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) { c.placeAt(x, Y - 3, z, "stone"); continue; }
      for (let y = Y - 3; y <= Y - 1; y++) c.placeAt(x, y, z, "stone");
    }
    const put = (i, r, t, x, y, z, k) => { if (k === undefined) { k = z; z = y; y = Y - 2; } c.setPieceShape(i, r, t); c.give(k, 2); c.placePiece(x, y, z, k); };
    // 1) triangle + round, side by side
    put(1, 0, 0, X - 4, Z - 9, "oak-planks"); put(3, 0, 0, X - 3, Z - 9, "white-wool");
    // 2) a round between two triangles facing away
    put(1, 1, 0, X - 1, Z - 9, "red-bricks"); put(3, 0, 0, X, Z - 9, "white-wool"); put(1, 3, 0, X + 1, Z - 9, "red-bricks");
    // 3) a 2x2 cluster: triangle, round, corner, round
    put(1, 2, 0, X + 3, Z - 9, "oak-planks"); put(3, 0, 0, X + 4, Z - 9, "white-wool");
    put(2, 0, 0, X + 3, Z - 8, "birch-planks"); put(3, 0, 0, X + 4, Z - 8, "white-wool");
    // 4) against the back wall: round, triangle, round
    put(3, 0, 0, X - 2, Z - 11, "white-wool"); put(1, 0, 0, X - 1, Z - 11, "oak-planks"); put(3, 0, 0, X, Z - 11, "white-wool");
    // 5) a row: triangle, round, stairs, half block
    put(1, 1, 0, X - 3, Z - 6, "red-bricks"); put(3, 0, 0, X - 2, Z - 6, "white-wool"); put(5, 1, 0, X - 1, Z - 6, "cobblestone"); put(4, 0, 0, X, Z - 6, "birch-planks");
    // 6) at the surface (the pool fills two layers): triangle + round, a round between triangles
    put(1, 1, 0, X - 4, Y - 1, Z - 7 + 0 * 0, "oak-planks"); put(3, 0, 0, X - 3, Y - 1, Z - 7, "white-wool");
    // 7) in the rim: a round and a triangle replace wall cells at the surface
    c.mineAt(x1 + 1, Y - 1, Z - 9); c.mineAt(x1 + 1, Y - 1, Z - 8);
    put(3, 0, 0, x1 + 1, Y - 1, Z - 9, "white-wool"); put(1, 3, 0, x1 + 1, Y - 1, Z - 8, "oak-planks");
    for (let x = x0; x <= x1; x += 2) { c.give("water", 2); c.placeAt(x, Y - 2, z1, "water"); c.placeAt(x, Y - 1, z1, "water"); }
    // 8) a stream on open ground: a source on the grass, triangles and rounds in its way
    const sx = X + 9, sz = Z - 2;
    put(1, 1, 0, sx + 1, Y, sz, "oak-planks"); put(3, 0, 0, sx + 2, Y, sz, "white-wool");
    put(3, 0, 0, sx, Y, sz + 1, "white-wool"); put(1, 0, 0, sx + 1, Y, sz + 1, "red-bricks");
    put(4, 0, 0, sx - 1, Y, sz, "birch-planks"); put(5, 0, 0, sx, Y, sz - 1, "cobblestone");
    c.give("water", 1); c.placeAt(sx, Y, sz, "water");
    c.renderFlags({ robot: false });
  }, P);
  for (let i = 0; i < 8; i++) { await frames(60); await new Promise((r) => setTimeout(r, 500)); }
  // every shaped cell the water reaches (a water cell beside it on an open side) must hold water
  const report = await page.evaluate(() => {
    const c = globalThis.__roboCraft, s = c.waterlogStats?.() ?? {};
    return { held: s.held, dryShaped: s.dryShaped, drawn: s.drawn };
  });
  const cells = await page.evaluate(([X, Y, Z]) => {
    const c = globalThis.__roboCraft, out = {};
    const list = { "tri+round": [[X - 4, Y - 2, Z - 9], [X - 3, Y - 2, Z - 9]], "round-between": [[X - 1, Y - 2, Z - 9], [X, Y - 2, Z - 9], [X + 1, Y - 2, Z - 9]],
      cluster: [[X + 3, Y - 2, Z - 9], [X + 4, Y - 2, Z - 9], [X + 3, Y - 2, Z - 8], [X + 4, Y - 2, Z - 8]], wall: [[X - 2, Y - 2, Z - 11], [X - 1, Y - 2, Z - 11], [X, Y - 2, Z - 11]],
      surface: [[X - 4, Y - 1, Z - 7], [X - 3, Y - 1, Z - 7]], rim: [[X + 6, Y - 1, Z - 9], [X + 6, Y - 1, Z - 8]],
      stream: [[X + 10, Y, Z - 2], [X + 11, Y, Z - 2], [X + 9, Y, Z - 1], [X + 10, Y, Z - 1], [X + 8, Y, Z - 2], [X + 9, Y, Z - 3]] };
    for (const [name, cs] of Object.entries(list)) out[name] = cs.map(([x, y, z]) => c.waterAt?.(x, y, z) || `dry:${c.blockAt(x, y, z)}`);
    return out;
  }, P);
  for (const [name, pos, yaw, pitch] of [["stream", [P[0] + 9.5, P[1] + 2.6, P[2] + 2.5], Math.PI, -0.8], ["above", [P[0] + 0.5, P[1] + 2.5, P[2] - 4], Math.PI, -1.05], ["low", [P[0] - 1.5, P[1] - 0.6, P[2] - 4.5], Math.PI, -0.18], ["angle", [P[0] + 5, P[1] + 0.4, P[2] - 5], Math.PI + 0.85, -0.3], ["rim", [P[0] + 9, P[1] + 1.6, P[2] - 7.5], Math.PI / 2 + 0.6, -0.45]]) {
    await page.evaluate(([p, y, pi]) => { const c = globalThis.__roboCraft; c.teleport(...p); c.look(y, pi); }, [pos, yaw, pitch]);
    await frames(50);
    await page.screenshot({ path: `${OUT}/${name}.png` });
  }
  // mining a shaped block that holds water leaves the water in its cell at once (no dry flash)
  const mined = await page.evaluate(([X, Y, Z]) => { const c = globalThis.__roboCraft, before = c.waterAt?.(X + 4, Y - 2, Z - 8); c.mineAt(X + 4, Y - 2, Z - 8); return [before, c.blockAt(X + 4, Y - 2, Z - 8)]; }, P);
  if (mined[0] && mined[1] !== mined[0]) cells["mined-keeps-water"] = [`dry:${mined[1]}`];
  const dry = Object.entries(cells).filter(([, v]) => v.some((id) => typeof id === "string"));
  console.log(JSON.stringify({ report, cells, errors }));
  console.log(dry.length ? `DRY: ${dry.map(([n]) => n).join(", ")}` : "every shaped cell holds water");
  process.exitCode = dry.length || errors.length ? 1 : 0;
} finally {
  await browser.close();
}
