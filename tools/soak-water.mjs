// Water leak soak: rounds of pour → flow → take away → dry, and the camera going into and out of a
// pond (the pipeline's count pass switches on and off). GPU geometry / texture / program counts
// must come back to where they were, and the heap must not climb round after round.
//   node tools/soak-water.mjs [rounds=24]     (needs `pnpm dev`)
import puppeteer from "puppeteer-core";

const ROUNDS = Number(process.argv[2] ?? 24);
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--js-flags=--expose-gc", "--enable-precise-memory-info"] });
let ok = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 680 });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto(`${BASE}/?mode=field&reset=1`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  const frames = async (n) => { for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))); };
  const [X, Y, Z] = await page.evaluate(() => globalThis.__roboCraft.snapshot().pos.map(Math.floor));
  // a pond to dive into, kept for the whole run
  await page.evaluate((X, Y, Z) => {
    const c = globalThis.__roboCraft;
    for (let x = X - 3; x <= X + 3; x++) for (let z = Z - 12; z <= Z - 6; z++) { for (let y = Y - 2; y <= Y - 1; y++) c.mineAt(x, y, z); }
    for (let x = X - 3; x <= X + 3; x++) for (let z = Z - 12; z <= Z - 6; z++) c.pourAt(x, Y - 1, z);
    c.firstPerson(true);
  }, X, Y, Z);
  await frames(240);
  const sample = () => page.evaluate(() => { globalThis.gc?.(); const p = globalThis.__roboCraft.perf(); return { geometries: p.geometries, textures: p.textures, programs: p.programs, heapMB: p.heapMB === null ? null : +p.heapMB.toFixed(1) }; });
  const samples = [];
  for (let round = 1; round <= ROUNDS; round++) {
    await page.evaluate((X, Y, Z, round) => {
      const c = globalThis.__roboCraft;
      // springs on the ground and one in the air (a fall), a different place each round
      for (let i = 0; i < 3; i++) c.pourAt(X + 6 + i * 3, Y, Z + (round % 5));
      c.pourAt(X + 9, Y + 4, Z + 4 + (round % 3));
      c.teleport(X + 0.5, Y - 1.9, Z - 9 + 0.5); // into the pond: the count pass runs
    }, X, Y, Z, round);
    await frames(150);
    await page.evaluate((X, Y, Z, round) => {
      const c = globalThis.__roboCraft;
      // (a block set into each spring and dug out again takes the spring away: the water drains)
      const gone = (x, y, z) => { c.placeAt(x, y, z, "stone"); c.mineAt(x, y, z); };
      for (let i = 0; i < 3; i++) gone(X + 6 + i * 3, Y, Z + (round % 5));
      gone(X + 9, Y + 4, Z + 4 + (round % 3));
      c.teleport(X + 0.5, Y + 0.1, Z + 0.5); // and out
    }, X, Y, Z, round);
    await frames(150);
    if (round % 4 === 0) { const s = await sample(); samples.push(s); console.log(`round ${round}`, JSON.stringify(s)); }
  }
  const first = samples[1], last = samples[samples.length - 1];
  const flat = last.geometries <= first.geometries + 4 && last.textures <= first.textures + 1 && last.programs <= first.programs;
  const heap = first.heapMB === null || last.heapMB - first.heapMB < 12;
  ok = flat && heap;
  console.log(ok ? "PASS  counts flat, heap steady" : `FAIL  ${JSON.stringify({ first, last })}`);
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
