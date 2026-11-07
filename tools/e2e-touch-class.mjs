// Touch play in a classroom: a student on a phone (844 × 390, touch only) next to a teacher on a PC.
// The 💬 button opens the chat (play pauses while typing) and a sent line reaches the teacher;
// the controls stay out of the way of the class panel.
//   node tools/e2e-touch-class.mjs [shotdir]     (needs pnpm dev: server + client)
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:5173";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const SHOTS = process.argv[2] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ROOM = `터치반${Date.now() % 100000}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
};
const launch = () => puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox"] });

const tb = await launch();
const teacher = await tb.newPage();
await teacher.setViewport({ width: 1280, height: 800 });
await teacher.goto(`${BASE}/?mode=field&room=${encodeURIComponent(ROOM)}&host=${encodeURIComponent("김선생")}&pass=1234`, { waitUntil: "networkidle2", timeout: 90000 });
await teacher.waitForFunction(() => !!globalThis.__roboCraft?.classroom?.(), { timeout: 90000 });

const sb = await launch();
const kid = await sb.newPage();
await kid.emulate({
  viewport: { width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true, deviceScaleFactor: 2 },
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
});
await kid.goto(`${BASE}/?mode=field&room=${encodeURIComponent(ROOM)}&student=${encodeURIComponent("민지")}&touch=1`, { waitUntil: "networkidle2", timeout: 90000 });
await kid.waitForFunction(() => !!globalThis.__roboCraft?.classroom?.(), { timeout: 90000 });
await sleep(2000);
const center = (sel) => kid.evaluate((s) => {
  const r = document.querySelector(s)?.getBoundingClientRect();
  return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}, sel);
const tapAt = async (p) => { await kid.touchscreen.touchStart(p.x, p.y); await sleep(60); await kid.touchscreen.touchEnd(); };
const playing = () => kid.evaluate(() => globalThis.__roboCraft.aimInfo().locked);

await tapAt(await center('[data-id="gm-play"]'));
await sleep(500);
check(await playing(), "the student plays by touch");
const chatBtn = await kid.evaluate(() => [...document.querySelectorAll(".tc-top button")].some((b) => b.getAttribute("aria-label") === "채팅" || b.getAttribute("aria-label") === "Chat"));
check(chatBtn, "a 💬 button in a class");
if (SHOTS) await kid.screenshot({ path: `${SHOTS}/class-1-play.png` });

const chat = await kid.evaluate(() => {
  const b = [...document.querySelectorAll(".tc-top button")].find((x) => /채팅|Chat/.test(x.getAttribute("aria-label") ?? ""));
  const r = b?.getBoundingClientRect();
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
});
await tapAt(chat);
await sleep(400);
const focused = await kid.evaluate(() => document.activeElement?.classList.contains("class-chat-input") === true);
check(focused, "💬 opens the chat box");
check(!(await playing()), "play pauses while typing");
if (SHOTS) await kid.screenshot({ path: `${SHOTS}/class-2-chat.png` });
await kid.keyboard.type("안녕하세요");
await kid.keyboard.press("Enter");
await sleep(800);
check(await playing(), "sending the line plays on");
await teacher.bringToFront();
const heard = await teacher.waitForFunction(() => document.body.innerText.includes("안녕하세요"), { timeout: 5000 }).then(() => true, () => false);
check(heard, "the teacher sees the line");

// the teacher locks building: a tap on 🧱 must not place anything
await teacher.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-settings", buildLocked: true, chatLocked: false }));
await sleep(600);
await kid.bringToFront();
await sleep(300);
const canBuild = await kid.evaluate(() => globalThis.__roboCraft.classroom().canBuild);
check(canBuild === false, "a teacher's build lock reaches the touch student");

// a teacher on a tablet: no F2 key, so a 🧑‍🏫 button opens the class tools; ✕ goes back to play
const tab = await launch();
const t2 = await tab.newPage();
await t2.emulate({
  viewport: { width: 1180, height: 820, isMobile: true, hasTouch: true, isLandscape: true, deviceScaleFactor: 2 },
  userAgent: "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
});
const ROOM2 = `${ROOM}b`;
await t2.goto(`${BASE}/?mode=field&room=${encodeURIComponent(ROOM2)}&host=${encodeURIComponent("박선생")}&pass=1234&touch=1`, { waitUntil: "networkidle2", timeout: 90000 });
await t2.waitForFunction(() => !!globalThis.__roboCraft?.classroom?.(), { timeout: 90000 });
await sleep(2000);
const tap2 = async (sel) => {
  const p = await t2.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, sel);
  if (!p) return false;
  await t2.touchscreen.touchStart(p.x, p.y); await sleep(60); await t2.touchscreen.touchEnd();
  return true;
};
await tap2('[data-id="gm-play"]');
await sleep(500);
const toolsTapped = await tap2('.tc-top button[aria-label="수업 도구"]');
await sleep(500);
check(toolsTapped && (await t2.evaluate(() => globalThis.__roboCraft.classroom().toolsOpen)), "🧑‍🏫 opens the class tools on a tablet");
if (SHOTS) await t2.screenshot({ path: `${SHOTS}/class-3-tools.png` });
await tap2(".ct-x");
await sleep(500);
check(await t2.evaluate(() => !globalThis.__roboCraft.classroom().toolsOpen && globalThis.__roboCraft.aimInfo().locked), "closing them plays on");
await tab.close();

await tb.close();
await sb.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall classroom touch checks passed");
process.exit(failed ? 1 : 0);
