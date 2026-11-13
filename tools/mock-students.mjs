// node tools/mock-students.mjs <반 이름> [학생 수=8] [--url ws://localhost:8081/ws] [--fast]
//
// Pretend students for a class, so ONE person can see what a teacher sees. Open a class in the
// browser as the teacher (교육 → 반 만들기), then run this with the same class name: the students
// join, stand in the classroom and wait. In a fire-drill class they do what real ones would —
// wait through the briefing, and once the teacher sets them (or their team) off, each walks the
// drill at a pace of their own and reports their progress, so the F2 board fills in like a real
// lesson: some quick, some slow, one who dawdles. "멈추고 처음으로" sends them back to their desks.
// When the teacher starts the quiz (F2 → 퀴즈 시작) they answer it too, one question every few seconds.
// In a sandbox class they wander near where they arrived.
// Ctrl+C takes them out of the class. Needs the dev server (pnpm dev); `--fast` halves every wait.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const url = flag("--url") ?? "ws://localhost:8081/ws";
const fast = args.includes("--fast") ? (args.splice(args.indexOf("--fast"), 1), 0.5) : 1;
const [room, countArg] = args;
if (!room) { console.error("usage: node tools/mock-students.mjs <반 이름> [학생 수=8] [--url ws://…/ws] [--fast]"); process.exit(1); }
const count = Math.max(1, Math.min(40, Number(countArg ?? 8)));
const CLASS_V = Number(/CLASS_PROTOCOL_VERSION = (\d+)/.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../packages/shared/src/protocol/classroom.ts"), "utf8"))?.[1] ?? NaN);

const NAMES = ["민지", "서준", "하은", "도윤", "지우", "예준", "서연", "주원", "수아", "시우", "지호", "하윤", "은우", "채원", "건우", "소율", "유준", "다은", "현우", "나은",
  "준서", "아린", "지안", "태윤", "서아", "민준", "유나", "이준", "하린", "선우", "예린", "도현", "지유", "연우", "시아", "정우", "채은", "승우", "윤서", "하준"];
// The fire school (packages/shared/src/fireSchool.ts): desks to arrive at, and the way through the drill.
// A waypoint that ends a step carries the step that begins there (index into the drill's steps).
const FLOOR = 8.4;
const desk = (i) => [-13 + (i % 9) * 0.95, FLOOR, [-7.4, -8.2, -9][Math.floor(i / 9) % 3]];
const ROUTE = [
  { at: [-11.8, FLOOR, -4.6], done: 1, say: "alarm" }, // the alarm pressed → 119
  { at: [-9.2, FLOOR, -4.6], done: 2, think: 7 }, // the call made (the card takes a while)
  { at: [-14.5, FLOOR, -4.7], done: 3, think: 9 }, // the extinguisher learnt
  { at: [-17.6, FLOOR, -4.3], done: 4, think: 5 }, // the small fire out
  { at: [5.5, FLOOR, -4.1], done: 5, think: 1 }, // the towel
  { at: [0.4, FLOOR, -9.4] }, { at: [0.4, 6.2, -16.4] }, { at: [-2.4, 6.2, -16.4] }, { at: [-2.4, 4.1, -10.2] }, // down the stairs
  { at: [0, 4.1, 3], done: 6 }, // outside
  { at: [0, 4.2, 16.5], done: 7 }, // the gathering place
];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

const bots = [];
function student(i) {
  const name = NAMES[i % NAMES.length] + (i >= NAMES.length ? String(Math.floor(i / NAMES.length) + 1) : "");
  const me = {
    name, ws: null, pos: desk(i), yaw: 0, anim: "idle", joined: false, fire: false,
    team: 0, off: false, run: -1, step: 0, leg: 0, hold: 0, started: 0, quiz: 0, quizTimer: undefined,
    pace: rand(2.6, 4.2), // m/s
    slow: i % 5 === 3 ? 2.2 : 1, // every fifth child dawdles
  };
  const ws = (me.ws = new WebSocket(`${url}?${new URLSearchParams({ mode: "class", room })}`));
  ws.onopen = () => ws.send(JSON.stringify({ t: "k-join", v: CLASS_V, room, student: name }));
  ws.onmessage = (ev) => {
    const raw = typeof ev.data === "string" ? ev.data : "";
    if (raw.startsWith('{"t":"s-k-snap"')) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === "s-k-welcome") {
      me.joined = true;
      me.fire = msg.theme === "fire";
      if (!me.fire) me.pos = [rand(-6, 6), 4, rand(-6, 6)]; // the sandbox field is flat at y = 4
      console.log(`  ${name} 입장${me.fire ? " (화재 체험)" : ""}`);
    } else if (msg.t === "s-k-error") {
      console.log(`  ${name}: 들어가지 못했어요 — ${msg.code}${msg.code === "no-class" ? " (선생님이 먼저 반을 열어야 해요)" : ""}`);
    } else if (msg.t === "s-k-drill") {
      me.team = msg.teams.find(([n]) => n === name)?.[1] ?? 0;
      const off = msg.go.includes(0) || (me.team > 0 && msg.go.includes(me.team));
      if (msg.run !== me.run) { me.run = msg.run; reset(me, i); } // stopped, or new teams: back to the desk
      if (off && !me.off) { me.off = true; me.started = Date.now(); me.hold = rand(1, 4) * me.slow * fast; console.log(`  ${name} 출발${me.team ? ` (${me.team}조)` : ""}`); }
      if (!off && me.off) reset(me, i);
      // the teacher's quiz: each answers the five questions at their own speed, most of them right
      if ((msg.quiz ?? 0) !== me.quiz) {
        me.quiz = msg.quiz ?? 0;
        clearTimeout(me.quizTimer);
        if (me.quiz > 0) {
          let answered = 0, right = 0;
          const next = () => {
            if (me.quiz === 0 || ws.readyState !== 1) return;
            answered++;
            if (Math.random() < (me.slow > 1 ? 0.5 : 0.8)) right++;
            ws.send(JSON.stringify({ t: "k-drill-report", step: me.step, quiz: answered, quizScore: right }));
            if (answered < 5) me.quizTimer = setTimeout(next, rand(2500, 6500) * me.slow * fast);
            else console.log(`  ${name} 퀴즈 ${right}/5`);
          };
          me.quizTimer = setTimeout(next, rand(2000, 5000) * me.slow * fast);
        }
      }
    } else if (msg.t === "s-k-gather" && Array.isArray(msg.pos)) {
      me.pos = [...msg.pos];
    } else if (msg.t === "s-k-closed") {
      console.log(`  ${name}: 수업이 끝났어요`);
    }
  };
  ws.onclose = () => { me.joined = false; };
  bots.push(me);
}
function reset(me, i) {
  me.off = false; me.step = 0; me.leg = 0; me.hold = 0; me.anim = "idle";
  me.pos = desk(i);
}

/** One 100 ms beat of a student's life. */
function beat(me, dt) {
  if (!me.joined) return;
  if (me.fire && me.off && me.leg < ROUTE.length) {
    if (me.hold > 0) { me.hold -= dt; me.anim = "idle"; }
    else {
      const to = ROUTE[me.leg].at, d = [to[0] - me.pos[0], to[1] - me.pos[1], to[2] - me.pos[2]], len = Math.hypot(...d);
      const stride = (me.pace / me.slow) * dt;
      if (len <= stride) {
        me.pos = [...to];
        const point = ROUTE[me.leg++];
        if (point.done !== undefined) {
          me.step = point.done;
          const seconds = Math.round((Date.now() - me.started) / 1000);
          me.ws.send(JSON.stringify(me.step >= 7
            ? { t: "k-drill-report", step: 7, stars: me.slow > 1 ? 1 : Math.random() < 0.5 ? 3 : 2, seconds }
            : { t: "k-drill-report", step: me.step }));
          if (me.step >= 7) console.log(`  ${me.name} 완료 (${seconds}초)`);
        }
        me.hold = ((point.think ?? 0) + rand(0.5, 2.5)) * me.slow * fast;
      } else {
        me.pos = [me.pos[0] + (d[0] / len) * stride, me.pos[1] + (d[1] / len) * stride, me.pos[2] + (d[2] / len) * stride];
        me.yaw = Math.atan2(d[0], d[2]);
        me.anim = "run";
      }
    }
  } else if (!me.fire) {
    // a sandbox class: a slow wander
    me.yaw += rand(-0.3, 0.3);
    me.pos = [me.pos[0] + Math.sin(me.yaw) * 0.12, me.pos[1], me.pos[2] + Math.cos(me.yaw) * 0.12];
    me.anim = "run";
  }
  if (me.ws.readyState === 1) me.ws.send(JSON.stringify({ t: "k-move", pos: me.pos, yaw: me.yaw, anim: me.anim, ct: performance.now() }));
}

console.log(`가짜 학생 ${count}명이 "${room}" 반에 들어가요 (${url}) — Ctrl+C로 내보내기`);
for (let i = 0; i < count; i++) { student(i); await wait(180); }
const timer = setInterval(() => { for (const b of bots) beat(b, 0.1); }, 100);
process.on("SIGINT", () => {
  clearInterval(timer);
  for (const b of bots) try { b.ws.close(); } catch { /* already gone */ }
  console.log("\n가짜 학생들이 나갔어요");
  setTimeout(() => process.exit(0), 300);
});
