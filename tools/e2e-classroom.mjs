// Classroom E2E: a teacher opens a class under a CLASS NAME (+ their own
// name); students type the class name + their own, confirm whose class it is,
// and join; the shared field, roster, chat and teacher controls
// stay in sync live. Needs `pnpm dev` (server + client). Each participant runs
// in its OWN browser: background tabs pause rAF, which is the game loop.
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const TEACHER = `쌤${Date.now() % 100000}`; // unique per run, ≤16 chars
const ROOM = `햇살${Date.now() % 100000}반`; // the class's name, ≤20 chars
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
    args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1100,700"],
  });
  browsers.push(browser);
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 700 });
  page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
  page.on("dialog", (d) => void d.accept()); // confirm() on kick/end
  return page;
}

/** The last confirm card a student saw ("whose class is this?"). */
let lastConfirm = "";

/**
 * Menu → 교육 모드 → form. Teacher: class name + teacher name + password.
 * Student: class name + own name → the confirm card → "yes". Returns the
 * error text shown, or "" once the game has booted.
 */
async function enterViaLobby(page, role, room, person, password = "1234") {
  await page.goto(`${BASE}/?play=1`, { waitUntil: "networkidle2", timeout: 30000 });
  await page.click('[data-pick="field"]');
  await page.waitForSelector(`[data-go="${role}"]`);
  await page.click(`[data-go="${role}"]`);
  const fill = async (sel, text) => {
    await page.$eval(sel, (el) => (el.value = ""));
    if (text) await page.type(sel, text);
  };
  if (role === "teacher") {
    await fill("#cl-host-room", room);
    await fill("#cl-host", person);
    await fill("#cl-pass", password);
  } else {
    await fill("#cl-room", room);
    await fill("#cl-student", person);
  }
  await page.click(`[data-step="${role}"] button[type="submit"]`);
  const settled = (steps) =>
    page.waitForFunction(
      (steps) => {
        if (globalThis.__roboCraft) return true;
        return steps.some((step) => {
          const box = document.querySelector(`[data-step="${step}"]`);
          if (!box || box.hidden) return false;
          const err = box.querySelector('[data-id="error"]')?.textContent ?? "";
          return step === "confirm" ? err === "" || !err.includes("연결하는 중") : !!err && !/연결하는 중|찾는 중/.test(err);
        });
      },
      { timeout: 15000 },
      steps,
    );
  if (role === "student") {
    // step 1 settles on an error, or moves on to the confirm card
    await settled(["student", "confirm"]);
    const onConfirm = await page.evaluate(() => !document.querySelector('[data-step="confirm"]').hidden);
    if (!onConfirm) return page.$eval('[data-step="student"] [data-id="error"]', (el) => el.textContent);
    lastConfirm = await page.$eval('[data-id="confirm-card"]', (el) => el.textContent.replace(/\s+/g, " ").trim());
    await page.click('[data-id="confirm-yes"]');
    await page.waitForFunction(
      () => !!globalThis.__roboCraft || /[^\s]/.test(document.querySelector('[data-step="confirm"] [data-id="error"]')?.textContent.replace("연결하는 중…", "") ?? ""),
      { timeout: 40000 }, // a third browser booting beside two live ones is slow under SwiftShader
    );
  } else {
    await settled(["teacher"]);
  }
  if (await page.evaluate(() => !!globalThis.__roboCraft)) {
    await sleep(1500);
    return "";
  }
  const step = role === "teacher" ? "teacher" : "confirm";
  return page.$eval(`[data-step="${step}"] [data-id="error"]`, (el) => el.textContent);
}

const cls = (page) => page.evaluate(() => globalThis.__roboCraft.classroom());
const send = (page, msg) => page.evaluate((m) => globalThis.__roboCraft.classSend(m), msg);

try {
  const teacher = await open("teacher");
  const minji = await open("minji");
  const jun = await open("jun");

  // 1) entry and the error paths
  const noPass = await enterViaLobby(teacher, "teacher", ROOM, TEACHER, "");
  check("a new class needs a password", noPass.includes("비밀번호"), noPass);
  check("teacher opens a class by class name + teacher name + password", (await enterViaLobby(teacher, "teacher", ROOM, TEACHER)) === "");
  const title = await teacher.$eval(".class-title", (el) => el.textContent);
  check("the class overlay names the class and the teacher", title.includes(ROOM) && title.includes(TEACHER), title);
  check("student joins with class name + own name", (await enterViaLobby(minji, "student", ROOM, "민지")) === "");
  check("the student was shown whose class it is before joining", lastConfirm.includes(ROOM) && lastConfirm.includes(TEACHER), lastConfirm);
  const wrong = await enterViaLobby(jun, "student", `${ROOM}x`, "준");
  check("an unknown class name is refused before anything else", wrong.includes("찾을 수 없어요"), wrong);
  const dup = await enterViaLobby(jun, "student", ROOM, " 민지 ");
  check("duplicate student name is refused", dup.includes("같은 이름의 학생"), dup);
  const fake = await open("fake");
  const rival = await enterViaLobby(fake, "teacher", ROOM, `${TEACHER}2`, "1234");
  check("another teacher can't take a class name in use (and is told whose it is)", rival.includes("다른 선생님") || rival.includes("선생님 이름으로 이미 저장"), rival);
  const twice = await enterViaLobby(fake, "teacher", ROOM.toUpperCase(), TEACHER, "1234");
  check("the same teacher can't open their class twice at once", twice.includes("이미 다른 곳에서"), twice);

  // 2) live roster + robots
  await sleep(1200);
  const t0 = await cls(teacher);
  check("teacher sees the student online", t0.members.some((m) => m.name === "민지" && m.online), JSON.stringify(t0.members));
  const m0 = await cls(minji);
  check("student sees the teacher's robot", m0.remotes.some((r) => r.name === TEACHER && r.visible), JSON.stringify(m0.remotes));

  // 3) shared building, both directions
  await minji.evaluate(() => globalThis.__roboCraft.placeAt(70, 4, 70, "gold-block"));
  // its ABSOLUTE cell: the voxel window moves later (a gather, and a returning student comes back
  // where they stood), so grid (70, 70) will not name this brick then
  const brickAbs = await minji.evaluate(() => { const [ax, az] = globalThis.__roboCraft.absolute(); const p = globalThis.__roboCraft.snapshot().pos; return [70 + (ax - p[0]), 70 + (az - p[2])]; });
  await teacher.evaluate(() => globalThis.__roboCraft.placeAt(72, 4, 70, "glass"));
  await sleep(800);
  const seenByTeacher = await teacher.evaluate(() => globalThis.__roboCraft.blockAt(70, 4, 70));
  const seenByStudent = await minji.evaluate(() => globalThis.__roboCraft.blockAt(72, 4, 70));
  check("student's brick appears for the teacher", seenByTeacher !== 0);
  check("teacher's brick appears for the student", seenByStudent !== 0);

  // Furniture uses the same shared classroom, including undo and door state.
  const furniture = (page) => page.evaluate(() => globalThis.__roboCraft.furniture().items);
  const shortcut = (page, key) => page.evaluate((key) => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }));
  }, key);
  check("teacher sees the furniture button", await teacher.$eval('[data-id="furniture-chip"]', (el) => getComputedStyle(el).display !== "none"));
  check("teacher places shared furniture", await teacher.evaluate(() => globalThis.__roboCraft.furniturePlace("chair", 76, 4, 86, 1, 1)));
  await sleep(500);
  check("student receives the chair and its colour", (await furniture(minji)).some((p) => p[0] === "chair" && p[4] === 1 && p[5] === 1));
  const furnitureCount = (page, n) => page.waitForFunction((n) => globalThis.__roboCraft.furniture().items.length === n, { timeout: 4000 }, n).catch(() => {});
  await shortcut(teacher, "z");
  await furnitureCount(minji, 0);
  check("teacher undo removes the chair for students", (await furniture(minji)).length === 0);
  await shortcut(teacher, "y");
  await furnitureCount(minji, 1);
  check("teacher redo restores the chair for students", (await furniture(minji)).length === 1, JSON.stringify(await furniture(teacher)));
  await minji.evaluate(() => globalThis.__roboCraft.furniturePlace("side-table", 82, 4, 86));
  await sleep(300);
  await minji.evaluate(() => globalThis.__roboCraft.furniturePlace("vase", 82, 4, 86));
  await furnitureCount(teacher, 3);
  check("student table and vase reach the teacher", (await furniture(teacher)).length === 3, JSON.stringify(await furniture(minji)));
  await teacher.evaluate(() => globalThis.__roboCraft.furniturePlace("door", 85, 4, 86));
  await sleep(300);
  await teacher.evaluate(() => globalThis.__roboCraft.furnitureToggle(85, 4, 86));
  await sleep(500);
  check("door opening is shared", (await furniture(minji)).some((p) => p[0] === "door" && p[6] === 1));
  const sharedFurniture = await furniture(teacher);

  // 4) a late joiner gets the whole field
  check("second student joins", (await enterViaLobby(jun, "student", ROOM, "준")) === "");
  const lateView = await jun.evaluate(() => [globalThis.__roboCraft.blockAt(70, 4, 70), globalThis.__roboCraft.blockAt(72, 4, 70)]);
  check("late joiner sees bricks built before they came", lateView.every((b) => b !== 0), JSON.stringify(lateView));
  check("late joiner gets furniture and open doors", JSON.stringify(await furniture(jun)) === JSON.stringify(sharedFurniture));

  // 5) build lock: a student's brick is refused and rolled back
  await send(teacher, { t: "k-settings", chatLocked: false, buildLocked: true });
  await sleep(500);
  check("locked student cannot place furniture", !(await minji.evaluate(() => globalThis.__roboCraft.furniturePlace("chair", 74, 4, 86))));
  await minji.evaluate(() => globalThis.__roboCraft.furnitureToggle(85, 4, 86));
  await shortcut(minji, "z");
  await sleep(300);
  check("build lock prevents door changes and furniture undo", JSON.stringify(await furniture(teacher)) === JSON.stringify(sharedFurniture));
  await minji.evaluate(() => globalThis.__roboCraft.placeAt(74, 4, 70, "stone"));
  await minji.waitForFunction(() => globalThis.__roboCraft.blockAt(74, 4, 70) === 0, { timeout: 4000 }).catch(() => {});
  const locked = await minji.evaluate(() => globalThis.__roboCraft.blockAt(74, 4, 70));
  const leaked = await teacher.evaluate(() => globalThis.__roboCraft.blockAt(74, 4, 70));
  check("build lock rolls back a student's brick", locked === 0 && leaked === 0, `${locked}/${leaked}`);
  await send(teacher, { t: "k-settings", chatLocked: false, buildLocked: false });

  // 6) chat
  await send(teacher, { t: "k-chat", text: "모두 안녕!" });
  // a third headless browser on SwiftShader can be a second behind: wait for the line, don't race it
  await jun.waitForFunction(() => [...document.querySelectorAll(".class-chat-log .line")].some((e) => e.textContent.includes("모두 안녕!")), { timeout: 8000 }).catch(() => {});
  const heard = await jun.$$eval(".class-chat-log .line", (els) => els.map((e) => e.textContent).join("|"));
  check("teacher's chat reaches students", heard.includes("모두 안녕!"), heard);

  // 7) gather: teacher walks far away, calls everyone
  await teacher.evaluate(async () => {
    const c = globalThis.__roboCraft;
    for (let i = 0; i < 40; i++) {
      const p = c.snapshot().pos;
      c.teleport(p[0] + 5, 4, p[2]);
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await sleep(600);
  await send(teacher, { t: "k-gather" });
  await sleep(1000);
  const tAbs = await teacher.evaluate(() => globalThis.__roboCraft.absolute());
  const mAbs = await minji.evaluate(() => globalThis.__roboCraft.absolute());
  const dist = Math.hypot(tAbs[0] - mAbs[0], tAbs[1] - mAbs[1]);
  check("gather brings students to the teacher (200 m away)", dist < 6, `teacher ${tAbs} student ${mAbs}`);

  // 7b) F2 class tools → 1 자리 배치: every student gets a 15 × 20 plot of their own in front of the
  // teacher (name order: 민지 before 준, side by side), standing in it facing the teacher
  await teacher.bringToFront();
  await teacher.evaluate(() => globalThis.__roboCraft.look(0, 0)); // facing +z
  await sleep(700); // the heading reaches the server with the next k-move
  if (process.env.SHOTS) {
    // BEFORE for the notes: the same camera as the seated shot, before 자리 배치
    await teacher.addStyleTag({ content: ".craft-hint{display:none!important}" });
    await teacher.evaluate(() => globalThis.__roboCraft.look(0, -0.42));
    await sleep(800);
    await teacher.screenshot({ path: `${process.env.SHOTS}/class-before.png` });
    await teacher.evaluate(() => globalThis.__roboCraft.look(0, 0));
    await sleep(700);
  }
  await teacher.keyboard.press("F2");
  await sleep(200);
  check("F2 opens the teacher's class tools", await teacher.evaluate(() => !document.querySelector(".class-tools")?.hidden));
  check("students have no class tools", !(await minji.$(".class-tools")));
  if (process.env.SHOTS) await teacher.screenshot({ path: `${process.env.SHOTS}/class-f2-tools.png` });
  await teacher.keyboard.press("1");
  await sleep(1200);
  check("picking a tool closes the panel", await teacher.evaluate(() => document.querySelector(".class-tools")?.hidden === true));
  const tSeat = await teacher.evaluate(() => globalThis.__roboCraft.absolute());
  const placed = [];
  for (const page of [minji, jun]) {
    const [x, z] = await page.evaluate(() => globalThis.__roboCraft.absolute());
    const yaw = await page.evaluate(() => globalThis.__roboCraft.snapshot().yaw);
    placed.push({ across: x - (Math.floor(tSeat[0]) + 0.5), ahead: z - (Math.floor(tSeat[1]) + 0.5), yaw });
  }
  check("each student stands just inside the front of their own plot in front of the teacher",
    placed.every((s) => Math.abs(s.ahead - 6) < 0.6), JSON.stringify(placed));
  check("…the two plots side by side, 15 cells apart (one plot each)", Math.abs(Math.abs(placed[0].across - placed[1].across) - 15) < 0.6, JSON.stringify(placed));
  // facing +z the teacher's left is +x: name order reads left → right from the teacher's view
  check("…in name order (left → right as the teacher sees it), side by side on the front row", placed[0].across > placed[1].across && Math.abs(placed[0].ahead - placed[1].ahead) < 0.6, JSON.stringify(placed));
  if (process.env.SHOTS) {
    await teacher.addStyleTag({ content: ".craft-hint{display:none!important}" });
    await teacher.evaluate(() => globalThis.__roboCraft.look(0, -0.42));
    await sleep(800);
    await teacher.screenshot({ path: `${process.env.SHOTS}/class-seated.png` });
  }
  const drawn = await Promise.all([teacher, minji, jun].map((p) => p.evaluate(() => globalThis.__roboCraft.classroom().seating)));
  if (process.env.SHOTS) {
    // from above: lift the teacher and look down over the plots (a quick shot before the fall)
    await teacher.evaluate(() => {
      const c = globalThis.__roboCraft;
      const p = c.snapshot().pos;
      c.teleport(p[0], p[1] + 16, p[2] - 4);
      c.look(0, -0.95);
    });
    await sleep(120);
    await teacher.screenshot({ path: `${process.env.SHOTS}/class-plots-air.png` });
    await minji.bringToFront();
    await minji.addStyleTag({ content: ".craft-hint{display:none!important}" });
    await minji.evaluate(() => globalThis.__roboCraft.look(Math.PI, -0.1)); // turn round into the plot
    await sleep(600);
    await minji.screenshot({ path: `${process.env.SHOTS}/class-plot-student.png` });
    await teacher.bringToFront();
  }
  check("everyone sees the plots: fences and a name sign per student", drawn.every((n) => n === 2), JSON.stringify(drawn));
  check("…facing the teacher", placed.every((s) => Math.cos(s.yaw) < -0.9), JSON.stringify(placed.map((s) => s.yaw)));

  // kept in: a student cannot walk out of their plot (the fence holds them)
  await minji.bringToFront();
  // ABSOLUTE positions: a teleport scrolls the field window, so grid coordinates jump by 16s
  const minjiStart = await minji.evaluate(() => globalThis.__roboCraft.absolute());
  check("a seated student is kept on their plot", (await cls(minji)).kept === true);
  await minji.evaluate(() => { const c = globalThis.__roboCraft; const p = c.snapshot().pos; c.teleport(p[0] + 30, p[1] + 0.2, p[2]); });
  await sleep(700);
  const held = await minji.evaluate(() => globalThis.__roboCraft.absolute());
  check("…a step past the fence is held at the fence", Math.abs(held[0] - minjiStart[0]) <= 7.6, `${minjiStart[0]} → ${held[0]}`);

  // a student who arrives AFTER the seating gets a plot of their own beside the others and is put on it
  const late = await open("late");
  late.on("console", (m) => { if (m.type() === "error") console.log("late console:", m.text()); });
  check("a late student joins", (await enterViaLobby(late, "student", ROOM, "서준")) === "");
  await late.evaluate(() => globalThis.__roboCraft.classroom());
  await sleep(1500);
  const teacherView = await cls(teacher);
  check("…everyone now sees three plots", teacherView.seating === 3 && (await cls(minji)).seating === 3, JSON.stringify(teacherView.plots));
  const latePlot = teacherView.plots.find((p) => p.name === "서준");
  const lateAbs = await late.evaluate(() => { const c = globalThis.__roboCraft; return [...c.absolute(), c.classroom().kept]; });
  check("…the late student stands on their own plot and is kept there",
    !!latePlot && Math.hypot(lateAbs[0] - latePlot.pos[0], lateAbs[1] - latePlot.pos[2]) < 2.5 && lateAbs[2] === true, JSON.stringify({ latePlot, lateAbs }));
  const firstTwo = placed.map((p) => p.across);
  const plotsAfter = teacherView.plots.filter((p) => p.name !== "서준").length;
  check("…nobody else's plot moved", plotsAfter === 2 && firstTwo.length === 2);

  // the late student leaves (closes the page) and comes back: the SAME plot, put straight onto it
  await late.goto(`${BASE}/?mode=field&room=${encodeURIComponent(ROOM)}&student=${encodeURIComponent("서준")}`, { waitUntil: "networkidle2", timeout: 30000 });
  await late.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 40000 });
  await sleep(2500);
  const rejoin = await late.evaluate(() => { const c = globalThis.__roboCraft; return [...c.absolute(), c.classroom().kept, c.classroom().seating]; });
  const plotsNow = (await cls(teacher)).plots;
  check("…leaving and coming back: the same plot, stood on, still kept in, no second plot",
    Math.hypot(rejoin[0] - latePlot.pos[0], rejoin[1] - latePlot.pos[2]) < 2.5 && rejoin[2] === true && plotsNow.length === 3,
    JSON.stringify({ rejoin, latePlot, plots: plotsNow.length }));

  // F2 → 4 자유롭게 돌아다니기: the fence lets go; F2 → 4 again: everyone back on their plot
  await teacher.bringToFront();
  await teacher.keyboard.press("F2");
  await sleep(200);
  await teacher.keyboard.press("4");
  await sleep(900);
  check("free to roam: students are no longer kept in", (await cls(minji)).kept === false && (await cls(minji)).roam === true);
  await minji.bringToFront();
  await minji.evaluate(() => { const c = globalThis.__roboCraft; const p = c.snapshot().pos; c.teleport(p[0] + 30, p[1] + 0.2, p[2]); });
  await sleep(700);
  const roamed = await minji.evaluate(() => globalThis.__roboCraft.absolute());
  check("…and can walk out of the plot", Math.abs(roamed[0] - held[0]) > 20, `${held[0]} → ${roamed[0]}`);
  await teacher.bringToFront();
  await teacher.keyboard.press("F2");
  await sleep(200);
  await teacher.keyboard.press("4");
  await sleep(1200);
  await minji.bringToFront();
  await sleep(300);
  const back = await minji.evaluate(() => globalThis.__roboCraft.absolute());
  const mine = (await cls(minji)).plots.find((p) => p.name === "민지");
  check("back to your plots: the roaming student is sent back and kept in again",
    (await cls(minji)).kept === true && Math.hypot(back[0] - mine.pos[0], back[1] - mine.pos[2]) < 2.5, JSON.stringify({ back, mine }));
  await late.close().catch(() => {});

  // F2 → 3 자리 치우기: the booths go for everyone
  await teacher.bringToFront();
  await teacher.keyboard.press("F2");
  await sleep(200);
  check("the tools offer to put the seating away while it stands", await teacher.evaluate(() => !document.querySelector('.class-tools [data-opt="3"]')?.hidden));
  await teacher.keyboard.press("3");
  await sleep(900);
  const gone = await Promise.all([teacher, minji].map((p) => p.evaluate(() => globalThis.__roboCraft.classroom().seating)));
  check("…and it is gone for everyone", gone.every((n) => n === 0), JSON.stringify(gone));

  // 8) kick
  const junMember = (await cls(teacher)).members.find((m) => m.name === "준");
  check("roster lists the second student", !!junMember?.online);
  const junPlayerId = await jun.evaluate(() => globalThis.__roboCraft.classroom().you);
  await send(teacher, { t: "k-kick", playerId: junPlayerId });
  await sleep(800);
  check("kicked student sees the end screen", !!(await jun.$(".class-ended")));
  const afterKick = await cls(teacher);
  check("kicked student leaves the roster", !afterKick.members.some((m) => m.name === "준"));

  // 9) a dropped student gets their seat (and the field) back
  const before = (await cls(minji)).you;
  await minji.goto(`${BASE}/?mode=field&room=${encodeURIComponent(ROOM)}&student=${encodeURIComponent("민지")}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await minji.waitForFunction(() => !!globalThis.__roboCraft?.classroom(), { timeout: 15000 });
  await sleep(800);
  const after = await cls(minji);
  const kept = await minji.evaluate(([ax, az]) => globalThis.__roboCraft.blockAtAbs(ax, 4, az), brickAbs);
  check("reconnecting student keeps their seat", after.you === before, `${before} → ${after.you}`);
  check("reconnecting student gets the field back", kept !== 0 && kept !== -1, JSON.stringify({ kept, brickAbs }));
  check("reconnecting student gets furniture back", JSON.stringify(await furniture(minji)) === JSON.stringify(sharedFurniture));

  // 10) end of class
  await send(teacher, { t: "k-end" });
  await sleep(800);
  check("ending the class shows students the end screen", !!(await minji.$(".class-ended")));

  // 11) the class is saved: re-open it next lesson from ANOTHER PC (no key)
  await sleep(500);
  const closed = await enterViaLobby(jun, "student", ROOM, "하나");
  check("a saved class waits for its teacher: students are told it isn't open yet", closed.includes("아직 열리지 않았어요") && closed.includes(TEACHER), closed);
  const wrongPass = await enterViaLobby(fake, "teacher", ROOM, TEACHER, "9999");
  check("re-opening a saved class from another PC needs the right password", wrongPass.includes("비밀번호"), wrongPass);
  check("the right password re-opens it", (await enterViaLobby(fake, "teacher", ROOM, TEACHER, "1234")) === "");
  const restored = await fake.evaluate(() => [globalThis.__roboCraft.blockAt(70, 4, 70), globalThis.__roboCraft.blockAt(72, 4, 70)]);
  check("last lesson's bricks are still there", restored.every((b) => b !== 0), JSON.stringify(restored));
  check("last lesson's furniture is still there", JSON.stringify(await furniture(fake)) === JSON.stringify(sharedFurniture));
  const seats = await fake.evaluate(() => globalThis.__roboCraft.classroom().members.map((m) => m.name));
  check("the class roster is kept (minus the kicked student)", seats.includes("민지") && !seats.includes("준"), seats.join(","));
  await fake.evaluate(() => {
    const c = globalThis.__roboCraft;
    for (let x = 79; x <= 81; x++) for (let z = 79; z <= 81; z++) for (let y = 1; y <= 3; y++) c.mineAt(x, y, z);
    c.teleport(80.5, 1, 80.5);
  });
  await sleep(500);
  await send(fake, { t: "k-reset-world" });
  await sleep(500);
  check("teacher can wipe the field", (await fake.evaluate(() => globalThis.__roboCraft.blockAt(70, 4, 70))) === 0);
  check("reset also clears shared furniture", (await furniture(fake)).length === 0);
  check("reset lifts an underground player clear of the restored terrain", (await fake.evaluate(() => globalThis.__roboCraft.snapshot().pos[1])) >= 4);
  await send(fake, { t: "k-end" });

  check("no browser errors", errors.length === 0, errors.join(" | "));
} finally {
  for (const b of browsers) await b.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
