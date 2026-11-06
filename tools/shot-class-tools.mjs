// Screenshots of the teacher's F2 class tools at a classroom-PC size (1600 × 900): the main panel,
// the timer step, the announcement step, and a student's screen while frozen / announced to.
//   node tools/shot-class-tools.mjs <outdir>     (needs `pnpm dev`)
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "shots-class-tools";
const BASE = process.env.BASE ?? "http://localhost:5173";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const ROOM = `도구반${Date.now() % 100000}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const open = async (url) => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: "new",
    args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1600,900"],
    defaultViewport: { width: 1600, height: 900 },
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft?.classroom?.(), { timeout: 60000 });
  await sleep(2500);
  await page.addStyleTag({ content: ".craft-hint{display:none!important}" });
  return { browser, page };
};

const teacher = await open(`${BASE}/?mode=field&room=${encodeURIComponent(ROOM)}&host=${encodeURIComponent("김선생")}&pass=1234`);
const kids = [];
for (const name of ["민지", "서준", "하린"]) kids.push(await open(`${BASE}/?mode=field&room=${encodeURIComponent(ROOM)}&student=${encodeURIComponent(name)}`));
const t = teacher.page;
await t.bringToFront();
await t.keyboard.press("F2");
await sleep(400);
await t.keyboard.press("1"); // seat them, so the roster and chips have something to say
await sleep(1500);
await t.keyboard.press("F2");
await sleep(500);
await t.screenshot({ path: `${OUT}/f2-main.png` });
await t.keyboard.press("5");
await sleep(600);
await t.keyboard.press("F2");
await sleep(200);
await t.keyboard.press("6");
await sleep(400);
await t.screenshot({ path: `${OUT}/f2-timer.png` });
await t.keyboard.press("3");
await sleep(600);
await t.keyboard.press("F2");
await sleep(400);
await t.screenshot({ path: `${OUT}/f2-busy.png` });
await t.keyboard.press("7");
await sleep(400);
await t.screenshot({ path: `${OUT}/f2-announce.png` });
await t.keyboard.press("1");
await sleep(500);
const kid = kids[0].page;
await kid.bringToFront();
await sleep(600);
await kid.screenshot({ path: `${OUT}/student-announce-frozen.png` });
await sleep(6500);
await kid.screenshot({ path: `${OUT}/student-frozen.png` });
await t.bringToFront();
await sleep(300);
await t.screenshot({ path: `${OUT}/teacher-view.png` });
for (const b of [teacher, ...kids]) await b.browser.close();
console.log(`shots in ${OUT}`);
