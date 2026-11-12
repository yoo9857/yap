// The BUILT water worker meshes on the Rust engine: serves apps/client/dist on one port
// (SERVE_STATIC), starts the bundle's own waterWorker chunk in a page and asks it for one chunk
// with a spring on a pillar. Passes when a mesh comes back and the .wasm came as application/wasm
// (the worker meshes on the Rust engine only).
//   pnpm build && node tools/probe-water-worker.mjs
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const chunk = readdirSync(`${root}/apps/client/dist/assets`).find((f) => /^waterWorker-.*\.js$/.test(f));
if (!chunk) throw new Error("no waterWorker chunk in apps/client/dist/assets (run pnpm build)");
const PORT = 8093;
const server = spawn(process.execPath, ["apps/server/dist/index.js"], { cwd: root,
  env: { ...process.env, PORT: String(PORT), SERVE_STATIC: "1", DB_PATH: ":memory:" }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2000));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox"] });
let ok = false;
try {
  const page = await browser.newPage();
  const wasm = [];
  browser.on("targetcreated", () => {});
  page.on("response", (r) => { if (r.url().endsWith(".wasm")) wasm.push([r.status(), r.headers()["content-type"]]); });
  page.on("workercreated", () => {});
  await page.goto(`http://localhost:${PORT}/guide/`, { waitUntil: "load", timeout: 30000 });
  const out = await page.evaluate(async (url) => {
    const X = 160, Y = 56, Z = 160;
    const ask = () => new Promise((resolve, reject) => {
      const worker = new Worker(url, { type: "module" });
      const cells = new Uint8Array(X * Y * Z);
      const at = (x, y, z) => (y * Z + z) * X + x;
      for (let x = 16; x < 32; x++) for (let z = 16; z < 32; z++) cells[at(x, 2, z)] = 1;
      for (let y = 3; y < 6; y++) cells[at(24, y, 24)] = 1;
      cells[at(24, 6, 24)] = 19; // a spring on the pillar
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        cells[at(24 + dx, 6, 24 + dz)] = 20;
        for (let y = 3; y < 6; y++) cells[at(24 + dx, y, 24 + dz)] = 27;
      }
      worker.onerror = (e) => reject(new Error(e.message || "worker error"));
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.t !== "ready") { reject(new Error(e.data.reason)); return; }
        const r = e.data.results[0];
        let sum = 0;
        for (const v of r.attributes.position.array) sum += v;
        resolve({ vertices: r.attributes.position.array.length / 3, indices: r.index.length, sum, sphere: r.sphere, ms: e.data.ms });
      };
      worker.postMessage({ t: "build", id: 1, cells, outside: null, profile: new Int32Array(0), finite: false, streams: true, simple: true,
        jobs: [{ id: 7, x: 16, z: 16, minY: 0, maxY: 10 }] });
    });
    return { first: await ask(), again: await ask() };
  }, `/assets/${chunk}`);
  await new Promise((r) => setTimeout(r, 300));
  console.log(JSON.stringify({ ...out, wasm }, null, 1));
  const same = out.first.vertices === out.again.vertices && out.first.sum === out.again.sum;
  ok = same && out.first.vertices > 100 && wasm.length > 0 && wasm.every(([status, type]) => status === 200 && type === "application/wasm");
  console.log(ok ? "PASS  the built worker meshes on the Rust engine" : "FAIL");
} finally {
  await browser.close();
  server.kill();
}
process.exit(ok ? 0 : 1);
