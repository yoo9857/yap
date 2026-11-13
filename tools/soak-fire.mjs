// Fire drill leak soak: the drill is put back to its start again and again, its fire run up to a
// full blaze each time, the quiz opened, played and closed, the quiz board's prompt shown — and
// after every round the GPU's counts (geometries, textures, programs), the page's elements and the
// JS heap (after a forced collection) are read. They must come back to where they were: a count
// that climbs round after round is a leak. Needs `pnpm dev`.
//
//   node tools/soak-fire.mjs [rounds]
import puppeteer from "puppeteer-core";

const ROUNDS = Number(process.argv[2] ?? 24);
const URL = process.env.URL ?? "http://localhost:5173/?mode=field&theme=fire&reset=1";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--js-flags=--expose-gc", "--window-size=1280,760"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => globalThis.__roboCraft?.fire?.(), { timeout: 120000 });
await sleep(4000);
await page.evaluate(() => globalThis.__roboCraft.firePlay(true));

const sample = () => page.evaluate(() => {
  globalThis.gc?.();
  const p = globalThis.__roboCraft.perf();
  return { geometries: p.geometries, textures: p.textures, programs: p.programs, elements: document.getElementsByTagName("*").length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10 };
});
const round = async () => {
  // the drill from its start, its fire run up to a full blaze and deep smoke
  await page.evaluate(() => { const c = globalThis.__roboCraft; c.fireRestart(); c.firePlay(true); });
  for (const time of [20, 90, 200]) {
    await page.evaluate((time) => globalThis.__roboCraft.fireSet({ time, smokeClock: time, air: 1 }), time);
    await sleep(350);
  }
  // the quiz: opened, every round played, closed
  await page.evaluate(async () => {
    const rules = await import("/src/craft/fire/quizRules.ts");
    const { openQuizPanel } = await import("/src/craft/fire/fireQuiz.ts");
    const panel = openQuizPanel(rules.quizRounds(1 + Math.floor(Math.random() * 999)), { progress() {}, close() {} });
    for (let i = 0; i < 5; i++) { panel.answer(i % 2 === 0); await new Promise((r) => setTimeout(r, 30)); }
    panel.close();
  });
  await sleep(150);
};

// Before anything is judged the game finishes what it builds in idle time (furniture looks, chunk
// forms): two rounds are played, then the counts must hold still for five seconds (60 s at most).
await round(); await round();
for (let still = 0, was = -1, waited = 0; still < 5 && waited < 60; waited++) {
  await sleep(1000);
  const now = (await sample()).geometries;
  still = now === was ? still + 1 : 0;
  was = now;
}
const rows = [await sample()];
console.log("start ", JSON.stringify(rows[0]));
for (let i = 1; i <= ROUNDS; i++) {
  await round();
  rows.push(await sample());
  console.log(`round ${String(i).padStart(2)}`, JSON.stringify(rows[i]));
}
await browser.close();

// Judged on the LAST rounds against the ones before them. The first rounds still fill caches
// (pictures, compiled shaders, chunk forms the restarts walk into: the geometry count climbs in
// steps to about 200 and stays), so "no higher than round 3" called a filling cache a leak; a leak
// is a count still climbing at the end.
const mean = (key, a, b) => rows.slice(a, b).reduce((sum, r) => sum + r[key], 0) / (b - a);
const tail = Math.max(2, Math.floor(ROUNDS / 4));
let bad = 0;
for (const key of ["geometries", "textures", "programs", "elements"]) {
  const before = mean(key, ROUNDS + 1 - 2 * tail, ROUNDS + 1 - tail), after = mean(key, ROUNDS + 1 - tail, ROUNDS + 1);
  const ok = after - before < 1;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${key} do not climb — ${before.toFixed(1)} → ${after.toFixed(1)} (rounds ${ROUNDS + 1 - 2 * tail}‥${ROUNDS - tail} against the last ${tail})`);
}
// (the heap by the same two windows: one sample right after a round can be 15 MB of garbage the
// forced collection did not get to, gone again by the next)
const heapBefore = mean("heapMB", ROUNDS + 1 - 2 * tail, ROUNDS + 1 - tail), heapAfter = mean("heapMB", ROUNDS + 1 - tail, ROUNDS + 1);
const perRound = (heapAfter - heapBefore) / tail;
const heapOk = perRound < 0.8;
if (!heapOk) bad++;
console.log(`${heapOk ? "PASS" : "FAIL"}  the heap does not climb — ${heapBefore.toFixed(1)} → ${heapAfter.toFixed(1)} MB (${perRound.toFixed(2)} MB a round)`);
const clean = errors.length === 0;
if (!clean) bad++;
console.log(`${clean ? "PASS" : "FAIL"}  no page errors${clean ? "" : ` — ${errors[0]}`}`);
process.exit(bad ? 1 : 0);
