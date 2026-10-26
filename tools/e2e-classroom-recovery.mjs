// Two real browsers survive an isolated server restart, then repeat transport
// reconnects without duplicate self avatars or growing GPU label resources.
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const port = 8097, out = resolve(process.argv[2] ?? "tmp/classroom-recovery"), browsers = [], errors = [], checks = [];
await mkdir(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok) => { checks.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); };
let server = null;
async function startServer() {
  server = spawn(process.execPath, ["apps/server/dist/index.js"], { windowsHide: true,
    env: { ...process.env, PORT: String(port), DB_PATH: resolve(out, "records.db"), SERVE_STATIC: "1" },
    stdio: ["ignore", "ignore", "pipe"] });
  server.stderr.on("data", (d) => process.stderr.write(d));
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error("isolated server exited before startup");
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch { /* booting */ }
    await wait(100);
  }
  throw new Error("isolated server did not start");
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const old = server; await new Promise((r) => { old.once("exit", r); old.kill(); }); server = null;
}
const room = `Recovery${Date.now() % 100000}`;
async function open(query) {
  const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox"] }); browsers.push(browser);
  const page = await browser.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument((port) => {
    const Native = globalThis.WebSocket;
    globalThis.WebSocket = class extends Native {
      constructor(url, protocols) {
        const parsed = new URL(url, location.href), classroom = parsed.pathname === "/ws" && parsed.searchParams.get("mode") === "class";
        if (classroom) { parsed.hostname = "127.0.0.1"; parsed.port = String(port); parsed.protocol = "ws:"; }
        if (protocols === undefined) super(parsed.href); else super(parsed.href, protocols);
        if (classroom) globalThis.__recoverySocket = this;
      }
    };
  }, port);
  await page.goto(`http://localhost:5173/?mode=field&room=${room}${query}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => globalThis.__roboCraft?.classroom()?.online && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 60000 });
  return page;
}
try {
  await startServer();
  const teacher = await open("&host=Teacher&pass=1234"), student = await open("&student=Student");
  await teacher.evaluate(() => globalThis.__roboCraft.placeAt(76, 4, 82, "gold-block"));
  await student.waitForFunction(() => globalThis.__roboCraft.blockAt(76, 4, 82) === 17, { timeout: 10000 });
  const before = await Promise.all([teacher, student].map((p) => p.evaluate(() => globalThis.__roboCraft.classroom().you)));
  await wait(16000); // SQLite autosave before the Windows process is terminated
  await stopServer();
  await Promise.all([teacher, student].map((p) => p.waitForFunction(() => !globalThis.__roboCraft.classroom().online, { timeout: 10000 })));
  await wait(1500); await startServer();
  await Promise.all([teacher, student].map((p, i) => p.waitForFunction((old) => {
    const c = globalThis.__roboCraft.classroom(); return c.online && c.you !== old && c.remotes.length === 1;
  }, { timeout: 45000 }, before[i])));
  check("teacher and student recover fresh server identities without reloading", true);
  check("the saved classroom survives the server restart", await student.evaluate(() => globalThis.__roboCraft.blockAt(76, 4, 82) === 17));
  const cycles = [];
  for (let i = 0; i < 4; i++) {
    await student.evaluate(() => globalThis.__recoverySocket.close());
    await student.waitForFunction(() => !globalThis.__roboCraft.classroom().online, { timeout: 5000 });
    await student.waitForFunction(() => globalThis.__roboCraft.classroom().online && globalThis.__roboCraft.classroom().remotes.length === 1, { timeout: 15000 });
    await wait(1300);
    cycles.push(await student.evaluate(() => ({ class: globalThis.__roboCraft.classroom(), perf: globalThis.__roboCraft.perf(),
      selfRows: [...document.querySelectorAll(".class-members .name")].filter((e) => e.textContent.includes("(나)")).length })));
  }
  check("self avatars are excluded after restart and every reconnect", cycles.every((c) => !c.class.remotes.some((r) => r.id === c.class.you) && c.selfRows === 1));
  check("remote label GPU resources plateau", cycles.slice(1).every((c) => c.perf.textures === cycles[1].perf.textures && c.perf.geometries === cycles[1].perf.geometries));
  check("no browser exceptions", errors.length === 0);
  await teacher.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-end" }));
  await writeFile(resolve(out, "report.json"), JSON.stringify({ before, cycles, errors, checks }, null, 2));
  process.exitCode = checks.every(Boolean) ? 0 : 1;
} finally { for (const b of browsers) await b.close(); await stopServer(); }
