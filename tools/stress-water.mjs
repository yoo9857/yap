// Isolated browser load/resource probe. Never edits a user's saved world or
// sends bulk traffic to production. Requires pnpm dev (BASE_URL defaults local).
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
const out = process.argv[2] ?? "tmp/water-load";
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--enable-precise-memory-info"],
});
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${process.env.BASE_URL ?? "http://localhost:5173"}/?mode=field&reset=1`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 60000 });
  const dense = await page.evaluate(async () => {
    const { FieldWindow } = await import("/src/craft/fieldWorld.ts");
    const { WaterSim } = await import("/src/craft/waterSim.ts");
    const field = new FieldWindow(), sim = new WaterSim(field.world, { markWaterDirty() {} }, field);
    const furniture = new Set(["60,12,60"]);
    field.world.propSolid = (x, y, z) => furniture.has(`${x},${y},${z}`);
    for (let y = 4; y < 24; y++) for (let z = 16; z < 116; z++) for (let x = 16; x < 116; x++) field.world.set(x, y, z, 19);
    const start = performance.now(); sim.wakeAll(); const requestMs = performance.now() - start;
    const times = []; let pendingPeak = 0;
    for (let i = 0; i < 3000; i++) {
      const t = performance.now(); sim.update(1 / 60); times.push(performance.now() - t);
      const s = sim.stats(); pendingPeak = Math.max(pendingPeak, s.pending);
      if (!s.waking && s.pending === 0) break;
      if (i % 16 === 15) await new Promise((r) => setTimeout(r, 0));
    }
    times.sort((a, b) => a - b);
    return { cells: 200000, furnitureCollision: true, activationRequestMs: requestMs, updates: times.length, medianUpdateMs: times[Math.floor(times.length / 2)],
      p95UpdateMs: times[Math.floor(times.length * 0.95)], maxUpdateMs: times.at(-1), pendingPeak, final: sim.stats() };
  });
  console.log("dense", JSON.stringify(dense));
  const cdp = await page.createCDPSession();
  const cycles = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    const result = await page.evaluate(async (cycle) => {
      const THREE = await import("/node_modules/.vite/deps/three.js");
      const { VoxelWorld } = await import("/src/craft/voxelWorld.ts");
      const { VoxelView } = await import("/src/craft/voxelView.ts");
      let fixture = globalThis.__waterLoadFixture;
      if (!fixture) {
        const world = new VoxelWorld(), scene = new THREE.Scene(), view = new VoxelView(scene);
        const renderer = new THREE.WebGLRenderer({ antialias: false }); renderer.setSize(480, 320);
        const camera = new THREE.PerspectiveCamera(60, 1.5, 0.1, 200); camera.position.set(86, 30, 86); camera.lookAt(72, 16, 72);
        scene.add(new THREE.AmbientLight(0xffffff, 2));
        fixture = globalThis.__waterLoadFixture = { world, scene, view, renderer, camera, eye: new THREE.Vector3(72, 20, 72) };
      }
      const { world, scene, view, renderer, camera, eye } = fixture;
      const flush = async () => {
        const deadline = performance.now() + 30000; let peakMainMs = 0;
        do {
          const t = performance.now(); view.update(world, eye); peakMainMs = Math.max(peakMainMs, performance.now() - t);
          if (view.waterStats().queued + view.waterStats().pending === 0) break;
          if (performance.now() > deadline) throw new Error("water meshing did not finish");
          await new Promise((r) => setTimeout(r, 4));
        } while (performance.now() < deadline);
        if (view.waterStats().queued + view.waterStats().pending !== 0) throw new Error("water meshing did not finish");
        return peakMainMs;
      };
      const apply = (id) => {
        for (let y = 8; y < 24; y++) for (let z = 48; z < 96; z++) for (let x = 48; x < 96; x++)
          if ((x + y + z) % 2 === 0) { world.set(x, y, z, id); view.markWaterDirty(x, y, z); }
      };
      apply(19); let peakMainMs = await flush(); renderer.render(scene, camera);
      // Replace an existing dense generation too: interpolation must not build
      // a huge temporary key map on the input thread.
      apply(22); peakMainMs = Math.max(peakMainMs, await flush()); renderer.render(scene, camera);
      const workerMeshMs = view.waterStats().workerMeshMs;
      let geometryBytes = 0, vertices = 0;
      scene.traverse((o) => {
        if (o.isMesh && o.geometry.getAttribute("aGrid")) {
          vertices += o.geometry.getAttribute("position").count;
          geometryBytes += Object.values(o.geometry.attributes).reduce((n, a) => n + a.array.byteLength, o.geometry.index.array.byteLength);
        }
      });
      const loaded = { ...renderer.info.memory };
      apply(0); await flush(); renderer.render(scene, camera);
      return { cycle, cells: 18432, vertices, geometryBytes, peakMainMs, workerMeshMs,
        loaded, cleared: { ...renderer.info.memory }, stats: view.waterStats() };
    }, cycle);
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    result.mainHeapMiB = heap.usedSize / 1048576;
    result.workerHeapMiB = 0;
    result.workerBackingMiB = 0;
    for (const worker of page.workers()) {
      if (!worker.url().includes("waterWorker")) continue;
      await worker.client.send("HeapProfiler.collectGarbage");
      const workerHeap = await worker.client.send("Runtime.getHeapUsage");
      result.workerHeapMiB += workerHeap.usedSize / 1048576;
      result.workerBackingMiB += (workerHeap.backingStorageSize ?? 0) / 1048576;
    }
    cycles.push(result); console.log("cycle", JSON.stringify(result));
  }
  await page.evaluate(() => {
    const f = globalThis.__waterLoadFixture; f.view.dispose(); f.renderer.dispose(); f.renderer.forceContextLoss();
    delete globalThis.__waterLoadFixture;
  });
  const plateau = cycles.slice(1).every((c) => c.cleared.geometries === cycles[1].cleared.geometries && c.cleared.textures === cycles[1].cleared.textures);
  const heapGrowthMiB = cycles.at(-1).mainHeapMiB - cycles[1].mainHeapMiB;
  const workerHeapGrowthMiB = cycles.at(-1).workerHeapMiB - cycles[1].workerHeapMiB;
  const ok = plateau && heapGrowthMiB < 8 && workerHeapGrowthMiB < 8 && !dense.final.waking && dense.final.pending === 0 && errors.length === 0;
  const report = { dense, cycles, plateau, heapGrowthMiB, workerHeapGrowthMiB, errors, ok };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok, plateau, heapGrowthMiB, workerHeapGrowthMiB, errors }));
  process.exitCode = ok ? 0 : 1;
} finally { await browser.close(); }
