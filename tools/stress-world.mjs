// Real browser lifecycle and scrolling-window soak. Uses a new, isolated Edge
// profile; never reads/writes another browser's saved world or a live classroom.
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
const out = process.argv[2] ?? "tmp/world-load";
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--enable-precise-memory-info"] });
const errors = [];
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1000, height: 650 });
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await page.createCDPSession();
  await page.goto(`${process.env.BASE_URL ?? "http://localhost:5173"}/?mode=field&reset=1&perf=1`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 60000 });
  await page.evaluate(async () => {
    globalThis.__roboCraft.dispose();
    globalThis.__worldCtor = (await import("/src/craft/craftGame.ts")).CraftGame;
  });
  const heap = async () => { await cdp.send("HeapProfiler.collectGarbage"); return (await cdp.send("Runtime.getHeapUsage")).usedSize / 1048576; };
  const listeners = async () => {
    const result = {};
    for (const expression of ["window", "document", "document.getElementById('app')"]) {
      const { result: target } = await cdp.send("Runtime.evaluate", { expression, objectGroup: "world-soak" });
      const { listeners: list } = await cdp.send("DOMDebugger.getEventListeners", { objectId: target.objectId });
      result[expression] = list.length;
      for (const item of list) for (const key of ["handler", "originalHandler"])
        if (item[key]?.objectId) await cdp.send("Runtime.releaseObject", { objectId: item[key].objectId });
    }
    await cdp.send("Runtime.releaseObjectGroup", { objectGroup: "world-soak" }); return result;
  };
  const create = async () => page.evaluate(async () => {
    const g = globalThis.__worldGame = new globalThis.__worldCtor(document.getElementById("app"), { field: true });
    await g.prepare(); g.start(); await new Promise((r) => setTimeout(r, 250));
  });
  const dispose = async () => page.evaluate(() => {
    const g = globalThis.__worldGame, gl = g.renderer.renderer.getContext();
    g.dispose(); g.dispose(); g.start(); // disposal is terminal and idempotent
    const state = { contextLost: gl.isContextLost(), sceneObjects: g.renderer.scene.children.length,
      chunks: g.view.chunkStats().chunks, hud: document.querySelectorAll(".craft-hud,.craft-hint,.craft-piece,.craft-screen").length,
      canvas: document.querySelectorAll("canvas").length, debugRemoved: !globalThis.__roboCraft };
    delete globalThis.__worldGame; return state;
  });
  await create();
  await page.evaluate(() => {
    const c = globalThis.__roboCraft;
    for (let x = 70; x <= 90; x += 2) for (let z = 70; z <= 90; z += 2) c.placeAt(x, 4, z, "gold-block");
  });
  const scroll = [];
  for (let round = 0; round < 6; round++) {
    await page.evaluate(async () => {
      const c = globalThis.__roboCraft;
      for (const [ax, az] of [[160.5, 0.5], [160.5, 160.5], [-159.5, -159.5], [0.5, 0.5]]) {
        const p = c.snapshot().pos, a = c.absolute();
        c.teleport(ax - (a[0] - p[0]), 6, az - (a[1] - p[2]));
        for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
      }
    });
    await page.waitForFunction(() => globalThis.__roboCraft.chunks().queued === 0 &&
      globalThis.__roboCraft.waterStats().queued + globalThis.__roboCraft.waterStats().pending === 0, { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1100));
    const sample = await page.evaluate(() => ({ ...globalThis.__roboCraft.chunks(), perf: globalThis.__roboCraft.perf() }));
    sample.heapMiB = await heap(); scroll.push(sample); console.log("scroll", JSON.stringify({ round, ...sample }));
  }
  const disposed = await dispose();
  const baselineListeners = await listeners();
  const cycles = [];
  for (let round = 0; round < 6; round++) {
    await create(); const state = await dispose();
    state.heapMiB = await heap(); state.listeners = await listeners(); cycles.push(state);
    console.log("lifecycle", JSON.stringify({ round, ...state }));
  }
  const cancelledWarmup = await page.evaluate(async () => {
    const g = new globalThis.__worldCtor(document.getElementById("app"), { field: true });
    const preparing = g.prepare(); await new Promise((r) => setTimeout(r, 0)); g.dispose();
    let timer;
    try { await Promise.race([preparing, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("cancelled warmup remained pending")), 3000); })]); }
    finally { clearTimeout(timer); }
    return !globalThis.__roboCraft && g.renderer.renderer.getContext().isContextLost();
  });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const lifecycleOk = cycles.every((s) => s.contextLost && s.sceneObjects === 0 && s.chunks === 0 && s.hud === 0 && s.canvas === 0 && s.debugRemoved && same(s.listeners, baselineListeners));
  const scrollGrowthMiB = scroll.at(-1).heapMiB - scroll[1].heapMiB;
  const lifecycleGrowthMiB = cycles.at(-1).heapMiB - cycles[1].heapMiB;
  const ok = lifecycleOk && cancelledWarmup && scroll.every((s) => s.chunks <= 100) && scrollGrowthMiB < 12 && lifecycleGrowthMiB < 12 && errors.length === 0;
  const report = { scroll, disposed, baselineListeners, cycles, cancelledWarmup, scrollGrowthMiB, lifecycleGrowthMiB, errors, ok };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok, lifecycleOk, scrollGrowthMiB, lifecycleGrowthMiB, errors })); process.exitCode = ok ? 0 : 1;
} finally { await browser.close(); }
