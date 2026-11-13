// What the fire costs on THIS machine's real GPU (not the software renderer the other suites use):
// Edge with the GPU on and the frame rate uncapped, the fire's quality step held, the drill's clock
// moved through its story, and the frame time read at each moment from two places (the burning
// room's doorway, the smoky corridor). Each row is one way of drawing it, so what a part costs is
// the difference between rows. Needs `pnpm dev`.
//
//   node tools/perf-fire-gpu.mjs            # the usual rows
//   QUERY="&firequality=2" node tools/perf-fire-gpu.mjs   # one row of your own
import puppeteer from "puppeteer-core";

const BASE = process.env.URL ?? "http://localhost:5173/?mode=field&theme=fire&reset=1";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROWS = process.env.QUERY ? [[process.env.QUERY, process.env.QUERY]] : [
  ["step 0 (best)", "&firequality=0"],
  ["step 2", "&firequality=2"],
  ["step 5 (cheapest)", "&firequality=5"],
  ["step 0, no smoke volume", "&firequality=0&smoke=puffs"],
  ["step 0, no fire body", "&firequality=0&fire=sprites"],
];
const TIMES = [10, 60, 150, 260];

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: "new",
  args: ["--no-sandbox", "--window-size=1600,900", "--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--disable-gpu-vsync", "--disable-frame-rate-limit"],
});
for (const [name, query] of ROWS) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.goto(BASE + query, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => globalThis.__roboCraft?.fire?.(), { timeout: 120000 });
  await sleep(3500);
  const gpu = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "?";
  });
  if (name === ROWS[0][0]) console.log(`GPU: ${gpu}\n`);
  const school = await page.evaluate(async () => (await import("/@fs/C:/craftyap/packages/shared/src/fireSchool.ts")).fireSchool());
  const floor = school.spawns[0][1], door = school.fireDoor, heat = school.heat;
  const dx = (door[0] + door[3]) / 2, dz = (door[2] + door[5]) / 2, out = dz > (heat[2] + heat[5]) / 2 ? 1 : -1;
  const places = [
    ["room", dx - 1.1, dz - out * 1.6, (out > 0 ? Math.PI : 0) - 0.35, 0.1],
    ["corridor", (school.corridor[0] + school.corridor[3]) / 2, (school.corridor[2] + school.corridor[5]) / 2, -Math.PI / 2, 0.05],
  ];
  // Frame time: the browser does not wait for the GPU (frames pile up and the pace of
  // requestAnimationFrame says nothing), so one pixel is read back from the game's canvas every
  // frame — that waits until everything drawn so far is really done. The middle and the slowest
  // 5 % of a second and a half of such frames.
  const measure = () => page.evaluate(() => new Promise((done) => {
    const gl = document.querySelector("canvas").getContext("webgl2");
    const px = new Uint8Array(4);
    const ms = [];
    let last = performance.now();
    const until = last + 1500;
    const tick = () => {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const now = performance.now();
      ms.push(now - last); last = now;
      if (now < until) requestAnimationFrame(tick); else { ms.shift(); ms.sort((a, b) => a - b); done([ms[Math.floor(ms.length / 2)], ms[Math.floor(ms.length * 0.95)]]); }
    };
    requestAnimationFrame(tick);
  }));
  const cells = [];
  for (const [place, x, z, yaw, pitch] of places) for (const time of TIMES) {
    await page.evaluate((x, y, z, yaw, pitch, time) => {
      const c = globalThis.__roboCraft;
      c.firePlay(true);
      c.fireSet({ time, smokeClock: time, air: 1, mistakes: 0, step: "escape" });
      c.teleportAbs(x, y, z, yaw);
      c.look(yaw, pitch);
    }, x, floor + 0.05, z, yaw, pitch, time);
    await sleep(900);
    const [mid, slow] = await measure();
    cells.push(`${place}@${time}s ${mid.toFixed(1)}/${slow.toFixed(1)}`);
  }
  const fx = (await page.evaluate(() => globalThis.__roboCraft.fire())).fx;
  console.log(`${name.padEnd(26)} ${cells.join("  ")}   [step ${fx.quality}, volume ${fx.volume}]`);
  await page.close();
}
console.log("\n(ms a frame: middle / slowest 5 %. 16.7 = 60 fps, 33 = 30 fps.)");
await browser.close();
