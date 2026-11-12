// The teacher's tools against the class's water, in real browsers (a teacher and a student): seats
// arranged, water poured by both, one plot drained, the whole class drained, poured again, seats
// cleared, a plot reset. After every step, on BOTH screens:
//   - the world's water is the same on the two screens (cell for cell, in absolute coordinates);
//   - what is DRAWN is the world's water: every water cell open to the air has faces in a water
//     mesh, and no mesh draws a cell that holds no water ("the water stopped", "only the middle
//     sticks up").
//   node tools/e2e-class-water.mjs [shotdir]     (needs pnpm dev)
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const BASE = process.env.BASE ?? "http://localhost:5173";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const ROOM = `물반${Date.now() % 100000}`;
const SHOTS = process.argv[2];
if (SHOTS) await mkdir(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`); if (!ok) failed++; };
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

/** The page's water: its world's cells (absolute), and the cells its water meshes draw. */
const water = (page) => page.evaluate(() => {
  const c = globalThis.__roboCraft, a = c.absolute(), p = c.snapshot().pos;
  const ox = Math.round(a[0] - p[0]), oz = Math.round(a[1] - p[2]);
  const world = new Map(), open = [];
  for (let y = 1; y < 20; y++) for (let z = 0; z < 160; z++) for (let x = 0; x < 160; x++) {
    const id = c.blockAt(x, y, z);
    if (id < 19 || id > 28) continue;
    world.set(`${x + ox},${y},${z + oz}`, id);
    const up = c.blockAt(x, y + 1, z);
    if (up === 0) open.push(`${x + ox},${y},${z + oz}`);
  }
  const drawn = new Set();
  c.scene().traverse((o) => {
    const grid = o.geometry?.getAttribute?.("aGrid"), wet = o.geometry?.getAttribute?.("aWet");
    if (!grid || !o.visible || o.parent?.geometry?.getAttribute?.("aGrid")) return;
    for (let i = 0; i < grid.count; i++) {
      if (wet && wet.getX(i) < 0) continue; // a closing face against a block: not drawn
      drawn.add(`${Math.round(grid.getX(i) + o.position.x) + ox},${grid.getY(i)},${Math.round(grid.getZ(i) + o.position.z) + oz}`);
    }
  });
  return { world: [...world], open, drawn: [...drawn] };
});

const compare = async (step, teacher, student) => {
  // let the flow settle and the meshes land: the two worlds must agree for a second running
  let t, s, same = false;
  for (let i = 0; i < 40 && !same; i++) {
    await sleep(700);
    await teacher.bringToFront(); await sleep(250); t = await water(teacher);
    await student.bringToFront(); await sleep(250); s = await water(student);
    const tw = new Map(t.world), sw = new Map(s.world);
    same = tw.size === sw.size && [...tw].every(([k, id]) => sw.get(k) === id);
  }
  const tw = new Map(t.world), sw = new Map(s.world);
  const differ = [...new Set([...tw.keys(), ...sw.keys()])].filter((k) => tw.get(k) !== sw.get(k));
  check(`${step}: the two screens hold the same water`, differ.length === 0, `${tw.size} cells${differ.length ? `, ${differ.length} differ: ${differ.slice(0, 4).map((k) => `${k}=${tw.get(k) ?? "-"}/${sw.get(k) ?? "-"}`).join(" ")}` : ""}`);
  for (const [who, page, w] of [["teacher", teacher, t], ["student", student, s]]) {
    const world = new Map(w.world), drawn = new Set(w.drawn);
    const ghost = [...drawn].filter((k) => !world.has(k)), bare = w.open.filter((k) => !drawn.has(k));
    check(`${step}: the ${who} draws exactly the water there is`, ghost.length === 0 && bare.length === 0,
      `${drawn.size} drawn${ghost.length ? `, ${ghost.length} drawn with no water: ${ghost.slice(0, 4).join(" ")}` : ""}${bare.length ? `, ${bare.length} water not drawn: ${bare.slice(0, 4).join(" ")}` : ""}`);
    if (SHOTS) { await page.bringToFront(); await sleep(200); await page.screenshot({ path: `${SHOTS}/${step.replace(/[^a-z0-9]+/gi, "-")}-${who}.png` }); }
  }
  return tw.size;
};

try {
  const teacher = await open(`host=${encodeURIComponent("김선생")}&pass=1234`);
  const student = await open(`student=${encodeURIComponent("민지")}`);
  const send = (msg) => teacher.evaluate((m) => globalThis.__roboCraft.classSend(m), msg);
  const here = (page) => page.evaluate(() => globalThis.__roboCraft.snapshot().pos.map(Math.floor));
  const pour = async (page, cells) => { await page.bringToFront(); await page.evaluate((cells) => { for (const [x, y, z] of cells) globalThis.__roboCraft.pourAt(x, y, z); }, cells); };

  const t0 = await here(teacher);
  await pour(teacher, [[t0[0] + 4, t0[1], t0[2] - 6], [t0[0] - 5, t0[1], t0[2] - 9]]);
  await compare("before seats", teacher, student);

  await send({ t: "k-arrange", yaw: 0 });
  await sleep(2500);
  await compare("seats arranged over water", teacher, student);

  const m = await here(student);
  await pour(student, [[m[0] + 2, m[1], m[2] + 3], [m[0] - 3, m[1] + 4, m[2] + 5]]);   // on her plot; one from the air
  const t1 = await here(teacher);
  await pour(teacher, [[t1[0] + 1, t1[1], t1[2] - 5], [t1[0] - 2, t1[1], t1[2] - 12]]);
  const full = await compare("poured by both", teacher, student);

  await send({ t: "k-plot", name: "민지", op: "drain" });
  const drained = await compare("one plot drained", teacher, student);
  check("draining the plot took water away", drained < full, `${full} → ${drained}`);

  await pour(student, [[m[0] + 2, m[1], m[2] + 3]]);
  await compare("poured again on the drained plot", teacher, student);

  await send({ t: "k-lesson", freeze: true });
  await pour(teacher, [[t1[0] + 3, t1[1], t1[2] - 7]]);
  await compare("class frozen, the teacher pours", teacher, student);
  await send({ t: "k-lesson", freeze: false });

  await send({ t: "k-drain-water" });
  const none = await compare("all water drained", teacher, student);
  check("the drain left no water", none === 0, `${none} cells`);

  await pour(teacher, [[t1[0] + 1, t1[1], t1[2] - 5], [t1[0] + 6, t1[1], t1[2] - 8]]);
  await pour(student, [[m[0] + 2, m[1], m[2] + 3]]);
  await compare("poured after the drain", teacher, student);

  await send({ t: "k-arrange", clear: true });
  await sleep(1500);
  await compare("seats cleared", teacher, student);

  await send({ t: "k-arrange", yaw: 0 });
  await sleep(2500);
  await send({ t: "k-plot", name: "민지", op: "reset" });
  await compare("seats again, one plot reset", teacher, student);

  check("no page errors", teacher.errors.length + student.errors.length === 0, [...teacher.errors, ...student.errors].slice(0, 3).join(" | "));
  console.log(failed ? `${failed} FAILED` : "all class water checks passed");
} finally {
  for (const b of browsers) await b.close();
}
process.exit(failed ? 1 : 0);
