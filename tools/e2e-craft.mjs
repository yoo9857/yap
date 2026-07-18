// Craft mode E2E: island boot, mining, crafting, placing, physics, save
// round-trip. Needs `pnpm dev` running; drives dev debug hooks (__roboCraft).
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:5173/", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForSelector(".mode-btn");
const modes = await page.$$eval(".mode-btn", (els) => els.map((el) => el.dataset.mode));
check("mode selector offers craft island", modes.includes("craft"), modes.join(","));

await page.goto("http://localhost:5173/?mode=craft&reset=1", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 15000 });
await new Promise((r) => setTimeout(r, 2500));
const snap0 = await page.evaluate(() => globalThis.__roboCraft.snapshot());
check("island boots, player spawns on the surface", snap0.pos[1] > 3 && snap0.pos[1] < 25, JSON.stringify(snap0.pos.map((v) => +v.toFixed(1))));

const mined = await page.evaluate(() => {
  const s = globalThis.__roboCraft.snapshot();
  const x = Math.floor(s.pos[0]);
  const z = Math.floor(s.pos[2]);
  let y = Math.floor(s.pos[1]) - 1;
  while (y > 0 && globalThis.__roboCraft.blockAt(x, y, z) === 0) y--;
  return { ok: globalThis.__roboCraft.mineAt(x, y, z), inv: globalThis.__roboCraft.snapshot().inventory };
});
check("mining yields the block's drop", mined.ok && Object.keys(mined.inv).length > 0, JSON.stringify(mined.inv));

const crafted = await page.evaluate(() => {
  globalThis.__roboCraft.give("oak-log", 2);
  const ok = globalThis.__roboCraft.craft("planks");
  const s = globalThis.__roboCraft.snapshot();
  const x = Math.floor(s.pos[0]) + 2;
  const z = Math.floor(s.pos[2]);
  let y = 26;
  while (y > 0 && globalThis.__roboCraft.blockAt(x, y - 1, z) === 0) y--;
  const placed = globalThis.__roboCraft.placeAt(x, y, z, "oak-planks");
  return { ok, placed, inv: globalThis.__roboCraft.snapshot().inventory };
});
check("crafting planks from logs works", crafted.ok && crafted.inv["oak-planks"] >= 4, JSON.stringify(crafted.inv));
check("placing a block into the world works", crafted.placed === true);

const fall = await page.evaluate(async () => {
  globalThis.__roboCraft.teleport(24.5, 24, 24.5);
  await new Promise((r) => setTimeout(r, 1500));
  return globalThis.__roboCraft.snapshot();
});
check("gravity + landing works", fall.grounded === true && fall.pos[1] < 20, JSON.stringify(fall.pos.map((v) => +v.toFixed(1))));

await page.evaluate(() => globalThis.__roboCraft.saveNow());
await page.goto("http://localhost:5173/?mode=craft", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 15000 });
const inv2 = await page.evaluate(() => globalThis.__roboCraft.snapshot().inventory);
check("save persists across reload", (inv2["oak-planks"] ?? 0) >= 3, JSON.stringify(inv2));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
