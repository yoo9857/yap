// Friend taps vs digging and building when classmates stand close (players: "standing beside or inside
// a friend, my digging hit THEM instead of the block, and they kept getting flung"). Two real browsers.
//   node tools/e2e-taps.mjs [shot.png]   (needs `pnpm dev`; the png is the student's view after trying to build on the teacher)
import puppeteer from "puppeteer-core";
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const browsers = [], errors = [], results = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
async function open(query) {
  const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1100,700"] });
  browsers.push(browser);
  const page = await browser.newPage(); await page.setViewport({ width: 1100, height: 700 });
  page.on("pageerror", (e) => errors.push(e.message));
  // count the taps this page hears from the server
  await page.evaluateOnNewDocument(() => {
    const W = window.WebSocket; window.__taps = [];
    window.WebSocket = class extends W {
      constructor(...a) {
        super(...a);
        this.addEventListener("message", (e) => { if (typeof e.data === "string" && e.data.includes("\"s-k-bonk\"")) window.__taps.push(JSON.parse(e.data)); });
      }
    };
  });
  await page.goto(`${BASE}/?mode=field&reset=1${query}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  await page.addStyleTag({ content: ".game-menu{display:none!important}" });
  return page;
}
const until = (page, fn, arg, timeout = 12000) => page.waitForFunction(fn, { timeout, polling: 100 }, arg);
async function capture(page) {
  await page.bringToFront();
  if (!(await page.evaluate(() => !!document.pointerLockElement))) {
    await page.mouse.click(550, 400);
    await until(page, () => !!document.pointerLockElement);
  }
}
const click = async (page) => { await page.mouse.down({ button: "left" }); await wait(80); await page.mouse.up({ button: "left" }); };
const taps = (page) => page.evaluate(() => window.__taps.length);
/** Put a player at ABSOLUTE field coordinates (both browsers agree on these). */
// a background tab pauses its game loop (no position reports): bring it forward while it moves
const place = async (page, [ax, y, az], yaw, pitch) => {
  await page.bringToFront();
  await page.evaluate(([ax, y, az, yaw, pitch]) => {
    const c = globalThis.__roboCraft, [x, z] = (() => { const p = c.snapshot().pos, a = c.absolute(); return [ax - (a[0] - p[0]), az - (a[1] - p[2])]; })();
    c.teleport(x, y, z); c.look(yaw, pitch);
  }, [ax, y, az, yaw, pitch]);
  await wait(700);
};

try {
  const room = `Tap${Date.now().toString(36)}`;
  const teacher = await open(`&room=${room}&host=Teacher&pass=1234`);
  const student = await open(`&room=${room}&student=Student`);
  check("teacher and student are in the same class", await student.evaluate(() => globalThis.__roboCraft.classroom()?.role === "student"));
  const base = await teacher.evaluate(() => globalThis.__roboCraft.absolute().map(Math.floor));
  const [X, Z] = base, Y = 4;
  await place(teacher, [X + 0.5, Y, Z + 0.5], 0, 0);
  await student.keyboard.press("KeyQ"); // empty hands: a click digs (or taps), nothing is placed

  // 1) overlapping: the student stands inside the teacher, looking down at the ground in front
  await place(student, [X + 0.6, Y, Z + 0.55], 0, -0.9);
  await wait(900); await capture(student);
  const before1 = await taps(teacher);
  for (let i = 0; i < 4; i++) { await click(student); await wait(500); }
  check("overlapping a classmate, a dig click on the aimed block does not tap them", (await taps(teacher)) === before1, `taps ${before1} → ${await taps(teacher)}`);

  // 2) side by side, the classmate half a metre to the right, digging the ground ahead
  await place(student, [X + 0.5 - 0.55, Y, Z + 0.5], 0, -0.75);
  await wait(900); await capture(student);
  const before2 = await taps(teacher);
  for (let i = 0; i < 4; i++) { await click(student); await wait(500); }
  check("beside a classmate, a dig click on the aimed block does not tap them", (await taps(teacher)) === before2, `taps ${before2} → ${await taps(teacher)}`);

  // 3) a classmate clearly in front, crosshair on them: the tap still works
  await place(student, [X + 0.5, Y, Z + 0.5 - 1.4], 0, -0.05);
  await wait(900); await capture(student);
  console.log("tapInfo", JSON.stringify(await student.evaluate(() => globalThis.__roboCraft.tapInfo?.())));
  const before3 = await taps(teacher);
  await click(student);
  await until(teacher, (n) => window.__taps.length > n, before3).catch(() => {});
  check("a classmate in front, under the crosshair, is still tapped", (await taps(teacher)) > before3);

  // 4) the shove rests: a second tap from another angle right away lands but pushes nothing
  const rest = await teacher.evaluate(() => window.__taps.slice(-1)[0] ?? null);
  check("the first tap pushes", rest !== null && Math.hypot(rest.vx, rest.vz) > 1, JSON.stringify(rest));

  // 5) building: the student cannot drop a block into the cell the teacher stands in
  await place(teacher, [X + 0.5, Y, Z + 3.5], 0, 0);
  await place(student, [X + 0.5, Y, Z + 0.5], 0, 0);
  await wait(900);
  const placed = await student.evaluate(([ax, y, az]) => {
    const c = globalThis.__roboCraft, p = c.snapshot().pos, a = c.absolute();
    const x = ax - (a[0] - p[0]), z = az - (a[1] - p[2]);
    c.setPieceShape(0, 0, 0); c.give("stone", 4);
    const ok = c.placePiece(Math.floor(x), y, Math.floor(z), "stone");
    return { ok, block: c.blockAt(Math.floor(x), y, Math.floor(z)) };
  }, [X + 0.5, Y, Z + 3.5]);
  check("no block lands inside a classmate", placed.block === 0, JSON.stringify(placed));
  if (process.argv[2]) {
    await student.bringToFront();
    await student.evaluate(() => { const c = globalThis.__roboCraft; c.look(0.35, -0.2); });
    await wait(1200);
    await student.screenshot({ path: process.argv[2] });
  }
  const ty = await teacher.evaluate(() => globalThis.__roboCraft.snapshot().pos[1]);
  check("the classmate was not popped up", Math.abs(ty - Y) < 0.05, `y ${ty}`);
  check("no browser errors", errors.length === 0, errors.slice(0, 2).join(" | "));
} finally {
  for (const b of browsers) await b.close();
}
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} failed` : `${results.length}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
