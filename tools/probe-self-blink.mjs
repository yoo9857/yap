// Probe: does OUR OWN robot blink in hard play? Solo field, real input (the game believes it holds
// the mouse): run, jump, spin the view; every frame records the robot's fade and visibility.
// node tools/probe-self-blink.mjs   (needs `pnpm dev`)
import puppeteer from "puppeteer-core";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=900,600"] });
const p = await b.newPage();
await p.setViewport({ width: 900, height: 600 });
await p.goto("http://localhost:5173/?mode=field&reset=1", { waitUntil: "networkidle2", timeout: 60000 });
await p.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 40000 });
await p.evaluate(() => { const c = document.querySelector("canvas"); Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => c }); });
await sleep(1500);
const run = async (label, act) => {
  const rec = p.evaluate(async () => {
    const out = [];
    const end = performance.now() + 7000;
    while (performance.now() < end) {
      await new Promise((r) => requestAnimationFrame(r));
      const s = globalThis.__roboCraft.snapshot();
      out.push([s.robotOpacity, s.robotVisible, s.pos[1], s.pitch]);
    }
    return out;
  });
  await act();
  const f = await rec;
  const minOp = Math.min(...f.map((x) => x[0]));
  const hidden = f.filter((x) => !x[1]).length;
  const dips = f.filter((x) => x[0] < 0.9).length;
  let flips = 0; for (let i = 1; i < f.length; i++) if (f[i][1] !== f[i - 1][1]) flips++;
  console.log(`${label}: ${f.length} frames, min opacity ${minOp.toFixed(2)}, frames under 0.9 ${dips}, hidden ${hidden}, visibility flips ${flips}`);
  const samples = f.filter((x) => x[0] < 0.9).slice(0, 6).map((x) => `op ${x[0].toFixed(2)} y ${x[2].toFixed(2)} pitch ${x[3].toFixed(2)}`);
  if (samples.length) console.log("   e.g.", samples.join(" | "));
};
await run("run + jump + spin, level view", async () => {
  await p.keyboard.down("KeyW"); await p.keyboard.down("ShiftLeft");
  for (let i = 0; i < 14; i++) { await p.keyboard.press("Space"); await p.evaluate((i) => globalThis.__roboCraft.look((i % 4) * 1.6, 0), i); await sleep(450); }
  await p.keyboard.up("KeyW"); await p.keyboard.up("ShiftLeft");
});
await run("run + jump, looking up and down hard", async () => {
  await p.keyboard.down("KeyW");
  for (let i = 0; i < 14; i++) { await p.keyboard.press("Space"); await p.evaluate((i) => globalThis.__roboCraft.look(i * 0.5, i % 2 ? 1.3 : -1.3), i); await sleep(450); }
  await p.keyboard.up("KeyW");
});
await b.close();
