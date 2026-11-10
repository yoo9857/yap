// Science mode in a classroom (protocol v15): a teacher and two students in separate browsers.
// A student lays a wind-turbine blueprint and fits a piece; everyone sees it; a classmate may not
// change it; the teacher may; a build lock stops it; a late joiner gets the plant as it stands;
// a field reset clears it. Every change is judged by the server (k-plant / s-k-plants).
//   node tools/e2e-plants-class.mjs [shotdir]     (needs pnpm dev)
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:5173";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const SHOTS = process.argv[2] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ROOM = `발전반${Date.now() % 100000}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
};
const browsers = [];
const open = async (query) => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"], defaultViewport: { width: 1280, height: 800 } });
  browsers.push(browser);
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto(`${BASE}/?mode=field&room=${encodeURIComponent(ROOM)}&${query}`, { waitUntil: "networkidle2", timeout: 90000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft?.classroom?.() && !!globalThis.__roboCraft.science(), { timeout: 90000 });
  await sleep(1500);
  return page;
};
const sites = (p) => p.evaluate(() => globalThis.__roboCraft.science().sites.map((s) => ({ id: s.id, filled: s.filled, on: s.on, owner: s.owner, x: s.x, z: s.z })));
/** Wait (up to 4 s) until a page's plants satisfy `ok`. */
const until = async (p, ok) => {
  for (let i = 0; i < 40; i++) {
    const s = await sites(p);
    if (ok(s)) return s;
    await sleep(100);
  }
  return sites(p);
};

const teacher = await open(`host=${encodeURIComponent("김선생")}&pass=1234`);
const minji = await open(`student=${encodeURIComponent("민지")}`);
const seojun = await open(`student=${encodeURIComponent("서준")}`);

check("science mode is on in a class", (await minji.evaluate(() => globalThis.__roboCraft.science())) !== null);
check("everyone starts with no plants", (await sites(teacher)).length === 0 && (await sites(minji)).length === 0);

// 민지 lays a blueprint 6 cells beside where she stands (the field's ground tops out at y 3)
await minji.bringToFront();
const [ax, az] = await minji.evaluate(() => globalThis.__roboCraft.absolute());
const anchor = [Math.round(ax) + 6, 4, Math.round(az) + 6];
const laid = await minji.evaluate((a) => globalThis.__roboCraft.scienceLay(a[0], a[1], a[2], 0), anchor);
check("the blueprint is accepted locally", laid === null, String(laid));
const mine = await until(minji, (s) => s.length === 1);
check("the server gives it an id and 민지 sees it", mine.length === 1 && mine[0].owner === "민지", JSON.stringify(mine));
const tSites = await until(teacher, (s) => s.length === 1);
check("the teacher sees 민지's blueprint", tSites.length === 1 && tSites[0].x === anchor[0] && tSites[0].owner === "민지", JSON.stringify(tSites));

// she fits a foundation block (socket 0: no mini-game)
await minji.evaluate(() => globalThis.__roboCraft.scienceFit(0, 0));
check("the fit shows for the teacher", (await until(teacher, (s) => s[0]?.filled === 1))[0]?.filled === 1);
check("…and for a classmate", (await until(seojun, (s) => s[0]?.filled === 1))[0]?.filled === 1);

// 서준 may not change 민지's plant
await seojun.bringToFront();
const sjFit = await seojun.evaluate(() => globalThis.__roboCraft.scienceFit(0, 1));
await sleep(600);
check("a classmate can't fit into someone else's plant", sjFit === false && (await sites(teacher))[0].filled === 1);

// the teacher may
await teacher.bringToFront();
await teacher.evaluate(() => globalThis.__roboCraft.scienceFit(0, 1));
check("the teacher can help with any plant", (await until(minji, (s) => s[0]?.filled === 3))[0]?.filled === 3);

// a build lock stops 민지
await teacher.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-settings", buildLocked: true, chatLocked: false }));
await sleep(600);
await minji.bringToFront();
const lockedFit = await minji.evaluate(() => globalThis.__roboCraft.scienceFit(0, 2));
await sleep(600);
check("a build lock stops plant building", lockedFit === false && (await sites(teacher))[0].filled === 3);
await teacher.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-settings", buildLocked: false, chatLocked: false }));
await sleep(400);

// a forged change past the client's checks is still refused by the server
await seojun.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-plant", op: "remove", id: 1 }));
await sleep(600);
check("the server refuses a classmate's forged remove", (await sites(teacher)).length === 1);

// a late joiner gets the plant as it stands
const late = await open(`student=${encodeURIComponent("하린")}`);
const lateSites = await until(late, (s) => s.length === 1);
check("a late joiner sees the plant with its pieces", lateSites[0]?.filled === 3 && lateSites[0]?.owner === "민지", JSON.stringify(lateSites));
if (SHOTS) {
  // look at it from the teacher's screen
  await teacher.bringToFront();
  await teacher.evaluate((a) => {
    const g = globalThis.__roboCraft;
    const s = g.snapshot();
    const [tx, tz] = g.absolute();
    g.teleport(s.pos[0] + (a[0] - tx) + 0.5, s.pos[1], s.pos[2] + (a[2] - tz) + 9.5);
    g.look(Math.PI, 0.25);
  }, anchor);
  await sleep(1500);
  await teacher.screenshot({ path: `${SHOTS}/plants-class.png` });
}

// 민지 takes her blueprint back (X on it is the game's path; the hook sends the same message)
await minji.bringToFront();
await teacher.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-reset-world" }));
check("a field reset clears the plants for everyone", (await until(minji, (s) => s.length === 0)).length === 0 && (await until(late, (s) => s.length === 0)).length === 0);

for (const b of browsers) await b.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall classroom plant checks passed");
process.exit(failed ? 1 : 0);
