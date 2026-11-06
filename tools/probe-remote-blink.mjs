// Probe: does a classmate blink? A teacher and a student in separate browsers; on the teacher's page
// every animation frame records whether the student's robot is drawn and where. Near (10 m) and
// far (60 m, past the 48 m full-rate radius), standing and walking. Needs `pnpm dev`.
// node tools/probe-remote-blink.mjs
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const ROOM = `깜빡${Date.now() % 100000}반`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=900,600"] });
  const p = await b.newPage();
  await p.setViewport({ width: 900, height: 600 });
  p.on("pageerror", (e) => console.log("pageerror", e.message));
  return { b, p };
};
const t = await open();
await t.p.goto(`${BASE}/?mode=field&room=${encodeURIComponent(ROOM)}&host=${encodeURIComponent("쌤")}&pass=1234`, { waitUntil: "networkidle2", timeout: 60000 });
await t.p.waitForFunction(() => !!globalThis.__roboCraft?.classroom(), { timeout: 40000 });
const s = await open();
await s.p.goto(`${BASE}/?mode=field&room=${encodeURIComponent(ROOM)}&student=${encodeURIComponent("민지")}`, { waitUntil: "networkidle2", timeout: 60000 });
await s.p.waitForFunction(() => !!globalThis.__roboCraft?.classroom(), { timeout: 40000 });
await sleep(2000);

/** Record the teacher's view of the student for `ms`. */
const record = (ms) => t.p.evaluate(async (ms) => {
  const out = [];
  const end = performance.now() + ms;
  while (performance.now() < end) {
    await new Promise((r) => requestAnimationFrame(r));
    const r = globalThis.__roboCraft.classroom().remotes[0];
    out.push(r ? { v: r.visible, x: r.drawn[0], y: r.drawn[1], z: r.drawn[2], m: r.meshes } : { v: false, x: NaN, y: NaN, z: NaN, m: 0 });
  }
  return out;
}, ms);
const summarise = (label, frames) => {
  let hidden = 0, flips = 0, jumps = 0, meshDips = 0;
  const maxM = Math.max(...frames.map((f) => f.m ?? 0));
  const ms = new Set();
  for (let i = 0; i < frames.length; i++) {
    if (!frames[i].v) hidden++;
    if (i && frames[i].v !== frames[i - 1].v) flips++;
    if (i && Math.hypot(frames[i].x - frames[i - 1].x, frames[i].z - frames[i - 1].z) > 1.5) jumps++;
    if (frames[i].v && (frames[i].m ?? maxM) < maxM) meshDips++;
    ms.add(frames[i].m);
  }
  const ys = frames.map((f) => f.y).filter((y) => Number.isFinite(y));
  console.log(`${label}: ${frames.length} frames, hidden ${hidden}, flips ${flips}, jumps>1.5m ${jumps}, frames with fewer meshes ${meshDips} (mesh counts ${[...ms].join("/")}), y ${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)}`);
};
const place = async (dist) => {
  // put the student `dist` m in front of the teacher (absolute), both facing each other
  const [tx, tz] = await t.p.evaluate(() => globalThis.__roboCraft.absolute());
  await t.p.evaluate(() => globalThis.__roboCraft.look(0, -0.05));
  await s.p.evaluate(([ax, az]) => {
    const c = globalThis.__roboCraft;
    const [sx, sz] = c.absolute();
    const p = c.snapshot().pos;
    c.teleport(p[0] + (ax - sx), p[1] + 0.3, p[2] + (az - sz));
  }, [tx, tz + dist]);
  await sleep(1500);
};
const walk = (on) => s.p.evaluate((on) => {
  // a steady walk across the view: the student's own teleports, small steps every frame
  globalThis.__probeWalk = on;
  if (!on) return;
  const step = () => {
    if (!globalThis.__probeWalk) return;
    const c = globalThis.__roboCraft;
    const p = c.snapshot().pos;
    c.teleport(p[0] + 0.06, p[1], p[2]);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}, on);

/** Pixel check: how much of the student's yellow is on screen, frame after frame (screenshots). */
const pixels = async (label, n = 40) => {
  const counts = [];
  for (let i = 0; i < n; i++) {
    const shot = await t.p.screenshot({ encoding: "base64", clip: { x: 250, y: 120, width: 400, height: 360 } });
    counts.push(await t.p.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let y = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 190 && d[i + 1] > 150 && d[i + 2] < 90) y++;
      return y;
    }, shot));
  }
  const max = Math.max(...counts);
  const dips = counts.filter((c) => c < max * 0.5).length;
  console.log(`${label}: yellow px min ${Math.min(...counts)} max ${max}, frames under half: ${dips} / ${n}  [${counts.join(" ")}]`);
};

for (const dist of [6, 10, 60]) {
  await place(dist);
  await t.p.bringToFront();
  summarise(`${dist} m, standing`, await record(5000));
  await pixels(`${dist} m, standing (pixels)`);
  await walk(true);
  summarise(`${dist} m, walking`, await record(5000));
  await pixels(`${dist} m, walking (pixels)`);
  await walk(false);
}
// hard play with REAL input: run, jump, spin the view (the game believes it holds the mouse)
await s.p.evaluate(() => {
  const canvas = document.querySelector("canvas");
  Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => canvas });
});
await place(8);
await t.p.bringToFront();
await s.p.keyboard.down("KeyW");
await s.p.keyboard.down("ShiftLeft");
const hard = record(8000);
for (let i = 0; i < 16; i++) {
  await s.p.keyboard.press("Space");
  await s.p.evaluate((i) => globalThis.__roboCraft.look((i % 4) * 1.6, 0), i);
  await sleep(450);
}
summarise("running + jumping + spinning (real input)", await hard);
await s.p.keyboard.up("KeyW");
await s.p.keyboard.up("ShiftLeft");

// seated: the student keeps walking into their fence — the teacher must see no blink and no jump
await t.p.evaluate(() => { globalThis.__roboCraft.look(0, -0.05); globalThis.__roboCraft.classSend({ t: "k-arrange", yaw: 0 }); });
await sleep(2500);
await t.p.bringToFront();
await walk(true);
summarise("seated, walking into the fence", await record(6000));
await walk(false);
await t.b.close();
await s.b.close();
