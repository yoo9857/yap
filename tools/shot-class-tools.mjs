// Screenshots of the teacher's F2 class tools at a classroom-PC size (1600 × 900): the main panel,
// the timer step, the announcement step, and a student's screen while frozen / announced to.
//   node tools/shot-class-tools.mjs <outdir> [bots]     (needs `pnpm dev`; bots: extra students as
//   plain sockets, default 30 — how the class list looks with a whole class in)
import puppeteer from "puppeteer-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WebSocket = createRequire(join(ROOT, "apps/server/package.json"))("ws");
const CLASS_V = Number(/CLASS_PROTOCOL_VERSION = (\d+)/.exec(readFileSync(join(ROOT, "packages/shared/src/protocol/classroom.ts"), "utf8"))[1]);
const BOTS = Number(process.argv[3] ?? 30);

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
// a whole class: plain sockets that join and stay (the server keeps them company with keepalives)
const NAMES = ["가은", "나연", "다인", "라희", "마루", "바다", "사랑", "아린", "자윤", "차미", "카이", "타오", "하늘", "건우", "도윤", "로운", "민준", "보람", "선우", "우진", "재희", "지호", "채원", "태윤", "하준", "현서", "예린", "윤서", "은우", "지안", "시우", "수아", "다온", "서아", "이안"];
const bots = [];
for (let i = 0; i < Math.min(BOTS, NAMES.length); i++) {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws?mode=class&room=${encodeURIComponent(ROOM)}`);
  ws.on("open", () => ws.send(JSON.stringify({ t: "k-join", v: CLASS_V, room: ROOM, student: NAMES[i] })));
  ws.on("error", () => {});
  bots.push(ws);
  await sleep(120); // the server paces new sockets per address
}
await sleep(2500);
// a few left again: the list shows offline students too
for (const ws of bots.slice(-4)) ws.close();
await sleep(800);
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
for (const ws of bots) ws.close();
for (const b of [teacher, ...kids]) await b.browser.close();
console.log(`shots in ${OUT}`);
