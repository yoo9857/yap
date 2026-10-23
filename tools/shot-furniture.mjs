// Furniture contact sheets: every piece photographed alone, close up, from a
// three-quarter angle, and stitched into one image per category — this is how
// a piece gets judged. The catalog test proves it fits its cells; only a
// picture proves it reads as what it is (a tub you can see INTO, a parasol
// that is open).
//   node tools/shot-furniture.mjs <outdir> [category|kind[,kind…]] [zoom]
// `zoom` > 1 moves the camera in, for judging small details.
// Writes <outdir>/furniture-<category>.png. Needs `pnpm dev` running.
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const outDir = process.argv[2];
const only = process.argv[3] && process.argv[3] !== "all" ? process.argv[3].split(",") : null;
const zoom = Number(process.argv[4] ?? 1) || 1;
if (!outDir) {
  console.error("usage: node tools/shot-furniture.mjs <outdir> [category|kind]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const TILE_W = 480;
const TILE_H = 360;
const COLS = 3;

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/?mode=field&reset=1", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 15000 });
await new Promise((r) => setTimeout(r, 2500));

// A clean frame: no HUD, and the pet parked well away from the showroom.
await page.addStyleTag({
  content: `.craft-hud,.craft-piece,.craft-hint,.pet-chip,.furn-chip,.machine-launch,.b-toast,.furn-bar,.machine-ui{display:none!important}`,
});
await page.evaluate(() => globalThis.__roboCraft.teleport(30.5, 4, 30.5));
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate(() => globalThis.__roboCraft.petToggle()); // stay, out there

// Lay every category out as a row in front of a stone wall (wall pieces hang
// on it). Positions are kept ABSOLUTE: the field scrolls its grid under the
// player, so grid coordinates go stale after the first long teleport.
const plan = await page.evaluate(async (filter) => {
  const c = globalThis.__roboCraft;
  const { CATEGORIES, inCategory } = await import("/src/craft/furniture/catalog/index.ts");
  const FLOOR = 4;
  const [ax, az] = c.absolute();
  const [px, , pz] = c.snapshot().pos;
  const ox = Math.round(ax - px);
  const oz = Math.round(az - pz);
  const shots = [];
  CATEGORIES.forEach((cat, ci) => {
    const defs = inCategory(cat.key).filter((d) => !filter || filter.includes(cat.key) || filter.includes(d.key));
    if (defs.length === 0) return;
    const z = 60 + ci * 11; // inside the 160-cell window, rows far enough apart
    let x = 100;
    for (const d of defs) {
      // stone backdrop behind this piece (and a wall to hang wall pieces on)
      for (let wx = x + 1; wx >= x - d.size.w; wx--) {
        for (let y = FLOOR; y < FLOOR + 4; y++) c.placeAt(wx, y, z + 1, "stone");
      }
      const y = d.placement === "wall" ? FLOOR + 1 : FLOOR;
      // rot 2 faces -z (toward the camera) and extends the footprint to -x/-z
      const ok = c.furniturePlace(d.key, x, y, z, 2, 0);
      const cx = x - (d.size.w - 1) / 2 + 0.5;
      const cz = z - (d.size.d - 1) / 2 + 0.5;
      const height = d.placement === "surface" ? 0.6 : d.placement === "rug" ? 0.1 : d.size.h;
      shots.push({
        key: d.key,
        name: d.name,
        category: cat.key,
        catName: cat.name,
        ok,
        cx: cx + ox,
        cy: y + height / 2,
        cz: cz + oz,
        // small table-top pieces are shot close, or they are a speck
        size: d.placement === "surface" ? 0.45 : Math.max(d.size.w, d.size.d, height),
      });
      x -= d.size.w + 3;
    }
  });
  return shots;
}, only);

// first person: the robot would stand in every shot
await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "v", code: "KeyV", bubbles: true })));

const tiles = new Map();
for (const s of plan) {
  if (!s.ok) console.log(`! ${s.key} could not be placed`);
  await page.evaluate((shot, zoomIn) => {
    const c = globalThis.__roboCraft;
    const [ax, az] = c.absolute();
    const [px, , pz] = c.snapshot().pos;
    const ox = Math.round(ax - px);
    const oz = Math.round(az - pz);
    // stand front-left of the piece, far enough to frame it
    const dist = (1.2 + shot.size * 0.95) / zoomIn;
    const len = Math.hypot(0.5, 1);
    const gx = shot.cx - ox - (0.5 / len) * dist;
    const gz = shot.cz - oz - (1 / len) * dist;
    c.teleport(gx, 4, gz);
    const eye = 4 + 1.55;
    c.look(Math.atan2(shot.cx - ox - gx, shot.cz - oz - gz), Math.atan2(shot.cy - eye, dist));
  }, s, zoom);
  await new Promise((r) => setTimeout(r, 900));
  const data = await page.screenshot({ clip: { x: 240, y: 130, width: 800, height: 600 }, encoding: "base64" });
  if (!tiles.has(s.category)) tiles.set(s.category, []);
  tiles.get(s.category).push({ label: `${s.name} · ${s.key}`, data, catName: s.catName });
}

// Stitch each category into one sheet, in a blank page's canvas.
const sheetPage = await browser.newPage();
for (const [category, list] of tiles) {
  const png = await sheetPage.evaluate(
    async (items, tw, th, cols) => {
      const rows = Math.ceil(items.length / cols);
      const head = 44;
      const canvas = document.createElement("canvas");
      canvas.width = tw * cols;
      canvas.height = head + rows * (th + 26);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fdf7e6";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#1f1f1f";
      ctx.font = "bold 24px sans-serif";
      ctx.fillText(items[0].catName, 14, 31);
      for (let i = 0; i < items.length; i++) {
        const img = new Image();
        img.src = `data:image/png;base64,${items[i].data}`;
        await img.decode();
        const x = (i % cols) * tw;
        const y = head + Math.floor(i / cols) * (th + 26);
        ctx.drawImage(img, x + 2, y, tw - 4, th);
        ctx.fillStyle = "#1f1f1f";
        ctx.font = "bold 16px sans-serif";
        ctx.fillText(items[i].label, x + 8, y + th + 19);
      }
      return canvas.toDataURL("image/png").split(",")[1];
    },
    list,
    TILE_W,
    TILE_H,
    COLS,
  );
  const path = `${outDir}/furniture-${category}.png`;
  writeFileSync(path, Buffer.from(png, "base64"));
  console.log(path);
}
await browser.close();
