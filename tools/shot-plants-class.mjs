// Screenshot: science mode in a classroom — a student builds a whole wind turbine (mini-games
// solved by the dev hook) and switches it on; the teacher's screen looks at it with T (science
// mode) on. On a build without classroom science, T does nothing: that is the BEFORE picture.
//   node tools/shot-plants-class.mjs <out.png>     (needs pnpm dev)
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE ?? "http://localhost:5173";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT = process.argv[2] ?? "plants-class.png";
const ROOM = `발전소반${Date.now() % 100000}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browsers = [];
const open = async (query) => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"], defaultViewport: { width: 1280, height: 800 } });
  browsers.push(browser);
  const page = await browser.newPage();
  await page.goto(`${BASE}/?mode=field&room=${encodeURIComponent(ROOM)}&${query}`, { waitUntil: "networkidle2", timeout: 90000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft?.classroom?.(), { timeout: 90000 });
  await sleep(2000);
  await page.addStyleTag({ content: ".craft-hint{display:none!important}" });
  return page;
};

const teacher = await open(`host=${encodeURIComponent("김선생")}&pass=1234`);
const kid = await open(`student=${encodeURIComponent("민지")}`);
await kid.bringToFront();
const [ax, az] = await kid.evaluate(() => globalThis.__roboCraft.absolute());
const anchor = [Math.round(ax) + 3, 4, Math.round(az) - 8];
const hasScience = await kid.evaluate(() => !!globalThis.__roboCraft.science?.());
if (hasScience) {
  await kid.evaluate((a) => globalThis.__roboCraft.scienceLay(a[0], a[1], a[2], 0), anchor);
  for (let i = 0; i < 40 && (await kid.evaluate(() => globalThis.__roboCraft.science().sites.length)) === 0; i++) await sleep(100);
  for (let socket = 0; socket < 19; socket++) {
    await kid.evaluate((s) => globalThis.__roboCraft.scienceFit(0, s), socket);
    await sleep(80);
    if ((await kid.evaluate(() => globalThis.__roboCraft.scienceGame()))?.open) {
      // a key piece's mini-game: solved by the dev hook, then its "done" beat fits the piece
      for (let i = 0; i < 60 && (await kid.evaluate(() => globalThis.__roboCraft.scienceGame().loading)); i++) await sleep(100);
      await kid.evaluate(() => globalThis.__roboCraft.scienceSolveGame());
      for (let i = 0; i < 80 && (await kid.evaluate(() => globalThis.__roboCraft.scienceGame().open)); i++) await sleep(100);
    }
  }
  const id = await kid.evaluate(() => globalThis.__roboCraft.science().sites[0]?.id);
  await kid.evaluate((i) => globalThis.__roboCraft.classSend({ t: "k-plant", op: "on", id: i }), id);
  await sleep(800);
  console.log("student's plant:", JSON.stringify(await kid.evaluate(() => globalThis.__roboCraft.science().sites.map((s) => ({ filled: s.filled, status: s.status, owner: s.owner })))));
}
await teacher.bringToFront();
// stand in front of the plant and look at its middle
await teacher.evaluate((a) => {
  const g = globalThis.__roboCraft;
  const s = g.snapshot();
  const [tx, tz] = g.absolute();
  g.teleport(s.pos[0] + (a[0] - tx) + 0.5, 4, s.pos[2] + (a[2] - tz) + 13.5);
  const eye = 4 + 1.6;
  g.look(Math.PI, Math.atan2(a[1] + 5 - eye, 13));
}, anchor);
await sleep(800);
await teacher.keyboard.press("t"); // science mode on the teacher's screen (before: T tipped a block)
await sleep(2500);
if (hasScience) console.log("teacher sees:", JSON.stringify(await teacher.evaluate(() => globalThis.__roboCraft.science().sites.map((s) => ({ filled: s.filled, status: s.status, owner: s.owner })))));
await teacher.screenshot({ path: OUT });
for (const b of browsers) await b.close();
console.log(`shot ${OUT}`);
