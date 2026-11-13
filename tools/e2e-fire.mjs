// node tools/e2e-fire.mjs [shotdir] — the fire drill theme (화재 체험), end to end. Needs `pnpm dev`.
//
//  1. Solo, through the menu: 교육 → 혼자 하기 → 화재 체험. The school stands (the Blender campus:
//     our classroom is on the upper floor), nothing can be built, and the whole drill is played:
//     alarm (aimed at, used with the real "use what is under the crosshair" path) → 119 card →
//     extinguisher card → the small fire sprayed out → the smoke comes along the corridor → towel →
//     low under the smoke → down the stairs and out → the gathering place → result card → again.
//  2. A class: the teacher picks the theme when opening the class; the student's confirm card names
//     it; both stand in the same school. The class starts in the BRIEFING (no fire, students kept in
//     the classroom); the teacher's F2 class tools form teams and set team 1 off; the student's drill
//     begins, its progress shows on the board; stop puts everyone back; the server refuses edits.
//     (Each participant in its own browser: background tabs pause rAF.)
// ONLY=class skips the solo half. Coordinates are the school's own (packages/shared/src/fireSchool.ts).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browsers = [];
const errors = [];

async function open(label) {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: "new",
    args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,760"],
  });
  browsers.push(browser);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760 });
  page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
  page.on("dialog", (d) => void d.accept());
  return page;
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const fire = (page) => page.evaluate(() => globalThis.__roboCraft.fire());
const where = (page) => page.evaluate(() => globalThis.__roboCraft.absolute());
const booted = async (page) => {
  await page.waitForFunction(() => !!globalThis.__roboCraft?.fire?.(), { timeout: 60000 });
  await sleep(2500);
};
// The school (fireSchool.ts): the upper floor, the corridor's middle line, our classroom and the burning room.
const FLOOR = 8.4, GROUND = 4.1, CORRIDOR = -4.4;
const CLASSROOM = { x0: -14.1, x1: -4.35, z0: -21.85, z1: -6.85 };
const inClassroom = (p) => p[0] > CLASSROOM.x0 && p[0] < CLASSROOM.x1 && p[1] > CLASSROOM.z0 && p[1] < CLASSROOM.z1;
const NORTH = Math.PI, EAST = Math.PI / 2, WEST = -Math.PI / 2, SOUTH = 0;
/** Stand at absolute (x, y, z), looking along yaw / pitch, with the drill's clock running. */
const stand = async (page, x, y, z, yaw, pitch = 0, ms = 500) => {
  await page.evaluate((x, y, z, yaw, pitch) => {
    const c = globalThis.__roboCraft;
    c.firePlay(true);
    c.teleportAbs(x, y, z, yaw);
    c.look(yaw, pitch);
  }, x, y, z, yaw, pitch);
  await sleep(ms);
};

// ------------------------------------------------------------------ 1. solo, through the menu
if (process.env.ONLY !== "class") {
  const page = await open("solo");
  await page.goto(`${BASE}/?play=1`, { waitUntil: "networkidle2", timeout: 30000 });
  await page.click('[data-pick="field"]');
  await page.waitForSelector('[data-go="solo"]');
  await page.click('[data-go="solo"]');
  await page.waitForSelector('[data-solo="fire"]', { visible: true });
  await shot(page, "01-solo-themes");
  await page.click('[data-solo="fire"]');
  await booted(page);
  const start = await fire(page);
  check("solo: the fire drill starts at its first step", start?.step === "alarm" && start.waiting === false, JSON.stringify(start?.step));
  check("the sandbox's bars are put away (no hotbar, no chips)", await page.evaluate(() =>
    document.body.classList.contains("theme-fire") && getComputedStyle(document.querySelector(".craft-hotbar")).display === "none"));
  const guide = await page.$eval(".fire-guide-text", (el) => el.textContent);
  check("the guide names the first thing to do", /화재경보기|fire alarm/.test(guide), guide);
  const home = await where(page);
  check("the drill begins in our classroom, on the upper floor", inClassroom(home), JSON.stringify(home));
  check("the school's stations are there (alarm, phone, extinguisher, towel, sign)", ["alarm", "phone", "extinguisher", "towel", "sign"].every((k) => start.stations.some((s) => s.kind === k)));
  check("the sandbox field's save is not written by the drill", (await page.evaluate(() => localStorage.getItem("craftyap-field-v1"))) === null);

  // nothing is built here: the right-click path places no block (hands are empty for the whole drill)
  await page.evaluate(() => { const c = globalThis.__roboCraft; c.firePlay(true); c.look(0, -0.9); });
  await sleep(300);
  const before = await page.evaluate(() => globalThis.__roboCraft.snapshot());
  await page.evaluate(() => globalThis.__roboCraft.scienceRightClick());
  await sleep(200);
  const built = await page.evaluate(() => globalThis.__roboCraft.snapshot());
  check("a right click on the floor builds nothing", JSON.stringify(built.inventory ?? null) === JSON.stringify(before.inventory ?? null) && (await fire(page)).step === "alarm");

  // alone, the classroom has a quiz board on its door wall: look at it, press E, the quiz opens
  const board = (await fire(page)).quizBoard;
  check("alone, a quiz board hangs in our classroom", board !== null && board.at[0] > CLASSROOM.x0 && board.at[0] < CLASSROOM.x1, JSON.stringify(board?.at));
  if (board) {
    await stand(page, board.stand[0], FLOOR, board.stand[2], board.yaw, 0.02);
    // (a page that has just booted draws its first frames late on a software GPU: wait for the aim, not for a time)
    await page.waitForFunction(() => globalThis.__roboCraft.fire().quizBoard?.aimed === true, { timeout: 20000 }).catch(() => {});
    const at = await fire(page);
    check("looked at, it offers the quiz", at.quizBoard.aimed === true && /퀴즈|quiz/i.test(at.prompt ?? ""), at.prompt);
    await page.evaluate(() => globalThis.__roboCraft.fireInteract());
    await page.waitForSelector(".fire-quiz .fz-ask", { timeout: 5000 });
    check("E opens the quiz (the drill waits), with a way out", (await fire(page)).panel === "quiz" && (await page.$(".fire-quiz .fz-close")) !== null);
    await shot(page, "02b-quiz-board");
    await page.click(".fire-quiz .fz-close");
    await sleep(300);
    check("closed, play goes on where it was", (await fire(page)).panel === null && (await fire(page)).step === "alarm");
  }

  // the alarm: aimed at from the corridor, used through the real "use what is under the crosshair" path
  await stand(page, -11.8, FLOOR, CORRIDOR, NORTH, 0.02);
  const aimed = await fire(page);
  check("the alarm under the crosshair is offered (badge → prompt)", aimed.aimed === "alarm" && /화재경보기|alarm/.test(aimed.prompt ?? ""), `${aimed.aimed} / ${aimed.prompt}`);
  await shot(page, "02-alarm-prompt");
  // a wall between: from inside the classroom the corridor's stations cannot be used
  await stand(page, -11.8, FLOOR, -8.2, SOUTH, 0.02);
  check("a station behind a wall is not offered", (await fire(page)).aimed === null, String((await fire(page)).aimed));
  await stand(page, -11.8, FLOOR, CORRIDOR, NORTH, 0.02);
  // out of turn first: the phone says "not yet"
  await page.evaluate(() => globalThis.__roboCraft.fireUse("phone"));
  check("a station out of turn changes nothing", (await fire(page)).step === "alarm");
  check("E / right click uses the aimed station", await page.evaluate(() => globalThis.__roboCraft.fireInteract()));
  const rung = await fire(page);
  check("the alarm rings and the drill moves on to 119", rung.alarm === true && rung.step === "call", rung.step);

  // 119: the card is a lesson — dial, then say where and what
  await stand(page, -9.2, FLOOR, CORRIDOR, NORTH, 0.02);
  await page.evaluate(() => globalThis.__roboCraft.fireInteract());
  await page.waitForSelector('.fire-panel[data-panel="call"]');
  check("the phone opens the 119 card (the drill waits)", (await fire(page)).panel === "call" && (await fire(page)).step === "call");
  for (const k of ["1", "1", "2"]) await page.click(`.fire-key[data-k="${k}"]`);
  await page.click(".fire-key.call");
  const wrong = await page.$eval('.fire-panel [data-id="hint"]', (el) => el.textContent);
  check("a wrong number is corrected (112 is the police)", /119/.test(wrong), wrong);
  for (const k of ["1", "1", "9"]) await page.click(`.fire-key[data-k="${k}"]`);
  await page.click(".fire-key.call");
  await page.waitForSelector(".fire-choice");
  await page.click('.fire-choice[data-i="1"]'); // "Fire!!" and hang up
  check("hanging up without the place is explained", (await page.$eval('.fire-panel [data-id="hint"]', (el) => el.textContent)).length > 5);
  await shot(page, "03-call-card");
  await page.click('.fire-choice[data-i="0"]');
  await page.click('.fire-cta[data-id="ok"]');
  await sleep(300);
  check("the call made, the drill moves on to the extinguisher", (await fire(page)).step === "grab" && (await fire(page)).panel === null, (await fire(page)).step);

  // the extinguisher card: closing it early teaches nothing
  await stand(page, -14.5, FLOOR, CORRIDOR, NORTH, -0.3);
  check("the extinguisher is under the crosshair", (await fire(page)).aimed === "extinguisher", String((await fire(page)).aimed));
  await page.evaluate(() => globalThis.__roboCraft.fireInteract());
  await page.waitForSelector('.fire-panel[data-panel="pass"]');
  await page.click(".fire-x");
  await sleep(200);
  check("the card closed early: no extinguisher in hand", (await fire(page)).extinguisher === false && (await fire(page)).step === "grab");
  await page.evaluate(() => { globalThis.__roboCraft.firePlay(true); globalThis.__roboCraft.fireUse("extinguisher"); });
  await page.waitForSelector('.fire-panel[data-panel="pass"]');
  const lesson = '.fire-panel[data-panel="pass"]';
  const action = `${lesson} [data-id="action"]`;
  const atStep = (number) => page.waitForFunction((n) =>
    document.querySelector('.fire-panel[data-panel="pass"] [data-id="count"]')?.textContent === `${n} / 5`,
    { timeout: 8000 }, number);
  const dragAction = async () => {
    const box = await (await page.$(action)).boundingBox();
    const x = box.x + box.width * 0.28;
    const y = box.y + box.height * 0.5;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + Math.min(110, box.width * 0.44), y, { steps: 12 });
    await page.mouse.up();
  };
  await page.click(action);
  await atStep(2);
  await dragAction();
  await atStep(3);
  await dragAction();
  await atStep(4);
  {
    const box = await (await page.$(action)).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => parseFloat(document.querySelector('.fire-child-action i')?.style.width ?? '0') >= 100);
    await page.waitForSelector('.fire-powder-label:not([hidden])');
    check("squeezing stays in step four and identifies the powder", await page.$eval(`${lesson} [data-id="count"]`, (el) => el.textContent === "4 / 5"));
    await shot(page, "04-pass-card-squeezing");
    await page.mouse.up();
  }
  await page.waitForSelector(`${lesson} [data-id="continue-sweep"]`, { visible: true });
  await page.click(`${lesson} [data-id="continue-sweep"]`);
  await atStep(5);
  const sweep = await (await page.$(`${lesson} [data-id="sweep"]`)).boundingBox();
  const y = sweep.y + sweep.height / 2;
  const left = sweep.x + sweep.width * 0.16;
  const right = sweep.x + sweep.width * 0.84;
  await page.mouse.move(left, y);
  await page.mouse.down();
  await page.mouse.move(right, y, { steps: 18 });
  await shot(page, "04-pass-card-sweep");
  await page.mouse.move(left, y, { steps: 18 });
  await page.mouse.up();
  await page.waitForSelector(`${action}.complete`, { visible: true });
  await page.click(`${action}.complete`);
  await sleep(300);
  const armed = await fire(page);
  check("pin → aim → squeeze → sweep done by hand: extinguisher in hand, full", armed.extinguisher && armed.charge === 1 && armed.step === "spray", JSON.stringify([armed.extinguisher, armed.charge, armed.step]));

  // the small fire (the waste bin at the corridor's west end): over it first (little use), then its base
  await stand(page, -17.6, FLOOR, -4.3, WEST, 0.35);
  await page.evaluate(() => globalThis.__roboCraft.fireSpray(true));
  await sleep(1200);
  const high = await fire(page);
  check("spraying over the fire hardly touches it", high.fire > 0.8 && high.charge < 1, `fire ${high.fire.toFixed(2)}, charge ${high.charge.toFixed(2)}`);
  await page.evaluate(() => globalThis.__roboCraft.look(-Math.PI / 2, -0.2));
  await sleep(1300);
  await shot(page, "05-spraying");
  await page.waitForFunction(() => globalThis.__roboCraft.fire().fire === 0, { timeout: 15000 });
  await page.evaluate(() => globalThis.__roboCraft.fireSpray(false));
  const out = await fire(page);
  check("aimed at its base the small fire goes out; the extinguisher is set down", out.fire === 0 && out.extinguisher === false && out.step === "towel", out.step);

  // the burning room is not to be entered
  await stand(page, -19, FLOOR, -12, NORTH, 0, 900);
  const hot = await fire(page);
  check("the burning room costs breath at once", hot.air < 0.9, hot.air.toFixed(2));
  await page.evaluate(() => globalThis.__roboCraft.fireSet({ air: 1 }));
  // the smoke comes along the corridor (it hurries once the escape begins); upright in it
  await stand(page, -6, FLOOR, CORRIDOR, EAST, 0);
  const t0 = (await fire(page)).smokeTime;
  await sleep(12000);
  const smoky = await fire(page);
  check("the smoke reaches the way out, and upright in it costs breath", smoky.smokeTime > t0 + 0.5 && smoky.air < 1, `air ${smoky.air.toFixed(2)}, breathed ${smoky.smokeTime.toFixed(1)} s`);
  await shot(page, "06-smoke");
  await page.evaluate(() => globalThis.__roboCraft.fireSet({ air: 1 }));

  // the towel, then low under the smoke
  await stand(page, 5.5, FLOOR, -4.1, SOUTH, -0.2);
  check("the sink's towel is under the crosshair", (await fire(page)).aimed === "towel", String((await fire(page)).aimed));
  await page.evaluate(() => globalThis.__roboCraft.fireInteract());
  check("towel on: the drill says get out", (await fire(page)).towel === true && (await fire(page)).step === "escape", (await fire(page)).step);
  await stand(page, -6, FLOOR, CORRIDOR, EAST, 0);
  await page.keyboard.press("KeyZ"); // the real key: get low
  await sleep(1500);
  const lowAt = (await fire(page)).smokeTime;
  await sleep(1500);
  const low = await fire(page);
  check("low with the towel, the smoke costs nothing", Math.abs(low.smokeTime - lowAt) < 0.05, `${lowAt.toFixed(2)} → ${low.smokeTime.toFixed(2)}`);
  await shot(page, "07-low");
  await page.keyboard.press("KeyZ");
  await sleep(900);

  // down and out, and to the gathering place
  await stand(page, 0, GROUND, 6, SOUTH, 0, 900);
  check("out of the building: the drill sends us to the gathering place", (await fire(page)).step === "assemble", (await fire(page)).step);
  await stand(page, 0, GROUND + 0.1, 16.5, NORTH, 0.1, 900);
  await page.waitForSelector('.fire-panel[data-panel="result"]', { timeout: 8000 });
  const end = await fire(page);
  check("at the gathering place the drill is done", end.step === "done" && end.panel === "result", end.step);
  const stars = await page.$eval(".fire-stars", (el) => Number(el.dataset.stars));
  check("the result card shows stars and what was learnt", stars >= 1 && stars <= 3 && (await page.$$eval(".fire-learnt li", (els) => els.length)) === 6, `★${stars}`);
  check("a lost star is explained (how to keep it next time)", stars === 3 || (await page.$(".fire-tip")) !== null);
  await shot(page, "08-result");
  // alone, the quiz is offered here (in a class it is the teacher's to give)
  await page.click('.fire-panel [data-id="quiz"]');
  await page.waitForSelector(".fire-quiz .fz-ask", { timeout: 5000 });
  check("alone, the result card offers the quiz: it opens over the card, with a way out", (await page.$(".fire-quiz .fz-close")) !== null && (await page.$$(".fire-quiz .fz-pips li")).length === 5);
  await page.click(".fire-quiz .fz-close");
  await sleep(200);
  check("closed, the result card is there again", (await page.$(".fire-quiz")) === null && (await page.$('.fire-panel [data-id="again"]')) !== null);
  await page.click('.fire-panel [data-id="again"]');
  await sleep(700);
  const again = await fire(page);
  check("again: fire lit, from the top", again.step === "alarm" && again.fire === 1 && again.panel === null && again.time < 2, JSON.stringify([again.step, again.fire]));
  check("…standing in the classroom", inClassroom(await where(page)), JSON.stringify(await where(page)));
}

// ------------------------------------------------------------------ 2. a class
{
  const ROOM = `소방${Date.now() % 100000}반`, TEACHER = `쌤${Date.now() % 100000}`;
  const teacher = await open("teacher");
  await teacher.goto(`${BASE}/?play=1`, { waitUntil: "networkidle2", timeout: 30000 });
  await teacher.click('[data-pick="field"]');
  await teacher.waitForSelector('[data-go="teacher"]');
  await teacher.click('[data-go="teacher"]');
  const themes = await teacher.$$eval('.theme-pick input[name="theme"]', (els) => els.map((e) => `${e.value}${e.checked ? "*" : ""}`).join(","));
  check("the teacher's form offers the learning themes, craft by default", themes === "craft*,fire", themes);
  await teacher.click('.theme-pick label:has(input[value="fire"])'); // the card is the control (its radio is hidden)
  check("the fire drill is picked", await teacher.$eval('.theme-pick input[value="fire"]', (el) => el.checked));
  check("picking the fire drill offers the teams to start with", await teacher.$eval("#cl-teams", (el) => !el.hidden));
  await teacher.select("#cl-teams", "4");
  await teacher.type("#cl-host-room", ROOM);
  await teacher.type("#cl-host", TEACHER);
  await teacher.type("#cl-pass", "1234");
  await shot(teacher, "09-teacher-form");
  await teacher.click('[data-step="teacher"] button[type="submit"]');
  await booted(teacher);
  const t0 = await fire(teacher);
  check("the teacher's class opens in the briefing (nothing burning yet)", t0?.waiting === true && t0.step === "alarm", JSON.stringify([t0?.waiting, t0?.step]));
  check("the teacher's guide says how to run it (F2)", /F2/.test(t0.guide), t0.guide);

  const student = await open("student");
  await student.goto(`${BASE}/?play=1`, { waitUntil: "networkidle2", timeout: 30000 });
  await student.click('[data-pick="field"]');
  await student.waitForSelector('[data-go="student"]');
  await student.click('[data-go="student"]');
  await student.type("#cl-room", ROOM);
  await student.type("#cl-student", "민지");
  await student.click('[data-step="student"] button[type="submit"]');
  await student.waitForFunction(() => !document.querySelector('[data-step="confirm"]').hidden, { timeout: 15000 });
  const card = await student.$eval('[data-id="confirm-card"]', (el) => el.textContent.replace(/\s+/g, " ").trim());
  check("the student's confirm card names today's lesson", /화재 체험|Fire drill/.test(card), card);
  await shot(student, "10-student-confirm");
  await student.click('[data-id="confirm-yes"]');
  await booted(student);
  const s0 = await fire(student);
  check("the student joins in the briefing", s0?.waiting === true, JSON.stringify(s0?.waiting));
  check("…told to listen to the teacher", /선생님|teacher/.test(s0.guide), s0.guide);
  for (const [who, page] of [["teacher", teacher], ["student", student]]) check(`${who}: arrives in the classroom`, inClassroom(await where(page)), JSON.stringify(await where(page)));
  await sleep(1200);
  const mates = await student.evaluate(() => globalThis.__roboCraft.classroom().members.filter((m) => m.online).length);
  check("the class roster holds both", mates === 2, String(mates));

  // the briefing: a student stays in the classroom, and things only say what they are
  await student.bringToFront();
  await sleep(4000); // (a page that has just booted may still be compiling: its first frames come late on a software GPU)
  await stand(student, -9, FLOOR, CORRIDOR, NORTH, 0, 1500);
  check("waiting, a student is kept in the classroom (put in the corridor, they are back inside)", inClassroom(await where(student)), JSON.stringify(await where(student)));
  await student.evaluate(() => globalThis.__roboCraft.fireUse("alarm"));
  check("waiting, the alarm cannot be set off", (await fire(student)).alarm === false && (await fire(student)).step === "alarm");
  check("waiting, nothing burns and there is no smoke", (await fire(student)).fx.lit < 0.05 && (await fire(student)).fx.smokeLevel < 0.05, JSON.stringify([(await fire(student)).fx.lit, (await fire(student)).fx.smokeLevel]));
  await shot(student, "11-briefing");

  // the teacher's controls are in F2 (class tools): teams of four, then team 1 off
  await teacher.evaluate(() => globalThis.__roboCraft.firePlay(true));
  await teacher.keyboard.press("F2");
  await teacher.waitForFunction(() => document.querySelector(".ct") && !document.querySelector(".ct").hidden, { timeout: 8000 });
  check("F2 opens the class tools with the fire drill's controls first", await teacher.evaluate(() => /화재 훈련|Fire drill/.test(document.querySelector(".ct .ct-theme h3")?.textContent ?? "")));
  await teacher.waitForSelector('.ct-theme [data-op="teams"][data-size="4"]');
  check("the teams asked for when making the class are already made", await teacher.$eval('.ct-theme [data-op="teams"][data-size="4"]', (el) => el.classList.contains("on")));
  await teacher.click('.ct-theme [data-op="teams"][data-size="4"]');
  await teacher.waitForSelector('.ct-theme [data-op="start"][data-team="1"]', { timeout: 8000 });
  const team = await teacher.$eval(".ct-theme .fb-team", (el) => el.textContent.replace(/\s+/g, " ").trim());
  check("teams formed: the student is in team 1, waiting", /1조|Team 1/.test(team) && /민지/.test(team) && /대기|Waiting/.test(team), team);
  await sleep(500);
  check("…and their guide names their team", (await fire(student)).team === 1 && /1조|Team 1/.test(await student.$eval(".fire-guide-step", (el) => el.textContent)));
  await shot(teacher, "12-board-teams");
  await sleep(500); // (the teams just formed redraw the board's buttons)
  await teacher.click('.ct-theme [data-op="start"][data-team="1"]');
  await student.waitForFunction(() => globalThis.__roboCraft.fire().waiting === false, { timeout: 8000 });
  const off = await fire(student);
  check("team 1 set off: the student's drill begins at its first step", off.step === "alarm" && off.fire === 1 && /화재경보기|alarm/.test(off.guide), off.guide);
  await teacher.waitForFunction(() => globalThis.__roboCraft.fire().waiting === false, { timeout: 8000 });
  check("the teacher's own drill runs too (a demonstration is possible)", (await fire(teacher)).waiting === false);

  // out of the classroom now, and progress reaches the teacher's board
  await stand(student, -9, FLOOR, CORRIDOR, NORTH, 0, 1500);
  const outPos = await where(student);
  check("set off, the student may stand in the corridor", !inClassroom(outPos) && outPos[1] > CLASSROOM.z1, JSON.stringify(outPos));
  await student.evaluate(() => globalThis.__roboCraft.fireUse("alarm"));
  await teacher.waitForFunction(() => /119/.test(document.querySelector(".ct-theme .fb-team li span")?.textContent ?? ""), { timeout: 8000 });
  check("the board follows the student's progress", true, await teacher.$eval(".ct-theme .fb-team li", (el) => el.textContent.replace(/\s+/g, " ").trim()));
  check("each runs a drill of their own (the student's alarm is not the teacher's)", (await fire(teacher)).step === "alarm" && (await fire(student)).step === "call");
  await shot(teacher, "13-board-progress");

  // stop: everyone back to the classroom and the briefing
  await teacher.click('.ct-theme [data-op="stop"]');
  await student.waitForFunction(() => globalThis.__roboCraft.fire().waiting === true, { timeout: 8000 });
  await sleep(700);
  const reset = await fire(student);
  check("stopped: the student is back in the classroom, waiting, drill reset", inClassroom(await where(student)) && reset.step === "alarm" && reset.alarm === false, JSON.stringify([await where(student), reset.step]));
  check("the board shows everyone waiting again", /대기|Waiting/.test(await teacher.$eval(".ct-theme .fb-team li span", (el) => el.textContent)));
  // everyone at once, without teams
  await teacher.click('.ct-theme [data-op="teams"][data-size="0"]');
  await sleep(400);
  await teacher.click('.ct-theme [data-op="start"]:not([data-team])');
  await student.waitForFunction(() => globalThis.__roboCraft.fire().waiting === false, { timeout: 8000 });
  check("without teams, 모두 출발 sets everyone off", (await fire(student)).team === 0);
  // the quiz: started from F2, it is on the student's screen; their answers reach the teacher's board
  check("the board says in words how the teams are made and what the start buttons do", (await teacher.$eval('.ct-theme [data-id="teams-how"]', (el) => el.textContent)).length > 20);
  await sleep(500); // (the start just above redraws the board's buttons: let that land before pressing one)
  await teacher.click('.ct-theme [data-op="preview"]');
  await teacher.waitForSelector(".fire-quiz .fz-close", { timeout: 5000 });
  check("the teacher previews the quiz on their own screen; nothing reaches the student", (await student.$(".fire-quiz")) === null);
  await teacher.click(".fire-quiz .fz-close");
  await sleep(200);
  check("…and is back in the class tools", (await teacher.$(".fire-quiz")) === null && await teacher.evaluate(() => !document.querySelector(".ct").hidden));
  await teacher.click('.ct-theme [data-op="quiz"]');
  await student.waitForSelector('.fire-panel[data-panel="quiz"] .fz-ask', { timeout: 8000 });
  const kind = await student.$eval(".fz-body", (el) => el.className);
  check("the teacher starts the quiz: a picture puzzle opens on the student's screen", (await fire(student)).panel === "quiz" && /fz-k-(pick|order|spot|dial|sort)/.test(kind) && (await student.$$(".fz-pips li")).length === 5, kind);
  await sleep(700);
  const pictures = await student.$$eval(".fz-body img", (imgs) => imgs.map((i) => i.complete && i.naturalWidth > 0));
  check("…with its pictures loaded", pictures.length > 0 && pictures.every(Boolean), `${pictures.filter(Boolean).length}/${pictures.length}`);
  await shot(student, "15-quiz-question");
  await student.evaluate(() => globalThis.__roboCraft.fireQuiz(false)); // one wrong
  // a refresh mid-quiz: the quiz goes on at its second round, the first still counted
  // (the student came in through the lobby, so the page's own address is the menu: back in by the class link, same tab, same seat key)
  await student.goto(`${BASE}/?mode=field&room=${encodeURIComponent(ROOM)}&student=${encodeURIComponent("민지")}`, { waitUntil: "domcontentloaded" });
  await student.waitForSelector('.fire-panel[data-panel="quiz"] .fz-ask', { timeout: 120000 });
  check("a page refreshed mid-quiz goes on where it was", (await student.$$(".fz-pips li.wrong")).length === 1 && /2/.test(await student.$eval(".fz-ask small", (el) => el.textContent)));
  await sleep(500);
  check("…and the board still has the round already played", /📝 0\/1/.test(await teacher.$eval(".ct-theme .fb-teams", (el) => el.textContent)));
  for (let i = 0; i < 4; i++) await student.evaluate(() => globalThis.__roboCraft.fireQuiz(true));
  await student.waitForSelector(".fire-quiz .fz-score", { timeout: 8000 });
  const scored = await student.$eval(".fire-quiz .fz-score b", (el) => el.textContent);
  check("five rounds played: the student sees their medal, score and the reasons", scored === "4" && (await student.$$(".fz-review li")).length === 5, scored);
  await shot(student, "16-quiz-result");
  await teacher.waitForFunction(() => /4\/5/.test(document.querySelector(".ct-theme .fb-quiz")?.textContent ?? ""), { timeout: 8000 });
  check("the teacher's board shows the student's quiz score", true, await teacher.$eval(".ct-theme .fb-team li", (el) => el.textContent.replace(/\s+/g, " ").trim()));
  await shot(teacher, "17-board-quiz");
  await teacher.click('.ct-theme [data-op="quiz-stop"]');
  await sleep(600);
  check("ended, the score stays on the board", /4\/5/.test(await teacher.$eval(".ct-theme .fb-quiz", (el) => el.textContent)));
  await student.click('.fire-quiz [data-id="close"]');
  await sleep(300);
  check("the student closes the finished quiz and plays on", (await fire(student)).panel === null);
  await teacher.keyboard.press("F2");
  await sleep(400);
  check("F2 closes the class tools", await teacher.evaluate(() => document.querySelector(".ct").hidden));
  // a student's Tab board is the same list, to read: no controls on it
  await student.evaluate(() => { globalThis.__roboCraft.firePlay(true); globalThis.__roboCraft.fireBoard(); });
  await student.waitForSelector(".fire-board .fb-team", { timeout: 8000 });
  check("a student's board (Tab) shows the class and has no controls", (await student.$$(".fire-board [data-op]")).length === 0 && /민지/.test(await student.$eval(".fire-board .fb-team", (el) => el.textContent)));
  await student.click(".fire-board .fire-x");

  // the school is not to be changed: the server hands a forged edit straight back
  const cells = () => Promise.all([teacher, student].map((p) => p.evaluate(() => [globalThis.__roboCraft.blockAtAbs(-45, 3, 0), globalThis.__roboCraft.blockAtAbs(-45, 4, 0)].join())));
  const was = await cells();
  await student.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-edit", edits: [[-45, 3, 0, 0, 0], [-45, 4, 0, 3, 0]] }));
  await sleep(900);
  const after = await cells();
  check("a forged edit changes nothing for anyone", after.join("|") === was.join("|") && was[0] === was[1], `${was.join(" | ")} → ${after.join(" | ")}`);
  await shot(student, "14-class");
}

for (const b of browsers) await b.close();
if (errors.length) console.log("PAGE ERRORS:\n" + errors.join("\n"));
check("no page errors", errors.length === 0, errors[0] ?? "");
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
