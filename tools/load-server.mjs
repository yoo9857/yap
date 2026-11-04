// Server load test with REAL WebSockets: classes of walking, building students
// against an isolated server (its own port and a throw-away database), while
// the server's own /metrics is sampled. Never point this at production.
//
//   node tools/load-server.mjs --classes 20 --students 25 --duration 40
//   node tools/load-server.mjs --classes 20 --students 25 --shards 4
//   node tools/load-server.mjs --url ws://127.0.0.1:8081/ws ...   (a server you started)
//
// Options: --classes C  --students S (per class, + 1 teacher)  --duration s (measured)
//          --warmup s   --edit-every s (per bot, 0 = never)     --water (teachers pour water)
//          --shards N (SHARDS for the spawned server)  --bot-procs K  --cpus (taskset-like note only)
//          --out file.json
//
// What it reports, and why each number:
//   server.elu        event-loop utilisation: ~0.7+ means messages queue behind each other
//   server.lagP99     how late timers fire; the 10 Hz snapshot is a timer
//   client.snapGapP99 time between snapshots as a STUDENT sees it (100 ms is perfect)
//   client.editP99    one student places a brick → classmates see it
import { fork, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), "..");
const CLASS_V = 8; // CLASS_PROTOCOL_VERSION — a mismatch shows up as bad-version below

function args(argv) {
  const o = { classes: 10, students: 20, duration: 30, warmup: 8, editEvery: 2, water: false, shards: 1, botProcs: 2, url: "", out: "", port: 8090 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    const camel = k.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    if (camel === "water") { o.water = true; continue; }
    if (!(camel in o)) throw new Error(`unknown option --${k}`);
    o[camel] = typeof o[camel] === "number" ? Number(argv[++i]) : argv[++i];
  }
  return o;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] : 0);

// ---------------------------------------------------------------- bot process

async function botMain(spec) {
  const { url, classes, students, warmup, duration, editEvery, water, run } = spec;
  const sockets = [];
  let joined = 0, failed = 0, dropped = 0, bytes = 0;
  const errors = {};
  const gaps = [];
  const editLat = [];
  const pending = new Map(); // "room|x,y,z" → send time
  let measuring = false;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function bot(room, role, name, cx, cz) {
    return new Promise((resolve) => {
      const qs = new URLSearchParams({ mode: "class", room }); // newer servers route on `room`
      const ws = new WebSocket(`${url}?${qs}`);
      const me = { ws, room, name, lastSnap: 0, x: cx, z: cz, phase: Math.random() * Math.PI * 2, open: false };
      sockets.push(me);
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; clearTimeout(giveUp); resolve(ok ? me : null); } };
      // a handshake nobody answers must not stall the whole run
      const giveUp = setTimeout(() => { errors[`${role}-timeout`] = (errors[`${role}-timeout`] ?? 0) + 1; failed++; done(false); try { ws.close(); } catch { /* already gone */ } }, 20000);
      ws.onopen = () => {
        me.open = true;
        ws.send(JSON.stringify(role === "teacher"
          ? { t: "k-host", v: CLASS_V, room, teacher: name, password: "load1234" }
          : { t: "k-join", v: CLASS_V, room, student: name }));
      };
      ws.onmessage = (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : "";
        if (measuring) bytes += raw.length;
        const t = raw.slice(6, 20);
        if (t.startsWith("s-k-snap")) {
          const now = performance.now();
          if (measuring && me.lastSnap) gaps.push(now - me.lastSnap);
          me.lastSnap = now;
          return;
        }
        const msg = JSON.parse(raw);
        if (msg.t === "s-k-welcome") { joined++; done(true); }
        else if (msg.t === "s-k-error") { errors[msg.code] = (errors[msg.code] ?? 0) + 1; failed++; done(false); }
        else if (msg.t === "s-k-edit" && measuring) {
          for (const [x, y, z] of msg.edits) {
            const key = `${room}|${x},${y},${z}`; // the first classmate to see it
            const sent = pending.get(key);
            if (sent !== undefined) { editLat.push(performance.now() - sent); pending.delete(key); }
          }
        }
      };
      ws.onclose = (ev) => {
        if (me.open && settled) dropped++;
        if (!settled) { const k = `${role}-closed:${ev.code}:${ev.reason}`; errors[k] = (errors[k] ?? 0) + 1; failed++; }
        me.open = false; done(false);
      };
      ws.onerror = () => {};
    });
  }

  // teachers first (a student cannot join a class that is not open), then students
  const rooms = classes.map((i) => ({ i, name: `L${run}-${i}`.slice(0, 20), bots: [] }));
  await Promise.all(rooms.map(async (r) => {
    const t = await bot(r.name, "teacher", `T${r.i}`, 0, 0);
    if (t) r.bots.push(t);
  }));
  for (const r of rooms) {
    for (let s = 0; s < students; s++) {
      const angle = (s / students) * Math.PI * 2;
      bot(r.name, "student", `S${r.i}x${s}`, Math.cos(angle) * 12, Math.sin(angle) * 12).then((b) => b && r.bots.push(b));
      await wait(15); // a class does not arrive in the same millisecond
    }
  }
  await wait(1500);

  // walking: k-move every 100 ms (what the client sends: every 6th 60 Hz tick)
  const start = performance.now();
  const mover = setInterval(() => {
    const t = (performance.now() - start) / 1000;
    for (const r of rooms) for (const b of r.bots) {
      if (!b.open || b.ws.readyState !== 1) continue;
      const a = b.phase + t * 0.6;
      b.ws.send(JSON.stringify({ t: "k-move", pos: [b.x + Math.cos(a) * 4, 4, b.z + Math.sin(a) * 4], yaw: a, anim: "run", ct: performance.now() }));
    }
  }, 100);

  // building: each bot places then removes a brick near itself; classmates' echo = latency
  let editTimer = null;
  if (editEvery > 0) {
    let tick = 0;
    editTimer = setInterval(() => {
      tick++;
      for (const r of rooms) for (const b of r.bots) {
        if (!b.open || b.ws.readyState !== 1) continue;
        if (Math.random() > 0.25 / editEvery) continue; // ~1 edit per editEvery seconds per bot
        const x = Math.round(b.x) + (tick % 5), z = Math.round(b.z), y = 4 + (tick % 2);
        const place = !b.placed;
        b.placed = place;
        if (measuring) pending.set(`${r.name}|${x},${y},${z}`, performance.now());
        b.ws.send(JSON.stringify({ t: "k-edit", edits: [[x, y, z, place ? 5 : 0, 0]] }));
      }
    }, 250);
  }
  let waterTimer = null;
  if (water) {
    waterTimer = setInterval(() => {
      for (const r of rooms) {
        const teacher = r.bots[0];
        if (!teacher?.open) continue;
        const x = Math.floor(Math.random() * 40) - 20, z = Math.floor(Math.random() * 40) - 20;
        teacher.ws.send(JSON.stringify({ t: "k-edit", edits: [[x, 9, z, 19, 0]] }));
      }
    }, 3000);
  }

  await wait(warmup * 1000);
  measuring = true;
  process.send({ t: "measuring" });
  await wait(duration * 1000);
  measuring = false;

  clearInterval(mover);
  if (editTimer) clearInterval(editTimer);
  if (waterTimer) clearInterval(waterTimer);
  gaps.sort((a, b) => a - b);
  editLat.sort((a, b) => a - b);
  const result = {
    planned: classes.length * (students + 1), joined, failed, dropped, errors,
    bytes, gaps: gaps.length, gapP50: pct(gaps, 50), gapP99: pct(gaps, 99), gapMax: gaps.at(-1) ?? 0,
    edits: editLat.length, editP50: pct(editLat, 50), editP99: pct(editLat, 99), editMax: editLat.at(-1) ?? 0,
    gapSample: gaps.filter((_, i) => i % Math.max(1, Math.floor(gaps.length / 4000)) === 0),
    editSample: editLat.filter((_, i) => i % Math.max(1, Math.floor(editLat.length / 4000)) === 0),
  };
  for (const s of sockets) try { s.ws.close(); } catch { /* already gone */ }
  process.send({ t: "result", result });
  setTimeout(() => process.exit(0), 300);
}

// ---------------------------------------------------------------- orchestrator

async function main() {
  const o = args(process.argv.slice(2));
  let server = null, dbDir = null;
  let wsUrl = o.url;
  let metricsUrl = "";
  if (!wsUrl) {
    dbDir = mkdtempSync(join(tmpdir(), "craftyap-load-"));
    const env = {
      ...process.env, PORT: String(o.port), HOST: "127.0.0.1", LOG_LEVEL: "warn",
      DB_PATH: join(dbDir, "records.db"), SERVE_STATIC: "0", SHARDS: String(o.shards),
      MAX_CONN_PER_IP: "100000", MAX_CONNECTIONS: "100000",
    };
    server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: join(ROOT, "apps/server"), env, stdio: ["ignore", "inherit", "inherit"] });
    wsUrl = `ws://127.0.0.1:${o.port}/ws`;
    metricsUrl = `http://127.0.0.1:${o.port}/metrics`;
    for (let i = 0; ; i++) {
      try { if ((await fetch(`http://127.0.0.1:${o.port}/healthz`)).ok) break; } catch { /* already gone */ }
      if (i > 150) throw new Error("server did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
  } else {
    metricsUrl = wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "/metrics");
  }

  const run = Date.now().toString(36).slice(-5);
  const procs = Math.max(1, Math.min(o.botProcs, o.classes));
  const children = [];
  const results = [];
  let measuringSince = 0;
  const allMeasuring = new Promise((resolve) => {
    let n = 0;
    for (let p = 0; p < procs; p++) {
      const classes = [];
      for (let c = p; c < o.classes; c += procs) classes.push(c);
      const child = fork(SELF, ["--bot"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
      child.send({ url: wsUrl, classes, students: o.students, warmup: o.warmup, duration: o.duration, editEvery: o.editEvery, water: o.water, run });
      child.on("message", (m) => {
        if (m.t === "measuring" && ++n === procs) { measuringSince = performance.now(); resolve(); }
        if (m.t === "result") results.push(m.result);
      });
      child.on("exit", (code) => { if (code && n < procs) { console.error(`bot process exited ${code} before measuring`); process.exit(1); } });
      children.push(child);
    }
  });

  await allMeasuring;
  await fetch(metricsUrl).catch(() => null); // start a fresh /metrics window
  const samples = [];
  const sampler = setInterval(async () => {
    try { samples.push(await (await fetch(metricsUrl)).json()); } catch { /* already gone */ }
  }, 2000);
  await Promise.all(children.map((c) => new Promise((r) => c.on("exit", r))));
  clearInterval(sampler);
  const measuredS = (performance.now() - measuringSince) / 1000;

  // ---- fold
  const sum = (k) => results.reduce((s, r) => s + r[k], 0);
  const gaps = results.flatMap((r) => r.gapSample).sort((a, b) => a - b);
  const edits = results.flatMap((r) => r.editSample).sort((a, b) => a - b);
  const procSamples = samples.flatMap((s) => s.processes ?? []);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const byPid = new Map();
  for (const p of procSamples) { if (!byPid.has(p.pid)) byPid.set(p.pid, []); byPid.get(p.pid).push(p); }
  const perProcess = [...byPid.entries()].map(([pid, xs]) => ({
    pid, role: xs[0].role, cpu: +avg(xs.map((x) => x.cpu)).toFixed(3), elu: +avg(xs.map((x) => x.elu)).toFixed(3),
    lagP99Max: Math.max(...xs.map((x) => x.lagMs.p99)), rssMaxMiB: Math.max(...xs.map((x) => x.rssMiB)),
  }));
  const report = {
    scenario: { classes: o.classes, studentsPerClass: o.students, players: o.classes * (o.students + 1), shards: o.shards, editEvery: o.editEvery, water: o.water, measuredS: +measuredS.toFixed(1) },
    server: {
      cpuCoresTotal: +perProcess.reduce((s, p) => s + p.cpu, 0).toFixed(2),
      eluMax: Math.max(0, ...perProcess.map((p) => p.elu)),
      lagP99Max: Math.max(0, ...perProcess.map((p) => p.lagP99Max)),
      rssTotalMiB: perProcess.reduce((s, p) => s + p.rssMaxMiB, 0),
      perProcess,
      peak: samples.reduce((best, s) => ((s.totals?.online ?? 0) >= (best?.online ?? -1) ? s.totals : best), null),
    },
    client: {
      joined: sum("joined"), planned: sum("planned"), failed: sum("failed"), dropped: sum("dropped"),
      errors: results.reduce((acc, r) => { for (const [k, v] of Object.entries(r.errors)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {}),
      snapGapP50: +pct(gaps, 50).toFixed(1), snapGapP99: +pct(gaps, 99).toFixed(1), snapGapMax: +Math.max(0, ...results.map((r) => r.gapMax)).toFixed(1),
      editEchoes: sum("edits"), editP50: +pct(edits, 50).toFixed(1), editP99: +pct(edits, 99).toFixed(1),
      downKBps: +(sum("bytes") / 1024 / measuredS).toFixed(0),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (o.out) writeFileSync(o.out, JSON.stringify(report, null, 2));

  if (server) {
    server.kill("SIGTERM");
    await new Promise((r) => { server.on("exit", r); setTimeout(r, 6000); });
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

if (process.argv.includes("--bot")) {
  process.once("message", (spec) => botMain(spec).catch((err) => { console.error(err); process.exit(1); }));
} else {
  main().catch((err) => { console.error(err); process.exit(1); });
}
