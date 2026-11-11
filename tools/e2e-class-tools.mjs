// The teacher's per-student and class tools (kids' feedback 2026-11-11), a teacher and two
// students in separate browsers: one plot's water out, one plot back to grass (a buried student is
// lifted, the neighbour's plot is untouched), power plants locked for students, pets off for the
// class, and the teacher's way back up out of a shaft.
//   node tools/e2e-class-tools.mjs     (needs pnpm dev)
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE ?? "http://localhost:5173";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const ROOM = `도구반${Date.now() % 100000}`;
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
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/?mode=field&room=${encodeURIComponent(ROOM)}&${query}`, { waitUntil: "networkidle2", timeout: 90000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft?.classroom?.(), { timeout: 90000 });
  await sleep(1500);
  return page;
};
/** Poll a page until `fn` (run in the page) is truthy, up to `ms`. */
const until = async (page, fn, arg, ms = 5000) => {
  for (let i = 0; i < ms / 100; i++) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    await sleep(100);
  }
  return page.evaluate(fn, arg);
};
const cell = (page) => page.evaluate(() => { const c = globalThis.__roboCraft, p = c.snapshot().pos.map(Math.floor), a = c.absolute(); return { g: p, a: [Math.floor(a[0]), p[1], Math.floor(a[1])] }; });
const at = (page, a) => page.evaluate((a) => globalThis.__roboCraft.blockAtAbs(a[0], a[1], a[2]), a);

try {
  const teacher = await open(`host=${encodeURIComponent("김선생")}&pass=1234`);
  const minji = await open(`student=${encodeURIComponent("민지")}`);
  const seojun = await open(`student=${encodeURIComponent("서준")}`);

  // seat the class: each student is sent onto a plot of their own
  await teacher.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-arrange", yaw: 0 }));
  await sleep(2500);
  for (const p of [minji, seojun]) { await p.bringToFront(); await sleep(600); }
  const m = await cell(minji), s = await cell(seojun);
  check("both students stand on their own plots", Math.hypot(m.a[0] - s.a[0], m.a[2] - s.a[2]) > 6, JSON.stringify([m.a, s.a]));

  // each builds on their plot: a block and a bucket over their head, and 민지 digs under herself
  const build = (page, c) => page.evaluate((g) => {
    const r = globalThis.__roboCraft;
    r.give("stone", 4); r.placeAt(g[0], g[1] + 3, g[2], "stone");
    r.pourAt(g[0], g[1] + 5, g[2]);
  }, c.g);
  await minji.bringToFront(); await build(minji, m);
  await seojun.bringToFront(); await build(seojun, s);
  const mBlock = [m.a[0], m.a[1] + 3, m.a[2]], mWater = [m.a[0], m.a[1] + 5, m.a[2]];
  const sBlock = [s.a[0], s.a[1] + 3, s.a[2]], sWater = [s.a[0], s.a[1] + 5, s.a[2]];
  await teacher.bringToFront();
  check("the teacher sees 민지's block and water", await until(teacher, (a) => globalThis.__roboCraft.blockAtAbs(a[0][0], a[0][1], a[0][2]) !== 0 && globalThis.__roboCraft.blockAtAbs(a[1][0], a[1][1], a[1][2]) === 19, [mBlock, mWater]));

  // 2. 민지's plot only: the water out
  await teacher.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-plot", name: "민지", op: "drain" }));
  await minji.bringToFront();
  check("drain: 민지's water is gone", await until(minji, (a) => globalThis.__roboCraft.blockAtAbs(a[0], a[1], a[2]) === 0, mWater));
  check("drain: her block stays", (await at(minji, mBlock)) !== 0);
  await seojun.bringToFront(); await sleep(400);
  check("drain: 서준's water is untouched", (await at(seojun, sWater)) === 19, String(await at(seojun, sWater)));

  // 5. 민지's plot only: back to grass — while she stands in a hole she dug
  await minji.bringToFront();
  await minji.evaluate((g) => { const r = globalThis.__roboCraft; r.mineAt(g[0], g[1] - 1, g[2]); r.mineAt(g[0], g[1] - 2, g[2]); }, m.g);
  await until(minji, (y) => globalThis.__roboCraft.snapshot().pos[1] < y - 1.5, m.g[1]);
  const down = await minji.evaluate(() => globalThis.__roboCraft.snapshot().pos[1]);
  await teacher.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-plot", name: "민지", op: "reset" }));
  check("reset: 민지's block is gone", await until(minji, (a) => globalThis.__roboCraft.blockAtAbs(a[0], a[1], a[2]) === 0, mBlock));
  check("reset: the hole is ground again", await until(minji, (a) => globalThis.__roboCraft.blockAtAbs(a[0], a[1] - 1, a[2]) !== 0, m.a));
  const up = await until(minji, (y) => { const now = globalThis.__roboCraft.snapshot().pos[1]; return now > y - 0.3 ? now : 0; }, m.g[1]);
  check("reset: she is lifted out of the refilled hole", up > m.g[1] - 0.3, `was ${down.toFixed(2)}, now ${Number(up).toFixed(2)}, ground ${m.g[1]}`);
  await teacher.bringToFront();
  check("reset: the teacher sees the plot empty", await until(teacher, (a) => globalThis.__roboCraft.blockAtAbs(a[0], a[1], a[2]) === 0, mBlock));
  await seojun.bringToFront(); await sleep(400);
  check("reset: 서준's block and water are untouched", (await at(seojun, sBlock)) !== 0 && (await at(seojun, sWater)) === 19);

  // 4. power plants locked: a student cannot lay one (and is told why); unlocked, they can
  await seojun.bringToFront();
  // the plot runs away from the teacher: find which way by laying one blueprint while it is allowed
  // (scienceLay takes ABSOLUTE field coordinates, like the wire)
  let way = null;
  for (const d of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const r = await seojun.evaluate((g, d) => globalThis.__roboCraft.scienceLay(g[0] + d[0] * 6, g[1], g[2] + d[1] * 6, 0), s.a, d);
    if (r === null) { way = d; break; }
  }
  check("unlocked: a student lays a blueprint on their plot", way !== null && (await until(seojun, () => globalThis.__roboCraft.science().sites.length === 1)), JSON.stringify(way));
  await teacher.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-settings", chatLocked: false, buildLocked: false, plantsLocked: true }));
  await sleep(800);
  const side = way ? [way[0] * 6 + way[1] * 5, way[1] * 6 + way[0] * 5] : [0, 0]; // beside the first one, still on the plot
  const refused = await seojun.evaluate((g, o) => globalThis.__roboCraft.scienceLay(g[0] + o[0], g[1], g[2] + o[1], 0), s.a, side);
  await sleep(1200);
  const plants = await seojun.evaluate(() => globalThis.__roboCraft.science().sites.length);
  // (the page may accept it for a moment: the server is what refuses, and nothing is built)
  check("plants locked: a second blueprint does not get built", plants === 1, `${JSON.stringify(refused)}, ${plants} plants`);
  // and the server refuses it too, whatever the page thinks
  await seojun.evaluate((g, o) => globalThis.__roboCraft.classSend({ t: "k-plant", op: "lay", kind: "wind", x: g[0] + o[0], y: g[1], z: g[2] + o[1], rot: 0 }), s.a, side);
  await sleep(1000);
  check("plants locked: the server refuses a forged one", (await teacher.evaluate(() => globalThis.__roboCraft.science().sites.length)) === 1);
  await teacher.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-settings", chatLocked: false, buildLocked: false, plantsLocked: false }));
  await sleep(800);
  const allowed = await seojun.evaluate((g, o) => globalThis.__roboCraft.scienceLay(g[0] + o[0], g[1], g[2] + o[1], 0), s.a, side);
  check("plants unlocked again: it goes down", allowed === null && (await until(seojun, () => globalThis.__roboCraft.science().sites.length === 2)), JSON.stringify(allowed));

  // 1. pets off for the class
  check("pets start on", (await seojun.evaluate(() => globalThis.__roboCraft.petsOff())) === false);
  await teacher.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-settings", chatLocked: false, buildLocked: false, petsOff: true }));
  check("pets off reaches a student", await until(seojun, () => globalThis.__roboCraft.petsOff()));
  await sleep(600);
  const hidden = await seojun.evaluate(() => {
    const chip = [...document.querySelectorAll("button, .chip")].find((e) => /입양|Adopt/.test(e.textContent ?? ""));
    return { chip: chip ? getComputedStyle(chip).display !== "none" && chip.getBoundingClientRect().width > 0 : false };
  });
  check("pets off: the adoption chip is gone", hidden.chip === false, JSON.stringify(hidden));
  const late = await open(`student=${encodeURIComponent("하늘")}`);
  check("pets off: a late joiner starts without a pet", (await late.evaluate(() => globalThis.__roboCraft.petsOff())) === true);
  await teacher.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-settings", chatLocked: false, buildLocked: false, petsOff: false }));
  check("pets back on", await until(seojun, () => !globalThis.__roboCraft.petsOff()));

  // 3. the teacher, at the bottom of a shaft they dug
  await teacher.bringToFront();
  // (stand on ONE cell: a body over a cell boundary rests on the neighbour and never drops)
  await teacher.evaluate(() => { const r = globalThis.__roboCraft, p = r.snapshot().pos.map(Math.floor); r.teleport(p[0] + 0.5, p[1] + 0.05, p[2] + 0.5); });
  await sleep(400);
  const t0 = await cell(teacher);
  const openY = await teacher.evaluate(() => { globalThis.__roboCraft.rescue(); return globalThis.__roboCraft.snapshot().pos[1]; });
  check("rescue: standing in the open, nothing happens", Math.abs(openY - t0.g[1]) < 0.3, `${openY}`);
  await teacher.evaluate((g) => { const r = globalThis.__roboCraft; for (let d = 1; d <= 3; d++) r.mineAt(g[0], g[1] - d, g[2]); }, t0.g);
  await until(teacher, (y) => globalThis.__roboCraft.snapshot().pos[1] < y - 2.5, t0.g[1]);
  const bottom = await teacher.evaluate(() => globalThis.__roboCraft.snapshot().pos[1]);
  await teacher.evaluate(() => globalThis.__roboCraft.rescue());
  await sleep(500);
  const out = await teacher.evaluate(() => ({ y: globalThis.__roboCraft.snapshot().pos[1], grounded: globalThis.__roboCraft.snapshot().grounded }));
  check("rescue: the teacher is back on the ground", bottom < t0.g[1] - 2.5 && out.y > t0.g[1] - 0.3, `shaft ${bottom.toFixed(2)} → ${out.y.toFixed(2)} (ground ${t0.g[1]})`);
  await teacher.evaluate(() => globalThis.__roboCraft.rescue());
  await sleep(300);
  check("rescue: pressed again, nothing moves", Math.abs((await teacher.evaluate(() => globalThis.__roboCraft.snapshot().pos[1])) - out.y) < 0.6);
  // a tunnel: walk-able both ways, but earth over the head
  await teacher.evaluate((g) => { const r = globalThis.__roboCraft; for (let d = 2; d <= 5; d++) for (let h = 1; h <= 2; h++) r.mineAt(g[0] + d, g[1] - 1 - h, g[2]); r.teleport(g[0] + 3.5, g[1] - 3 + 0.05, g[2] + 0.5); }, t0.g);
  await sleep(500);
  await teacher.evaluate(() => globalThis.__roboCraft.rescue());
  await sleep(400);
  const fromTunnel = await teacher.evaluate(() => globalThis.__roboCraft.snapshot().pos[1]);
  check("rescue: out of a tunnel with earth overhead", fromTunnel > t0.g[1] - 0.3 && fromTunnel < t0.g[1] + 1.2, `${fromTunnel}`);

  const errors = [teacher, minji, seojun, late].flatMap((p) => p.errors);
  check("no browser errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  console.log(failed ? `\n${failed} FAILED` : "\nall class tool checks passed");
} finally {
  for (const b of browsers) await b.close();
}
process.exit(failed ? 1 : 0);
