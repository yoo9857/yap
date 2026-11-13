// Where the time goes when the fire drill is entered: a CPU profile from the page's first byte to
// a few seconds into play, on the real GPU, summed by function (self time), with every long task
// (the main thread held for more than 50 ms: a visible freeze) listed by when it happened. This is
// how "it stutters when the room starts" gets a name. Needs `pnpm dev`.
//
//   node tools/profile-fire-boot.mjs [seconds after the drill is ready, default 6]
import puppeteer from "puppeteer-core";

const AFTER = Number(process.argv[2] ?? 6) * 1000;
const URL = process.env.URL ?? "http://localhost:5173/?mode=field&theme=fire&reset=1";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox", "--window-size=1600,900", "--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
await page.evaluateOnNewDocument(() => {
  // Which shader programs made the game WAIT: asking a program for anything before the driver has
  // finished it blocks until it has. Each program is named by its shaders (three writes
  // SHADER_TYPE / SHADER_NAME into them), and every such wait over 15 ms is kept.
  globalThis.__waits = [];
  const GL = WebGL2RenderingContext.prototype, names = new WeakMap();
  const label = (src) => `${/#define SHADER_TYPE (\S+)/.exec(src)?.[1] ?? "?"}${/#define SHADER_NAME (\S+)/.exec(src)?.[1] ? ":" + /#define SHADER_NAME (\S+)/.exec(src)[1] : ""}${/#define USE_INSTANCINGb/.test(src) ? " instanced" : ""}${/#define USE_SKINNINGb/.test(src) ? " skinned" : ""}${/#define USE_SHADOWMAPb/.test(src) ? " shadows" : ""}${/DEPTH_PACKING|DISTANCE/.test(src.slice(0, 1500)) ? " depth" : ""}`;
  const shaderSource = GL.shaderSource, attachShader = GL.attachShader;
  GL.shaderSource = function (shader, src) { names.set(shader, label(src)); return shaderSource.call(this, shader, src); };
  GL.attachShader = function (program, shader) { if (!names.has(program) || this.getShaderParameter(shader, this.SHADER_TYPE) === this.FRAGMENT_SHADER) names.set(program, names.get(shader)); return attachShader.call(this, program, shader); };
  for (const fn of ["getProgramParameter", "getProgramInfoLog", "getUniformLocation", "getActiveUniform", "useProgram"]) {
    const real = GL[fn];
    GL[fn] = function (program, ...rest) {
      const t = performance.now(), out = real.call(this, program, ...rest), ms = performance.now() - t;
      if (ms > 15) globalThis.__waits.push([Math.round(t), Math.round(ms), names.get(program) ?? "?"]);
      return out;
    };
  }
  globalThis.__long = [];
  new PerformanceObserver((list) => { for (const e of list.getEntries()) globalThis.__long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ entryTypes: ["longtask"] });
});
const cdp = await page.createCDPSession();
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
await cdp.send("Profiler.start");
const t0 = Date.now();
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => globalThis.__roboCraft?.fire?.(), { timeout: 120000 });
const ready = Date.now() - t0;
await page.evaluate(() => globalThis.__roboCraft.firePlay(true));
await sleep(AFTER);
const { profile } = await cdp.send("Profiler.stop");
const long = await page.evaluate(() => globalThis.__long);
const waits = await page.evaluate(() => globalThis.__waits);
const readyAt = await page.evaluate(() => Math.round(performance.now())) - AFTER;
await browser.close();

// self time by function
const dt = profile.timeDeltas, byNode = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
profile.samples.forEach((id, i) => {
  const n = byNode.get(id), f = n.callFrame;
  const key = `${f.functionName || "(anonymous)"}  ${f.url.replace(/^.*\/(src|node_modules\/\.vite\/deps|@fs\/C:\/craftyap)\//, "").replace(/\?.*$/, "")}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
});
console.log(`the drill is ready ${ready} ms after the page is asked for\n`);
console.log("long tasks (the main thread held > 50 ms), by when they began:");
for (const [at, ms] of long) console.log(`  ${String(at).padStart(6)} ms  ${String(ms).padStart(5)} ms${at > readyAt ? "   ← after the drill was ready (in play)" : ""}`);
console.log(`  in all ${long.reduce((s, [, ms]) => s + ms, 0)} ms in ${long.length} tasks\n`);
console.log("self time by function (ms), the 28 heaviest:");
for (const [key, ms] of [...self].filter(([k]) => !/^\((idle|program)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 28)) console.log(`  ${ms.toFixed(0).padStart(6)}  ${key.slice(0, 150)}`);

// who called the heaviest function: its callers' chains (game code and the renderer's own steps only)
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const heaviest = [...self].filter(([k]) => !/^\((idle|program|garbage)/.test(k)).sort((a, b) => b[1] - a[1])[0][0].split("  ")[0];
const stacks = new Map();
profile.samples.forEach((id, i) => {
  if ((byNode.get(id).callFrame.functionName || "(anonymous)") !== heaviest) return;
  const chain = [];
  for (let at = parent.get(id); at !== undefined && chain.length < 9; at = parent.get(at)) {
    const f = byNode.get(at).callFrame;
    if (f.functionName) chain.push(f.functionName);
  }
  const key = chain.join(" ← ");
  stacks.set(key, (stacks.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
});
console.log(`
who calls ${heaviest} (ms):`);
for (const [key, ms] of [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${ms.toFixed(0).padStart(6)}  ${key.slice(0, 230)}`);

console.log("\nshader programs the game waited for (when, how long, which):");
for (const [at, ms, name] of waits) console.log(`  ${String(at).padStart(6)} ms  ${String(ms).padStart(5)} ms  ${name}`);
console.log(`  in all ${waits.reduce((sum, w) => sum + w[1], 0)} ms`);
