// Holes in blocks while walking around (players: "blocks with holes here and there"). Builds a dense,
// mixed scene, walks away across many field-window scrolls and back, and at every stop asks the view
// to audit that every face bordering air is drawn (VoxelView.auditFaces). Needs `pnpm dev`.
//   node tools/e2e-holes.mjs [outdir]
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const OUT = process.argv[2] ?? "tmp/holes";
await mkdir(OUT, { recursive: true });
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
});
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 640 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?mode=field&reset=1${process.env.EXTRA_QUERY ?? ""}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  const frames = async (n) => { for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))); };
  const settle = async () => {
    await page.waitForFunction(() => globalThis.__roboCraft.chunks().queued === 0, { timeout: 30000 }).catch(() => {});
    await frames(4);
  };
  // a dense mixed scene: walls, pillars and slabs of different blocks touching each other
  const placed = await page.evaluate(() => {
    const c = globalThis.__roboCraft, [px, py, pz] = c.snapshot().pos;
    const kinds = ["stone", "red-bricks", "oak-planks", "birch-log", "white-wool", "cobblestone", "brown-mushroom", "sponge", "glass", "oak-log"];
    let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let n = 0;
    for (let i = 0; i < 260; i++) {
      const x = Math.floor(px) - 30 + Math.floor(rnd() * 60), z = Math.floor(pz) - 30 + Math.floor(rnd() * 60);
      if (Math.abs(x - px) < 2 && Math.abs(z - pz) < 2) continue;
      const w = 1 + Math.floor(rnd() * 3), d = 1 + Math.floor(rnd() * 3), h = 1 + Math.floor(rnd() * 4);
      for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) for (let dy = 0; dy < h; dy++) {
        c.placeAt(x + dx, Math.floor(py) + dy, z + dz, kinds[Math.floor(rnd() * kinds.length)]); n++;
      }
    }
    return n;
  });
  await settle();
  const audit = async (where) => {
    await settle();
    const r = await page.evaluate(() => globalThis.__roboCraft.auditFaces(12));
    return { where, ...r };
  };
  const results = [await audit("start")];
  // walk east 150 cells in 8-cell hops (field scrolls every 16) and back, auditing as we go
  const start = await page.evaluate(() => globalThis.__roboCraft.absolute());
  const route = [];
  for (let s = 8; s <= 150; s += 8) route.push(s);
  for (let s = 150; s >= 0; s -= 8) route.push(s);
  route.push(0);
  for (const step of route) {
    await page.evaluate(([ax, az]) => {
      const c = globalThis.__roboCraft, p = c.snapshot().pos, a = c.absolute();
      c.teleport(ax - (a[0] - p[0]), p[1] + 0.2, az - (a[1] - p[2]));
    }, [start[0] + step, start[1] + 0.3]);
    await frames(6);
    results.push(await audit(`east+${step}`));
  }
  const holes = results.filter((r) => r.holes.length);
  for (const r of holes.slice(0, 6)) console.log(`  holes at ${r.where}: ${JSON.stringify(r.holes.slice(0, 5))}`);
  check(`placed ${placed} blocks; every face bordering air is drawn at all ${results.length} stops`, holes.length === 0,
    holes.length ? `${holes.length} stops with holes` : `${results.reduce((s, r) => s + r.checked, 0)} faces checked`);
  if (holes.length) {
    const h = holes[0].holes[0];
    await page.evaluate(([x, y, z]) => { const c = globalThis.__roboCraft; c.teleport(x + 0.5, y + 2, z + 3.5); c.look(Math.PI, -0.5); }, h.cell);
    await frames(30);
    await page.screenshot({ path: `${OUT}/first-hole.png` });
  }
  check("no browser errors", errors.length === 0, errors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exitCode = failed ? 1 : 0;
