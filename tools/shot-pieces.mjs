import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = process.argv[2] || "C:\\robo\\export\\steam";
mkdirSync(OUT, { recursive: true });
const b = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1600,900"],
});
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 900 });
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const boot = async () => {
  await p.goto("http://localhost:5173/?mode=craft&reset=1", { waitUntil: "networkidle2", timeout: 30000 });
  await p.waitForFunction(() => document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 25000 });
  await sleep(1400);
};

// ---- pass 1: all 7 shapes in a row ------------------------------------------
await boot();
const r1 = await p.evaluate(() => {
  const C = window.__roboCraft;
  const shapes = C.pieces();
  const have = ["gold-block", "diamond-block", "glowstone", "iron-block", "grass", "diamond-ore", "gold-ore"];
  have.forEach((c) => C.give(c, 40));
  const y0 = 22;
  for (let x = 22; x <= 58; x++) for (let z = 54; z <= 62; z++) C.placeAt(x, y0, z, "stone");
  const xs = [30, 33, 36, 39, 42, 45, 48];
  const placed = [];
  shapes.forEach((s, i) => {
    C.setPieceShape(i, s === "corner" || s === "slope" ? 1 : 0, 0);
    placed.push([s, C.placePiece(xs[i], y0 + 1, 57, have[i])]);
    if (s === "round" || s === "slope" || s === "1x1") C.placePiece(xs[i], y0 + 2, 57, have[i]);
  });
  C.teleport(39, y0 + 2, 61);
  C.look(Math.PI, -0.22);
  document.querySelector(".craft-hint")?.classList.add("hidden");
  return placed;
});
console.log("row:", JSON.stringify(r1));
await sleep(1500);
await p.screenshot({ path: `${OUT}\\craft-pieces.png` });
console.log("shot → craft-pieces.png");

// ---- pass 2: slope facings + tilt + a vertical bar column --------------------
await boot();
await p.evaluate(() => {
  const C = window.__roboCraft;
  const SLOPE = 6, BAR = 2;
  C.give("iron-block", 60);
  C.give("gold-block", 60);
  C.give("diamond-block", 60);
  const y0 = 22;
  for (let x = 24; x <= 54; x++) for (let z = 52; z <= 62; z++) C.placeAt(x, y0, z, "stone");
  // four horizontal facings (yaw 0-3) — grey, shading must read smooth now
  [0, 1, 2, 3].forEach((yaw, i) => {
    C.setPieceShape(SLOPE, yaw, 0);
    C.placePiece(30 + i * 4, y0 + 1, 55, "iron-block");
  });
  // tipped slopes (tilt 1-3): wall / ceiling ramps — gold
  [1, 2, 3].forEach((tilt, i) => {
    C.setPieceShape(SLOPE, 0, tilt);
    C.placePiece(32 + i * 4, y0 + 1, 59, "gold-block");
  });
  // a horizontal 1×3 bar tipped upright into a column — cyan
  C.setPieceShape(BAR, 1, 1);
  C.placePiece(48, y0 + 1, 57, "diamond-block");
  C.setPieceShape(SLOPE, 0, 0);
  C.teleport(38, y0 + 2, 61);
  C.look(Math.PI, -0.3);
  document.querySelector(".craft-hint")?.classList.add("hidden");
});
await sleep(1500);
await p.screenshot({ path: `${OUT}\\craft-slopes.png` });
console.log("shot → craft-slopes.png");
await b.close();
