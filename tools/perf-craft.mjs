// Craft/field performance probe: reproduces the situations players report as
// "버벅임" and measures them, then soaks the mode for leaks.
//
//   node tools/perf-craft.mjs [--profile]
//
// Scenarios (education field, a stone wall built in front of the spawn):
//   open      — standing in the open, turning the camera (baseline)
//   slide     — walking diagonally INTO the wall, so the body slides along it
//   backwall  — back to the wall, turning: the camera is squeezed against it
//   corner    — rubbing into an inside corner while turning
// Each reports frame-time stats (mean / p95 / max / frames over 33 ms) and
// the camera's distance jitter (how much it jumps frame to frame). With
// --profile, the top self-time JS functions per scenario are printed too.
//
// Leak soak: ten rounds of machine lab on/off, 60 furniture placed and put
// away, every pet adopted, render distance cycled, the field scrolled back and
// forth — GPU resource counts and the heap after a forced GC must plateau.
//
// Needs `pnpm dev` running. Headless SwiftShader renders on the CPU, so
// absolute fps is meaningless here; spikes, jitter, JS hot spots and leaks
// are what this measures.
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE = process.argv.includes("--profile");
/** Extra URL params (e.g. `--url=&ink=0`) and render switches (`--no-shadows`,
 *  `--no-robot`), for bisecting where a cost comes from. */
const URL_EXTRA = (process.argv.find((a) => a.startsWith("--url=")) ?? "--url=").slice(6);
const FLAGS = { shadows: !process.argv.includes("--no-shadows"), robot: !process.argv.includes("--no-robot") };
const SKIP_SOAK = process.argv.includes("--no-soak");
/** --alloc: sample allocations per scenario and print who made the garbage. */
const ALLOC = process.argv.includes("--alloc");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  // uncapped: at the default vsync every frame reads 16.7 ms and hides its real cost
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800", "--disable-gpu-vsync", "--disable-frame-rate-limit"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
const cdp = await page.createCDPSession();
// "load", not "networkidle2": an uncapped render loop keeps the page busy forever
await page.goto(`http://localhost:5173/?mode=field&reset=1${URL_EXTRA}`, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 60000 });
await wait(3000);

// A frame recorder: rAF deltas plus the camera position each frame.
await page.evaluate(() => {
  const rec = { on: false, dts: [], cams: [], worst: [], heap: [] };
  globalThis.__perfRec = rec;
  // the perf monitor keeps the costliest frame of each half-second window,
  // broken down by phase: collect those while recording
  setInterval(() => {
    if (rec.on) rec.worst.push(globalThis.__roboCraft.perf().worstFrame);
  }, 450);
  let last = performance.now();
  const tick = (t) => {
    if (rec.on) {
      rec.dts.push(t - last);
      rec.heap.push(performance.memory?.usedJSHeapSize ?? 0);
      const cam = globalThis.__roboCraft.cameraState?.();
      // stamp with the FRAME's time (what the game interpolated for), not
      // performance.now() here, which also counts how long that frame took to draw
      if (cam) rec.cams.push({ ...cam, t });
    }
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// The wall: 24 long, 3 high, along z = 86, with a return at x = 92 (a corner).
await page.evaluate(() => {
  const c = globalThis.__roboCraft;
  for (let x = 68; x <= 92; x++) for (let y = 4; y <= 6; y++) c.placeAt(x, y, 86, "stone");
  for (let z = 78; z <= 86; z++) for (let y = 4; y <= 6; y++) c.placeAt(92, y, z, "stone");
});

await page.evaluate((f) => globalThis.__roboCraft.renderFlags(f), FLAGS);
await page.mouse.click(640, 500); // pointer lock: movement keys only work in play
await wait(400);

const stats = (dts) => {
  const s = [...dts].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  return {
    frames: s.length,
    meanMs: +mean.toFixed(1),
    p95Ms: +(s[Math.floor(s.length * 0.95)] ?? 0).toFixed(1),
    maxMs: +(s[s.length - 1] ?? 0).toFixed(1),
    over33: s.filter((d) => d > 33).length,
  };
};
const jitter = (cams) => {
  // camera distance from the player, frame to frame: smooth motion changes it
  // a little; a buzzing camera flips by tens of centimetres every frame
  let big = 0;
  let sum = 0;
  for (let i = 1; i < cams.length; i++) {
    const d = Math.abs(cams[i].dist - cams[i - 1].dist);
    sum += d;
    if (d > 0.25) big++;
  }
  // Judder: how much the camera's speed changes from one frame to the next,
  // relative to its average speed. Smooth motion (even accelerating) changes
  // a little per frame; un-interpolated 60 Hz steps or a stop–jump mouse make
  // it swing between "moved twice" and "didn't move". Frames closer than 2 ms
  // are skipped: at that spacing timer resolution is the whole signal.
  const speeds = [];
  for (let i = 1; i < cams.length; i++) {
    const dt = cams[i].t - cams[i - 1].t;
    if (dt < 2) continue;
    speeds.push(Math.hypot(cams[i].x - cams[i - 1].x, cams[i].y - cams[i - 1].y, cams[i].z - cams[i - 1].z) / dt);
  }
  const m = speeds.reduce((a, b) => a + b, 0) / Math.max(1, speeds.length);
  let jerk = 0;
  for (let i = 1; i < speeds.length; i++) jerk += Math.abs(speeds[i] - speeds[i - 1]);
  jerk /= Math.max(1, speeds.length - 1);
  return {
    distJumpsOver25cm: big,
    meanDistChange: +(sum / Math.max(1, cams.length - 1)).toFixed(3),
    judder: m > 1e-5 ? +(jerk / m).toFixed(2) : 0,
  };
};

async function scenario(name, setup, drive, ms = 4000) {
  await page.evaluate(setup);
  await wait(700);
  if (PROFILE) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  // include what minor/major GCs already collected: garbage is the point here
  if (ALLOC) {
    await cdp.send("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMinorGC: true,
      includeObjectsCollectedByMajorGC: true,
    });
  }
  await page.evaluate(() => {
    const r = globalThis.__perfRec;
    r.dts = [];
    r.cams = [];
    r.worst = [];
    r.heap = [];
    r.on = true;
  });
  await drive(ms);
  const rec = await page.evaluate(() => {
    const r = globalThis.__perfRec;
    r.on = false;
    return { dts: r.dts, cams: r.cams, worst: r.worst, heap: r.heap };
  });
  const worst = rec.worst.reduce((a, b) => (b.totalMs > a.totalMs ? b : a), { totalMs: 0, phases: {} });
  const phases = Object.entries(worst.phases)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v.toFixed(1)}`)
    .join(", ");
  // Garbage made per second: the sum of the heap's rises between frames (its
  // falls are collections). A high rate means regular GC pauses — stutter
  // that no frame-time breakdown pins on one function.
  let rise = 0;
  let gcs = 0;
  for (let i = 1; i < rec.heap.length; i++) {
    const d = rec.heap[i] - rec.heap[i - 1];
    if (d > 0) rise += d;
    else if (d < -256 * 1024) gcs++;
  }
  const seconds = rec.dts.reduce((a, b) => a + b, 0) / 1000;
  const out = {
    scenario: name,
    ...stats(rec.dts),
    ...jitter(rec.cams),
    worstWorkMs: +worst.totalMs.toFixed(1),
    worstPhases: phases,
    allocMBps: +(rise / 1048576 / Math.max(0.001, seconds)).toFixed(2),
    gcs,
  };
  if (PROFILE) {
    const { profile } = await cdp.send("Profiler.stop");
    const self = new Map();
    const dt = profile.timeDeltas;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    profile.samples.forEach((id, i) => {
      const n = byId.get(id);
      const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
    });
    out.top = [...self.entries()]
      .filter(([k]) => !k.startsWith("(idle)") && !k.startsWith("(program)"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => `${v.toFixed(0)}ms ${k}`);
  }
  if (ALLOC) {
    const { profile } = await cdp.send("HeapProfiler.stopSampling");
    const bySite = new Map();
    const walk = (node, stack) => {
      const here = `${node.callFrame.functionName || "(anon)"} ${node.callFrame.url.split("/").pop()?.split("?")[0]}:${node.callFrame.lineNumber + 1}`;
      if (node.selfSize > 0) {
        // attribute to the innermost frame from OUR code, not three's internals
        const ours = [here, ...stack].find((f) => !f.includes("chunk-") && !f.startsWith("(")) ?? here;
        bySite.set(ours, (bySite.get(ours) ?? 0) + node.selfSize);
      }
      for (const c of node.children) walk(c, [here, ...stack]);
    };
    walk(profile.head, []);
    out.allocTop = [...bySite.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => `${(v / 1024).toFixed(0)}KB ${k}`);
  }
  console.log(JSON.stringify(out, null, 1));
  return out;
}

// turn the view by `rad` over `ms`, from inside the page, every frame
const turn = (rad, ms) =>
  page.evaluate(
    (r, d) =>
      new Promise((done) => {
        const c = globalThis.__roboCraft;
        let start = null;
        const yaw0 = c.snapshot().yaw ?? 0;
        // driven by the FRAME time, like a player's hand would be sampled —
        // performance.now() here would also count how long the frame took to draw
        const step = (now) => {
          start ??= now;
          const t = Math.min(1, (now - start) / d);
          c.look(yaw0 + Math.sin(t * Math.PI * 2) * r, -0.2);
          if (t < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      }),
    rad,
    ms,
  );

await scenario(
  "open",
  () => globalThis.__roboCraft.teleport(60.5, 4, 70.5),
  (ms) => turn(Math.PI, ms),
);
await scenario(
  "slide",
  () => {
    globalThis.__roboCraft.teleport(72.5, 4, 84.5);
    globalThis.__roboCraft.look(0.6, -0.2); // mostly into the wall (+z), a little along it (+x)
  },
  async (ms) => {
    await page.keyboard.down("KeyW");
    await wait(ms);
    await page.keyboard.up("KeyW");
  },
);
await scenario(
  "backwall",
  () => {
    globalThis.__roboCraft.teleport(80.5, 4, 85.3);
    globalThis.__roboCraft.look(Math.PI, -0.2); // facing away from the wall: the camera is behind, IN it
  },
  (ms) => turn(0.9, ms),
);
await scenario(
  "corner",
  () => {
    globalThis.__roboCraft.teleport(90.5, 4, 84.5);
    globalThis.__roboCraft.look(Math.PI * 0.75, -0.2);
  },
  async (ms) => {
    await page.keyboard.down("KeyS"); // back into the corner
    await turn(0.7, ms);
    await page.keyboard.up("KeyS");
  },
);

// ---------------------------------------------------------------- leak soak
if (SKIP_SOAK) {
  await browser.close();
  process.exit(0);
}
const gcSample = async () => {
  await cdp.send("HeapProfiler.collectGarbage");
  await wait(300);
  return page.evaluate(() => {
    const p = globalThis.__roboCraft.perf();
    return { geometries: p.geometries, textures: p.textures, programs: p.programs, heapMB: p.heapMB, drawCalls: p.drawCalls };
  });
};
await page.evaluate(() => document.exitPointerLock());
const rounds = [];
for (let round = 0; round < 10; round++) {
  await page.evaluate(async (r) => {
    const c = globalThis.__roboCraft;
    const key = (k, code) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true }));
    const up = (code) => document.dispatchEvent(new KeyboardEvent("keyup", { code, bubbles: true }));
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    // machine lab in and out
    key("b", "KeyB");
    up("KeyB");
    await sleep(500);
    key("b", "KeyB");
    up("KeyB");
    await sleep(300);
    // sixty pieces of every look, then all of them put away
    const kinds = ["chair", "sofa", "lamp", "plant", "door", "rug", "bed", "tv", "fridge", "parasol"];
    for (let i = 0; i < 60; i++) c.furniturePlace(kinds[i % kinds.length], 40 + (i % 10) * 3, 4, 40 + Math.floor(i / 10) * 3, i % 4, i % 3);
    await sleep(200);
    c.furnitureClear?.();
    // every pet, then back to the dog
    for (const s of ["cat", "elephant", "giraffe", "panda", "dog"]) c.petAdopt(s);
    // render distance through all presets
    for (let i = 0; i < 3; i++) key("o", "KeyO");
    // scroll the field window away and back
    c.teleport(80.5 + 48, 4, 80.5);
    await sleep(300);
    c.teleport(80.5 - 48, 4, 80.5);
    await sleep(300);
    void r;
  }, round);
  const s = await gcSample();
  rounds.push(s);
  console.log(`round ${round + 1}: ${JSON.stringify(s)}`);
}
const first = rounds[1]; // round 1 still warms caches (lazy geometries, programs)
const last = rounds[rounds.length - 1];
const grew = (k) => last[k] - first[k];
console.log(
  JSON.stringify({
    leak: {
      geometries: grew("geometries"),
      textures: grew("textures"),
      programs: grew("programs"),
      heapMB: last.heapMB !== null && first.heapMB !== null ? +(last.heapMB - first.heapMB).toFixed(1) : null,
    },
  }),
);
await browser.close();
