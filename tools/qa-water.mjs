// Visual + resource QA: deep pool, waterfall, shoreline, source removal, scroll.
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
const out = process.argv[2] ?? "tmp/water-quality-after/qa";
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"] });
const errors = [], results = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("http://localhost:5173/?mode=field&reset=1", { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 60000 });
  await page.evaluate(() => {
    const game = globalThis.__roboCraft;
    const p = game.snapshot().pos, absolute = game.absolute();
    const origin = [absolute[0] - p[0], absolute[1] - p[2]];
    const grid = (x, z) => {
      const p = game.snapshot().pos, a = game.absolute();
      return [x + origin[0] - (a[0] - p[0]), z + origin[1] - (a[1] - p[2])];
    };
    const c = globalThis.__waterQa = { ...game,
      teleport: (x, y, z) => { const [gx, gz] = grid(x, z); game.teleport(gx, y, gz); },
      placeAt: (x, y, z, block) => { const [gx, gz] = grid(x, z); return game.placeAt(gx, y, gz, block); },
      mineAt: (x, y, z) => { const [gx, gz] = grid(x, z); return game.mineAt(gx, y, gz); },
    };
    for (let x = 67; x <= 80; x++) for (let z = 88; z <= 102; z++) {
      const edge = x === 67 || x === 80 || z === 88 || z === 102;
      for (let y = 1; y <= 3; y++) {
        c.mineAt(x, y, z);
        c.placeAt(x, y, z, edge || y === 1 ? "sand" : "water");
      }
    }
    // A three-cell-wide fall across x=80's chunk boundary.
    for (let x = 78; x <= 82; x++) for (let y = 4; y <= 9; y++) c.placeAt(x, y, 98, "stone");
    for (let x = 79; x <= 81; x++) c.placeAt(x, 10, 98, "water");
    c.teleport(81.5, 4, 80.5); c.look(0.1, -0.35);
  });
  await page.mouse.click(640, 500);
  await wait(4500);
  for (const [name, pos, yaw, pitch] of [
    ["overview", [81.5, 4, 80.5], 0.1, -0.35],
    ["deep-pool", [73.5, 4, 85.5], 0.15, -0.65],
    ["waterfall", [84.5, 4, 90.5], -0.15, 0.1],
    ["shoreline", [72.5, 4, 103.5], Math.PI, -0.45],
  ]) {
    await page.evaluate(([pos, yaw, pitch]) => {
      const c = globalThis.__waterQa; c.teleport(...pos); c.look(yaw, pitch);
    }, [pos, yaw, pitch]);
    await wait(900);
    await page.screenshot({ path: `${out}/${name}.png` });
  }
  await page.evaluate(() => {
    const c = globalThis.__waterQa;
    for (let x = 84; x <= 85; x++) for (let z = 92; z <= 95; z++)
      for (let y = 1; y <= 3; y++) c.mineAt(x, y, z);
    c.teleport(85.5, 4, 88.5); c.look(0.05, -0.6);
  });
  await wait(700);
  await page.screenshot({ path: `${out}/er-hole-filling.png` });
  await wait(3500);
  await page.screenshot({ path: `${out}/er-hole-settled.png` });
  await page.evaluate(() => {
    const c = globalThis.__waterQa;
    for (let z = 90; z <= 96; z++) for (let x = 98; x <= 100; x++)
      for (let y = 4; y <= z - 86; y++) c.placeAt(x, y, z, "dirt");
    c.placeAt(101, 7, 93, "oak-planks"); c.placeAt(97, 5, 91, "gold-block");
    c.placeAt(99, 11, 96, "water"); c.teleport(105.5, 5, 87.5); c.look(-0.45, -0.15);
  });
  await wait(6500);
  await page.screenshot({ path: `${out}/stairs-intact.png` });
  await page.evaluate(() => {
    const c = globalThis.__waterQa;
    c.mineAt(99, 7, 93); c.mineAt(101, 7, 93); c.mineAt(97, 5, 91);
  });
  await wait(4500);
  await page.screenshot({ path: `${out}/stairs-destroyed.png` });
  // Collect main-thread work separately from SwiftShader's software-GPU FPS.
  const samples = [];
  for (let i = 0; i < 8; i++) {
    await wait(550);
    samples.push(await page.evaluate(() => ({ perf: globalThis.__roboCraft.perf(), water: globalThis.__roboCraft.waterStats() })));
  }
  const before = samples.at(-1).perf;
  // Repeated pour/replace cycles exercise disposal and shader reuse.
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => { const c = globalThis.__waterQa; c.mineAt(87, 4, 87); c.placeAt(87, 4, 87, "water"); });
    await wait(900);
    await page.evaluate(() => globalThis.__waterQa.placeAt(87, 4, 87, "stone"));
    await wait(900);
    results.push(await page.evaluate(() => globalThis.__roboCraft.perf()));
  }
  const stablePrograms = results.every((s) => s.programs <= before.programs + 1);
  if (!stablePrograms) errors.push("shader programs grew during repeated flow edits");
  const report = { samples, cycles: results, stablePrograms, errors };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ errors, stablePrograms, latest: samples.at(-1), cycleGeometries: results.map((s) => s.geometries) }, null, 2));
  if (errors.length) process.exitCode = 1;
} finally { await browser.close(); }
