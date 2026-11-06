// Probe: does a classmate flicker while THEY run and jump? Teacher + student in separate browsers;
// the student plays with real input (the game believes it holds the mouse). On the teacher's page,
// every frame: the classmate's drawn position (backward steps and speed spikes = jitter) and, in
// screenshots with the teacher's own robot hidden, how much of the classmate is on screen.
// node tools/probe-remote-run.mjs   (needs `pnpm dev`)
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const ROOM = `달리기${Date.now() % 100000}반`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = async () => {
  const b = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=900,600"] });
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
await s.p.evaluate(() => { const c = document.querySelector("canvas"); Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => c }); });
await t.p.addStyleTag({ content: ".craft-hint{display:none!important}" });
await sleep(1500);
// the student 12 m in front of the teacher, running across the teacher's view (+x)
const [tx, tz] = await t.p.evaluate(() => globalThis.__roboCraft.absolute());
await s.p.evaluate(([ax, az]) => {
  const c = globalThis.__roboCraft;
  const [sx, sz] = c.absolute();
  const p = c.snapshot().pos;
  c.teleport(p[0] + (ax - sx) - 10, p[1] + 0.3, p[2] + (az - sz));
  c.look(Math.PI / 2, 0); // facing +x
}, [tx, tz + 12]);
await t.p.evaluate(() => { const c = globalThis.__roboCraft; c.look(0, -0.05); c.renderFlags({ robot: false }); });
await sleep(1500);

const record = (ms) => t.p.evaluate(async (ms) => {
  const out = [];
  const end = performance.now() + ms;
  let last = performance.now();
  while (performance.now() < end) {
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    const c = globalThis.__roboCraft;
    const r = c.classroom().remotes[0];
    // is the classmate inside the camera's view? project its chest through the real camera
    const [ax, az] = c.absolute();
    const g = c.snapshot().pos;
    const cam = c.cameraState?.() ?? null;
    let inView = 0;
    if (r && cam && cam.matrix) {
      const v = [r.drawn[0] - (ax - g[0]), r.drawn[1] + 0.9, r.drawn[2] - (az - g[2]), 1];
      const m = cam.matrix;
      const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
      const y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
      const w = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15];
      inView = w > 0 && Math.abs(x / w) < 0.85 && Math.abs(y / w) < 0.85 ? 1 : 0;
    }
    out.push(r ? [r.drawn[0], r.drawn[1], r.drawn[2], r.visible ? 1 : 0, now - last, inView] : [NaN, NaN, NaN, 0, now - last, 0]);
    last = now;
  }
  return out;
}, ms);
const yellow = async (n) => {
  const counts = [];
  for (let i = 0; i < n; i++) {
    const shot = await t.p.screenshot({ encoding: "base64" });
    counts.push(await t.p.evaluate(async (b64) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let y = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 190 && d[i + 1] > 150 && d[i + 2] < 90) y++;
      return y;
    }, shot));
  }
  return counts;
};
const analyse = (label, f) => {
  const steps = [];
  for (let i = 1; i < f.length; i++) steps.push({ dx: f[i][0] - f[i - 1][0], dz: f[i][2] - f[i - 1][2], dy: f[i][1] - f[i - 1][1], dt: f[i][4] });
  const speeds = steps.map((s) => Math.hypot(s.dx, s.dz) / Math.max(1e-3, s.dt / 1000)).filter(Number.isFinite).sort((a, b) => a - b);
  const median = speeds[Math.floor(speeds.length / 2)] ?? 0;
  const back = steps.filter((s) => s.dx < -0.01).length; // running +x: any -x step is a stutter
  const spikes = steps.filter((s) => Math.hypot(s.dx, s.dz) / Math.max(1e-3, s.dt / 1000) > Math.max(2, median * 2.2)).length;
  const hidden = f.filter((x) => !x[3]).length;
  const blinks = f.filter((x) => !x[3] && x[5]).length; // NOT drawn although inside the view: a real blink
  const inView = f.filter((x) => x[5]).length;
  const stalls = steps.filter((s) => Math.hypot(s.dx, s.dz) < 1e-4).length;
  console.log(`${label}: ${f.length} frames, median ${median.toFixed(2)} m/s, backward steps ${back}, speed spikes ${spikes}, frozen frames ${stalls}, hidden ${hidden} (in view ${inView}, hidden while in view: ${blinks})`);
};

await s.p.keyboard.down("KeyW");
await s.p.keyboard.down("ShiftLeft");
await sleep(400);
analyse("classmate running", await record(3000));
const jumping = record(4000);
for (let i = 0; i < 8; i++) { await s.p.keyboard.press("Space"); await sleep(480); }
analyse("classmate running + jumping", await jumping);
const counts = await yellow(30);
const max = Math.max(...counts);
console.log(`classmate pixels while running: min ${Math.min(...counts)} max ${max}, shots under half ${counts.filter((c) => c < max * 0.5).length}/30 [${counts.join(" ")}]`);
await s.p.keyboard.up("KeyW");
await s.p.keyboard.up("ShiftLeft");

// now the VIEWER moves: the teacher runs (and jumps) toward a classmate standing far ahead
await t.p.evaluate(() => { const c = document.querySelector("canvas"); Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => c }); });
{
  const [ax, az] = await t.p.evaluate(() => globalThis.__roboCraft.absolute());
  await s.p.evaluate(([ax, az]) => {
    const c = globalThis.__roboCraft;
    const [sx, sz] = c.absolute();
    const p = c.snapshot().pos;
    c.teleport(p[0] + (ax - sx), p[1] + 0.3, p[2] + (az - sz));
  }, [ax, az + 25]);
  await t.p.evaluate(() => globalThis.__roboCraft.look(0, -0.05));
  await sleep(1500);
  await t.p.bringToFront();
  await t.p.keyboard.down("KeyW");
  await t.p.keyboard.down("ShiftLeft");
  const viewerRun = record(4500);
  for (let i = 0; i < 6; i++) { await sleep(600); await t.p.keyboard.press("Space"); }
  analyse("VIEWER running + jumping toward the classmate", await viewerRun);
  await t.p.keyboard.up("KeyW");
  await t.p.keyboard.up("ShiftLeft");
}
await t.b.close();
await s.b.close();
