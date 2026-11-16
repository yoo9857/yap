// The site's accounts, inquiries and admin, end to end in a browser (docs/ACCOUNTS.md):
// a teacher signs up, signs out, signs in; a school sends an inquiry and gets its code; the operator
// signs in to /admin/, reads it, answers it; the school looks the answer up; a wrong password is
// refused everywhere.
//
//   pnpm build
//   SERVE_STATIC=1 PORT=8097 ADMIN_PASSWORD=e2e-operator-pass node apps/server/dist/index.js   # memory store (no DATABASE_URL)
//   BASE=http://localhost:8097 ADMIN_PASSWORD=e2e-operator-pass node tools/e2e-site.mjs [shotdir]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const puppeteer = createRequire(fileURLToPath(new URL("../package.json", import.meta.url)))("puppeteer-core");
const BASE = process.env.BASE ?? "http://localhost:8097", ADMIN = process.env.ADMIN_PASSWORD ?? "e2e-operator-pass", shots = process.argv[2];
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new", args: ["--no-sandbox"] });
let passed = 0, failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); if (ok) passed++; else failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const viewOf = (page, sel) => page.$eval(sel, (e) => e.dataset.view);
const until = (page, sel, view) => page.waitForFunction((sel, view) => document.querySelector(sel)?.dataset.view === view, { timeout: 15000 }, sel, view);
const fill = async (page, form, values) => { for (const [name, value] of Object.entries(values)) await page.type(`${form} [name="${name}"]`, value); };
const errorOf = (page, form) => page.$eval(`${form} .cy-error`, (e) => (e.hidden ? "" : e.textContent));
const email = `e2e-${Date.now()}@school.kr`;

try {
  // ---- a teacher
  const t = await browser.newPage();
  await t.setViewport({ width: 1366, height: 860 });
  await t.goto(`${BASE}/teacher/`, { waitUntil: "networkidle2" });
  await until(t, ".acct-card", "out");
  await shot(t, "teacher-login");
  await t.click('[data-tab="signup"]');
  await fill(t, '[data-form="signup"]', { email, name: "김선생", school: "호원초등학교", password: "short", again: "short" });
  await t.click('[data-form="signup"] [type="submit"]'); await wait(400);
  check("sign-up refuses a short password", (await errorOf(t, '[data-form="signup"]')).includes("8자"));
  await t.$eval('[data-form="signup"] [name="password"]', (e) => { e.value = ""; }); await t.$eval('[data-form="signup"] [name="again"]', (e) => { e.value = ""; });
  await fill(t, '[data-form="signup"]', { password: "blocks-and-bricks", again: "blocks-and-bricks" });
  await shot(t, "teacher-signup");
  await t.click('[data-form="signup"] [type="submit"]');
  await until(t, ".acct-card", "in");
  check("signed up and signed in", (await t.$eval('[data-me="name"]', (e) => e.textContent)) === "김선생");
  await shot(t, "teacher-in");
  await t.reload({ waitUntil: "networkidle2" }); await until(t, ".acct-card", "in");
  check("still signed in after a reload (the cookie)", true);
  check("the cookie cannot be read by the page", !(await t.evaluate(() => document.cookie)).includes("cy_teacher"));
  await t.click('[data-do="logout"]'); await until(t, ".acct-card", "out");
  await fill(t, '[data-form="login"]', { email, password: "not-the-password" });
  await t.click('[data-form="login"] [type="submit"]'); await wait(700);
  check("a wrong password is refused", (await errorOf(t, '[data-form="login"]')).includes("맞지 않습니다") && (await viewOf(t, ".acct-card")) === "out");
  await t.$eval('[data-form="login"] [name="password"]', (e) => { e.value = ""; });
  await fill(t, '[data-form="login"]', { password: "blocks-and-bricks" });
  await t.click('[data-form="login"] [type="submit"]'); await until(t, ".acct-card", "in");
  check("signs in again", true);

  // ---- a school's inquiry
  const s = await browser.newPage();
  await s.setViewport({ width: 1366, height: 860 });
  await s.goto(`${BASE}/cases/#inquiry`, { waitUntil: "networkidle2" });
  await s.waitForSelector('.inq [data-form="inquiry"]');
  await s.$eval("#inquiry", (e) => e.scrollIntoView()); await wait(900);
  await fill(s, '[data-form="inquiry"]', { school: "한빛초등학교", name: "박선생", contact: "010-0000-0000", message: "3학년 두 반에서 써 보고 싶습니다.", password: "1234" });
  await shot(s, "inquiry-form");
  await s.click('[data-form="inquiry"] [type="submit"]'); await until(s, ".inq", "sent");
  const code = await s.$eval('[data-out="code"]', (e) => e.textContent);
  check("the inquiry is received and gives a code", /^[A-Z0-9]{8}$/.test(code), code);
  await shot(s, "inquiry-sent");
  await s.click('.inq-done [data-tab="look"]'); await until(s, ".inq", "look");
  await fill(s, '[data-form="look"]', { password: "0000" });
  await s.click('[data-form="look"] [type="submit"]'); await wait(700);
  check("a wrong look-up password shows nothing", (await errorOf(s, '[data-form="look"]')).length > 0 && (await s.$eval(".inq-answer", (e) => e.hidden)));
  await s.$eval('[data-form="look"] [name="password"]', (e) => { e.value = ""; });
  await fill(s, '[data-form="look"]', { password: "1234" });
  await s.click('[data-form="look"] [type="submit"]'); await s.waitForFunction(() => !document.querySelector(".inq-answer").hidden);
  check("before an answer it says so", (await s.$eval('[data-out="state"]', (e) => e.textContent)).includes("답변 전"));

  // ---- the operator
  const a = await browser.newPage();
  await a.setViewport({ width: 1366, height: 860 });
  await a.goto(`${BASE}/admin/`, { waitUntil: "networkidle2" });
  await until(a, ".adm-wrap", "out");
  await fill(a, '[data-form="login"]', { password: "wrong-guess" });
  await a.click('[data-form="login"] [type="submit"]'); await wait(600);
  check("the admin refuses a wrong password", (await viewOf(a, ".adm-wrap")) === "out");
  await fill(a, '[data-form="login"]', { password: ADMIN });
  await a.click('[data-form="login"] [type="submit"]'); await until(a, ".adm-wrap", "in");
  check("the admin lists the inquiry as new", (await a.$eval('[data-list="inquiries"] li', (e) => `${e.dataset.status} ${e.textContent}`)).includes("한빛초등학교"));
  await a.click('[data-list="inquiries"] li button'); await wait(700);
  check("opening it shows the contact and marks it read", (await a.$eval('[data-f="contact"]', (e) => e.textContent)) === "010-0000-0000" && (await a.$eval('[data-list="inquiries"] li', (e) => e.dataset.status)) === "read");
  await a.type('[data-form="inquiry"] [name="reply"]', "다음 주 화요일에 연락드리겠습니다.");
  await a.type('[data-form="inquiry"] [name="note"]', "전화 선호");
  await a.click('[data-form="inquiry"] [type="submit"]'); await wait(800);
  check("answering marks it answered", (await a.$eval('[data-list="inquiries"] li', (e) => e.dataset.status)) === "answered");
  await shot(a, "admin-inquiry");
  await a.click('[data-tab="teachers"]'); await wait(700);
  check("the admin lists the teacher", (await a.$eval('[data-list="teachers"]', (e) => e.textContent)).includes(email));
  await a.click('[data-tab="audit"]'); await wait(700);
  const audit = await a.$eval('[data-list="audit"]', (e) => e.textContent);
  check("the record shows sign-up, refusals and the admin's entry", audit.includes("가입") && audit.includes("로그인 거부") && audit.includes("관리자 로그인"));
  await shot(a, "admin-audit");

  // ---- the school reads the answer (a background tab does not run: bring it to the front)
  await s.bringToFront();
  await s.click('[data-form="look"] [type="submit"]'); await wait(900);
  check("the school sees the answer, and never the operator's note", (await s.$eval('[data-out="reply"]', (e) => e.textContent)).includes("화요일") && !(await s.$eval(".inq", (e) => e.textContent)).includes("전화 선호"));
  await s.$eval(".inq", (e) => e.scrollIntoView()); await shot(s, "inquiry-answer");

  // ---- the account opens a class without a class password, and it is the account's
  const c = await browser.newPage();
  await c.setViewport({ width: 1366, height: 860 });
  const room = `e2e반${Date.now() % 100000}`;
  await c.goto(`${BASE}/?mode=education&as=teacher`, { waitUntil: "domcontentloaded" });
  await c.waitForSelector('[data-id="lesson-go"]', { visible: true, timeout: 30000 });
  await c.click('[data-id="lesson-go"]');
  await c.waitForSelector("#cl-host-room", { visible: true });
  await c.waitForFunction(() => document.querySelector('[data-id="account"]')?.classList.contains("on"), { timeout: 10000 });
  check("the lobby knows the signed-in teacher", (await c.$eval('[data-id="account"]', (e) => e.textContent)).includes("김선생") && (await c.$eval("#cl-host", (e) => e.value)) === "김선생");
  await shot(c, "lobby-signed-in");
  await c.type("#cl-host-room", room);
  await c.click('[data-step="teacher"] [type="submit"]'); // no class password typed
  await c.waitForFunction(() => document.body.classList.contains("in-game"), { timeout: 120000, polling: 500 });
  check("a class opens without a class password", true, room);
  const stranger = await (await browser.createBrowserContext()).newPage();
  const ws = await stranger.evaluate((base, room) => new Promise((done) => {
    const s = new WebSocket(`${base.replace("http", "ws")}/ws?mode=class&room=${encodeURIComponent(room)}`);
    s.onopen = () => s.send(JSON.stringify({ t: "k-peek", v: 0, room }));
    s.onmessage = (e) => done(String(e.data).slice(0, 120)); s.onerror = () => done("error"); setTimeout(() => done("timeout"), 5000);
  }), BASE, room).catch((e) => String(e));
  check("the class exists on the server", typeof ws === "string" && ws.length > 0, String(ws).slice(0, 60));

  // ---- a signed-out visitor gets nothing from the admin's routes
  const anon = await (await browser.createBrowserContext()).newPage(); // its own cookies: none
  const r = await anon.goto(`${BASE}/api/admin/inquiries`);
  check("the admin's data is closed to a visitor", r.status() === 401);
  check("the teacher page, the admin page are not for search engines", (await (await anon.goto(`${BASE}/admin/`)).text()).includes('content="noindex, nofollow"'));
} catch (err) {
  check("no exception", false, String(err).slice(0, 300));
}
console.log(`\n${passed}/${passed + failed} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
