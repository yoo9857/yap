// The six construction shapes (F) in the field: a row of each in several turns, a staircase you can
// walk up, a mined half block, and the far (merged) form. Screenshots for review + a walk check.
//   node tools/shot-shapes.mjs [outdir]          (needs `pnpm dev`)
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const OUT = process.argv[2] ?? "tmp/shapes";
await mkdir(OUT, { recursive: true });
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox"] });
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 680 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?mode=field&reset=1`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  await page.addStyleTag({ content: ".craft-hint,.craft-hud,.game-menu{display:none!important}" });
  const frames = async (n) => { for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))); };
  const pieces = await page.evaluate(() => globalThis.__roboCraft.pieces());
  check("the shape palette is the six one-cell shapes", JSON.stringify(pieces) === JSON.stringify(["1x1", "slope", "corner-slope", "round", "slab", "stairs"]), JSON.stringify(pieces));
  const P = await page.evaluate(() => globalThis.__roboCraft.snapshot().pos.map(Math.floor));
  const Y = P[1];
  // rows: each piece in 4 turns, upright; then the half block and stairs tipped (tilt 1, 2)
  await page.evaluate(([X, Y, Z]) => {
    const c = globalThis.__roboCraft, kinds = ["oak-planks", "red-bricks", "stone", "white-wool", "birch-planks", "cobblestone"];
    for (let i = 0; i < 6; i++) for (let r = 0; r < 4; r++) { c.setPieceShape(i, r, 0); c.give(kinds[i], 4); c.placePiece(X - 6 + r * 2, Y, Z - 4 - i * 2, kinds[i]); }
    for (const [i, row] of [[4, 0], [5, 1]]) for (const tilt of [1, 2]) for (let r = 0; r < 2; r++) { c.setPieceShape(i, r, tilt); c.give(kinds[i], 4); c.placePiece(X + 4 + r * 2 + (tilt - 1) * 4, Y + (tilt === 2 ? 1 : 0), Z - 6 - row * 3, kinds[i]); }
    // a staircase going up toward −x: stairs, then stairs on a block, then a landing
    c.setPieceShape(5, 1, 0); c.give("oak-planks", 9);
    c.placePiece(X + 3, Y, Z + 3, "oak-planks");
    c.setPieceShape(0, 0, 0); c.placePiece(X + 2, Y, Z + 3, "oak-planks");
    c.setPieceShape(5, 1, 0); c.placePiece(X + 2, Y + 1, Z + 3, "oak-planks");
    c.setPieceShape(0, 0, 0); c.placePiece(X + 1, Y, Z + 3, "oak-planks"); c.placePiece(X + 1, Y + 1, Z + 3, "oak-planks");
    c.renderFlags({ robot: false });
  }, P);
  // walk the staircase: stand in front of it and hold "forward" (−x) with no jump
  await page.evaluate(() => globalThis.__roboCraft.renderFlags({ robot: true }));
  const climb = await page.evaluate(async ([X, Y, Z]) => {
    const c = globalThis.__roboCraft;
    c.teleport(X + 4.6, Y, Z + 3.5); c.look(-Math.PI / 2, -0.2); // facing −x
    const ys = [];
    for (let i = 0; i < 150; i++) { c.debugWalk?.(0, 1); await new Promise((r) => requestAnimationFrame(r)); ys.push(c.snapshot().pos[1]); }
    c.debugWalk?.(0, 0);
    let rise = 0; for (let k = 1; k < ys.length; k++) rise = Math.max(rise, ys[k] - ys[k - 1]);
    return { start: Y, top: +Math.max(...ys).toFixed(3), biggestRise: +rise.toFixed(3) };
  }, P);
  check("walks up the staircase without jumping", climb.top >= Y + 1.99 && climb.biggestRise <= 0.55, JSON.stringify(climb));
  await page.screenshot({ path: `${OUT}/3-stairs.png` });
  await frames(10);
  await page.evaluate(() => globalThis.__roboCraft.renderFlags({ robot: false }));
  await page.evaluate(([X, Y, Z]) => { const c = globalThis.__roboCraft; c.teleport(X + 0.5, Y + 4, Z + 2); c.look(Math.PI + 0.1, -0.9); }, P);
  await frames(40);
  await page.screenshot({ path: `${OUT}/1-palette.png` });
  await page.evaluate(([X, Y, Z]) => { const c = globalThis.__roboCraft; c.teleport(X + 9, Y + 2.5, Z - 3); c.look(Math.PI / 2 + 0.5, -0.45); }, P);
  await frames(40);
  await page.screenshot({ path: `${OUT}/2-tipped.png` });
  // aim at a half block: the box frames its half; then break a half block and a stairs block
  const aimed = await page.evaluate(async ([X, Y, Z]) => {
    const c = globalThis.__roboCraft;
    c.setPieceShape(4, 0, 0); c.give("stone", 2); c.placePiece(X, Y, Z - 2, "stone");
    c.setPieceShape(5, 0, 0); c.give("stone", 2); c.placePiece(X + 1, Y, Z - 2, "stone");
    c.renderFlags({ robot: false });
    c.teleport(X + 0.5, Y + 1.2, Z + 0.6); c.look(Math.PI, -0.75);
    for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));
    let box = null; c.scene().traverse((o) => { if (o.isLineSegments2 && !box && o.parent.visible) box = { y: +o.parent.position.y.toFixed(3), sy: +o.parent.scale.y.toFixed(3) }; });
    const info = c.aimInfo().voxel;
    for (const [x, p] of [[X, 0.5], [X + 1, 0.85]]) { c.mineProgress(x, Y, Z - 2, p); for (let i = 0; i < 40; i++) await new Promise((r) => requestAnimationFrame(r)); }
    const fractures = c.miningVisual().fractures;
    c.mineProgress(0, 0, 0, null);
    return { info, box, fractures, want: [X, Y, Z - 2] };
  }, P);
  await page.screenshot({ path: `${OUT}/5-aim-half.png` });
  check("the aim box frames a half block's half (not the whole cell)", aimed.box?.sy === 0.5 && Math.abs(aimed.box.y - (Y + 0.25)) < 0.01, JSON.stringify(aimed));
  check("half blocks and stairs crack when dug (fracture copies built)", aimed.fractures >= 1, JSON.stringify(aimed.fractures));
  // the far form: step back 40 m
  await page.evaluate(([X, Y, Z]) => { const c = globalThis.__roboCraft; c.renderFlags({ robot: false }); c.teleport(X + 0.5, Y + 12, Z + 34); c.look(Math.PI, -0.35); }, P);
  await page.waitForFunction(() => globalThis.__roboCraft.chunks().queued === 0, { timeout: 30000 }).catch(() => {});
  await frames(40);
  await page.screenshot({ path: `${OUT}/4-far.png` });
  const audit = await page.evaluate(() => globalThis.__roboCraft.auditFaces(5));
  check("no holes around the new shapes (every face bordering air is drawn)", audit.holes.length === 0, JSON.stringify(audit.holes.slice(0, 3)));
  check("no browser errors", errors.length === 0, errors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exitCode = failed ? 1 : 0;
