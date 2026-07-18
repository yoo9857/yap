// Blast Royale E2E: boot, bots live, zone shrink, win path, lose path.
// Needs `pnpm dev` running; drives dev debug hooks (__roboBattle).
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:5173/?mode=battle", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => !!globalThis.__roboBattle, { timeout: 15000 });
await sleep(800); // sample well inside the weapons-free grace window

const s0 = await page.evaluate(() => globalThis.__roboBattle.snapshot());
// HP may already have dipped once combat opens (grace can elapse during boot
// warmup), so assert the match is live with a full bot lobby and the player
// still alive — not a specific HP.
check("match boots live with 7 bots, player alive", s0.phase === "live" && s0.botsAlive === 7 && s0.hp >= 1, JSON.stringify({ phase: s0.phase, bots: s0.botsAlive, hp: s0.hp, elapsed: s0.elapsed }));
check("player spawned on the island", s0.pos[1] > 3 && s0.pos[1] < 25, JSON.stringify(s0.pos.map((v) => +v.toFixed(1))));

// bots actually move (alive simulation)
await sleep(2000);
const s1 = await page.evaluate(() => globalThis.__roboBattle.snapshot());
const moved = s1.bots.some((b, i) => Math.hypot(b.x - s0.bots[i].x, b.z - s0.bots[i].z) > 0.5);
check("bots roam the island", moved);

// zone shrinks after skipping time
await page.evaluate(() => globalThis.__roboBattle.skipTime(30));
await sleep(300);
const s2 = await page.evaluate(() => globalThis.__roboBattle.snapshot());
check("storm shrinks over time", s2.zoneRadius < s0.zoneRadius, `${s0.zoneRadius} → ${s2.zoneRadius}`);

// win path on a FRESH match, inside the weapons-free grace window so no bot
// can eliminate the player before the last kill lands
await page.goto("http://localhost:5173/?mode=battle", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => !!globalThis.__roboBattle, { timeout: 15000 });
await sleep(1200);
await page.evaluate(() => {
  for (let i = 1; i <= 7; i++) globalThis.__roboBattle.killBot(i);
});
await sleep(400);
const s3 = await page.evaluate(() => globalThis.__roboBattle.snapshot());
check("last robot standing wins", s3.phase === "won", s3.phase);
const endText = await page.evaluate(() => document.querySelector(".battle-end")?.textContent ?? "");
check("victory card shown", endText.includes("VICTORY"), endText.slice(0, 40));

// lose path on a fresh match
await page.goto("http://localhost:5173/?mode=battle", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => !!globalThis.__roboBattle, { timeout: 15000 });
await sleep(1500);
await page.evaluate(() => globalThis.__roboBattle.damagePlayer(3));
await sleep(400);
const s4 = await page.evaluate(() => globalThis.__roboBattle.snapshot());
check("player elimination ends the match", s4.phase === "lost", s4.phase);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
