// Two real browsers exercise workshop motion under snapshot jitter, then
// survive a server restart and repeated transport reconnects.
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
      set onmessage(handler) {
        if (this !== globalThis.__recoverySocket || !handler) { super.onmessage = handler; return; }
        let packet = 0, deliverAt = 0;
        super.onmessage = (event) => {
          if (!globalThis.__delayClassSnapshots || !event.data.startsWith('{"t":"s-k-snap"')) {
            handler.call(this, event);
            return;
          }
          const now = performance.now();
          const delay = [40, 180, 60, 120][packet++ % 4];
          deliverAt = Math.max(now + delay, deliverAt + 1);
          setTimeout(() => handler.call(this, event), deliverAt - now);
        };
      }
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
  await teacher.evaluate(() => { globalThis.__delayClassSnapshots = true; });
  await teacher.keyboard.press("b");
  await teacher.waitForFunction(() => globalThis.__roboCraft.machine().active);
  await teacher.click('.machine-coach [data-id="skip"]');
  await student.evaluate(() => globalThis.__roboCraft.teleport(82.5, 4, 24.5));
  await teacher.waitForFunction(() => {
    const peer = globalThis.__roboCraft.classroom().remotes[0];
    return peer && Math.abs(peer.abs[2] + 55.5) < 1;
  }, { timeout: 15000 });
  check("movement updates arrive while the workshop is in preview", true);
  await teacher.click('.machine-panel [data-id="run"]');
  await teacher.waitForFunction(() => globalThis.__roboCraft.machine().simulation && globalThis.__roboCraft.classroom().remotes[0]?.visible, { timeout: 30000 });
  const startZ = await teacher.evaluate(() => globalThis.__roboCraft.classroom().remotes[0].drawn[2]);
  await student.evaluate(() => {
    globalThis.__roboCraft.look(0, 0);
    globalThis.__roboCraft.debugWalk(0, 1);
  });
  await teacher.waitForFunction((start) => {
    const room = globalThis.__roboCraft.classroom();
    return room.online && globalThis.__roboCraft.machine().simulation
      && room.remotes[0]?.visible && Math.abs(room.remotes[0].drawn[2] - start) > 3;
  }, { timeout: 20000 }, startZ);
  check("classmate visibly moves during a machine test with 40–180 ms snapshot delay", true);
  await student.evaluate(() => {
    const game = globalThis.__roboCraft;
    game.debugWalk(0, 0);
    // Return within view of the teacher for the GPU resource check, even
    // after walking shifted this client's world window.
    const [ax, az] = game.absolute();
    const [x, , z] = game.snapshot().pos;
    const [teacherX, , teacherZ] = game.classroom().remotes[0].abs;
    game.teleport(x + teacherX - ax, 4, z + teacherZ - az - 5);
    game.look(0, 0);
  });
  await teacher.click('.machine-panel [data-id="run"]');
  await teacher.click('.machine-panel [data-id="close"]');
  await teacher.evaluate(() => { globalThis.__delayClassSnapshots = false; });
  await teacher.evaluate(() => globalThis.__roboCraft.placeAt(76, 4, 82, "gold-block"));
  await student.waitForFunction(() => globalThis.__roboCraft.blockAtAbs(-4, 4, 2) === 17, { timeout: 10000 });
  const before = await Promise.all([teacher, student].map((p) => p.evaluate(() => globalThis.__roboCraft.classroom().you)));
  await wait(16000); // SQLite autosave before the Windows process is terminated
  await stopServer();
  await Promise.all([teacher, student].map((p) => p.waitForFunction(() => !globalThis.__roboCraft.classroom().online, { timeout: 10000 })));
  await wait(1500); await startServer();
  await Promise.all([teacher, student].map((p, i) => p.waitForFunction((old) => {
    const c = globalThis.__roboCraft.classroom(); return c.online && c.you !== old && c.remotes.length === 1;
  }, { timeout: 45000 }, before[i])));
  check("teacher and student recover fresh server identities without reloading", true);
  check("the saved classroom survives the server restart", await student.evaluate(() => globalThis.__roboCraft.blockAtAbs(-4, 4, 2) === 17));
  const cycles = [];
  for (let i = 0; i < 4; i++) {
    await student.evaluate(() => globalThis.__recoverySocket.close());
    await student.waitForFunction(() => !globalThis.__roboCraft.classroom().online, { timeout: 5000 });
    await student.waitForFunction(() => {
      const room = globalThis.__roboCraft.classroom();
      return room.online && room.remotes.length === 1 && room.remotes[0].visible;
    }, { timeout: 15000 });
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
