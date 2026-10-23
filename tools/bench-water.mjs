// CPU geometry cost, topology size and resource lifecycle. Run against pnpm dev.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
});
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:5173/?mode=field&reset=1", { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 60000 });
  const result = await page.evaluate(async () => {
    const { VoxelWorld } = await import("/src/craft/voxelWorld.ts");
    const { buildWaterGeometry } = await import("/src/craft/waterMesh.ts");
    const world = new VoxelWorld();
    const cells = [];
    for (let x = 16; x < 48; x++) for (let z = 16; z < 48; z++) {
      world.set(x, 0, z, 3);
      for (let y = 1; y <= 4; y++) { world.set(x, y, z, 19); cells.push(x, y, z); }
    }
    for (let x = 15; x <= 48; x++) for (let y = 1; y <= 4; y++) {
      world.set(x, y, 15, 3); world.set(x, y, 48, 3);
    }
    for (let z = 15; z <= 48; z++) for (let y = 1; y <= 4; y++) {
      world.set(15, y, z, 3); world.set(48, y, z, 3);
    }
    const measure = (label, w, batch) => {
      const times = [];
      let vertices = 0, triangles = 0, bytes = 0;
      for (let i = 0; i < 15; i++) {
        const start = performance.now();
        const geometry = buildWaterGeometry(w, batch);
        const ms = performance.now() - start;
        if (i >= 3) times.push(ms);
        if (geometry) {
          vertices = geometry.getAttribute("position").count;
          triangles = (geometry.index?.count ?? vertices) / 3;
          bytes = Object.values(geometry.attributes).reduce((n, a) => n + a.array.byteLength, geometry.index?.array.byteLength ?? 0);
          geometry.dispose();
        }
      }
      times.sort((a, b) => a - b);
      return { label, cells: batch.length / 3, vertices, triangles, bytes, medianMs: times[6], p95Ms: times[11] };
    };
    const result = [measure("32x32 deep pool", world, cells)];
    const fall = new VoxelWorld(), fc = [];
    for (let x = 16; x < 32; x++) for (let y = 4; y < 24; y++) {
      fall.set(x, y, 30, 3); fall.set(x, y, 31, 27); fc.push(x, y, 31);
    }
    result.push(measure("16x20 waterfall", fall, fc));
    return result;
  });
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
