// Classroom E2E: a teacher opens a class by name, students join with that
// name + their own, and the shared field, roster, chat and teacher controls
// stay in sync live. Needs `pnpm dev` (server + client). Each participant runs
// in its OWN browser: background tabs pause rAF, which is the game loop.
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const TEACHER = `쌤${Date.now() % 100000}`; // unique per run, ≤16 chars
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

/** Menu → 교육 모드 → teacher/student form. Returns the error text (or ""). */
async function enterViaLobby(page, role, teacher, student, password = "1234") {
  await page.goto(`${BASE}/?play=1`, { waitUntil: "networkidle2", timeout: 30000 });
  await page.click('[data-pick="field"]');
  await page.waitForSelector(`[data-go="${role}"]`);
  await page.click(`[data-go="${role}"]`);
  if (role === "teacher") {
    await page.$eval("#cl-host", (el) => (el.value = ""));
    await page.type("#cl-host", teacher);
    await page.$eval("#cl-pass", (el) => (el.value = ""));
    if (password) await page.type("#cl-pass", password);
  } else {
    await page.$eval("#cl-teacher", (el) => (el.value = ""));
    await page.$eval("#cl-student", (el) => (el.value = ""));
    await page.type("#cl-teacher", teacher);
    await page.type("#cl-student", student);
  }
  await page.click(`[data-step="${role}"] button[type="submit"]`);
  // either the game boots or the form shows an error
  await page.waitForFunction(
    (role) => {
      const err = document.querySelector(`[data-step="${role}"] [data-id="error"]`)?.textContent ?? "";
      return !!globalThis.__roboCraft || (err && !err.includes("연결하는 중"));
    },
    { timeout: 15000 },
    role,
  );
  if (await page.evaluate(() => !!globalThis.__roboCraft)) {
    await sleep(1500);
    return "";
  }
  return page.$eval(`[data-step="${role}"] [data-id="error"]`, (el) => el.textContent);
}

const cls = (page) => page.evaluate(() => globalThis.__roboCraft.classroom());
const send = (page, msg) => page.evaluate((m) => globalThis.__roboCraft.classSend(m), msg);

try {
  const teacher = await open("teacher");
  const minji = await open("minji");
  const jun = await open("jun");

  // 1) entry and the error paths
  const noPass = await enterViaLobby(teacher, "teacher", TEACHER, undefined, "");
  check("a new class needs a password", noPass.includes("비밀번호"), noPass);
  check("teacher opens a class by name + password", (await enterViaLobby(teacher, "teacher", TEACHER)) === "");
  check("student joins with teacher name + own name", (await enterViaLobby(minji, "student", TEACHER, "민지")) === "");
  const wrong = await enterViaLobby(jun, "student", `${TEACHER}x`, "준");
  check("unknown teacher name is refused", wrong.includes("열린 반이 없어요"), wrong);
  const dup = await enterViaLobby(jun, "student", TEACHER, " 민지 ");
  check("duplicate student name is refused", dup.includes("같은 이름의 학생"), dup);
  const fake = await open("fake");
  const taken = await enterViaLobby(fake, "teacher", TEACHER.toUpperCase(), undefined, "1234");
  check("a second teacher can't take the same name", taken.includes("이미 같은 이름"), taken);

  // 2) live roster + robots
  await sleep(1200);
  const t0 = await cls(teacher);
  check("teacher sees the student online", t0.members.some((m) => m.name === "민지" && m.online), JSON.stringify(t0.members));
  const m0 = await cls(minji);
  check("student sees the teacher's robot", m0.remotes.some((r) => r.name === TEACHER && r.visible), JSON.stringify(m0.remotes));

  // 3) shared building, both directions
  await minji.evaluate(() => globalThis.__roboCraft.placeAt(70, 4, 70, "gold-block"));
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
  await shortcut(teacher, "z");
  await sleep(500);
  check("teacher undo removes the chair for students", (await furniture(minji)).length === 0);
  await shortcut(teacher, "y");
  await sleep(500);
  check("teacher redo restores the chair for students", (await furniture(minji)).length === 1);
  await minji.evaluate(() => globalThis.__roboCraft.furniturePlace("side-table", 82, 4, 86));
  await sleep(300);
  await minji.evaluate(() => globalThis.__roboCraft.furniturePlace("vase", 82, 4, 86));
  await sleep(500);
  check("student table and vase reach the teacher", (await furniture(teacher)).length === 3);
  await teacher.evaluate(() => globalThis.__roboCraft.furniturePlace("door", 85, 4, 86));
  await sleep(300);
  await teacher.evaluate(() => globalThis.__roboCraft.furnitureToggle(85, 4, 86));
  await sleep(500);
  check("door opening is shared", (await furniture(minji)).some((p) => p[0] === "door" && p[6] === 1));
  const sharedFurniture = await furniture(teacher);

  // 4) a late joiner gets the whole field
  check("second student joins", (await enterViaLobby(jun, "student", TEACHER, "준")) === "");
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
  await sleep(800);
  const locked = await minji.evaluate(() => globalThis.__roboCraft.blockAt(74, 4, 70));
  const leaked = await teacher.evaluate(() => globalThis.__roboCraft.blockAt(74, 4, 70));
  check("build lock rolls back a student's brick", locked === 0 && leaked === 0, `${locked}/${leaked}`);
  await send(teacher, { t: "k-settings", chatLocked: false, buildLocked: false });

  // 6) chat
  await send(teacher, { t: "k-chat", text: "모두 안녕!" });
  await sleep(500);
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
  await minji.goto(`${BASE}/?mode=field&teacher=${encodeURIComponent(TEACHER)}&student=${encodeURIComponent("민지")}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await minji.waitForFunction(() => !!globalThis.__roboCraft?.classroom(), { timeout: 15000 });
  await sleep(800);
  const after = await cls(minji);
  const kept = await minji.evaluate(() => globalThis.__roboCraft.blockAt(70, 4, 70));
  check("reconnecting student keeps their seat", after.you === before, `${before} → ${after.you}`);
  check("reconnecting student gets the field back", kept !== 0);
  check("reconnecting student gets furniture back", JSON.stringify(await furniture(minji)) === JSON.stringify(sharedFurniture));

  // 10) end of class
  await send(teacher, { t: "k-end" });
  await sleep(800);
  check("ending the class shows students the end screen", !!(await minji.$(".class-ended")));

  // 11) the class is saved: re-open it next lesson from ANOTHER PC (no key)
  await sleep(500);
  const wrongPass = await enterViaLobby(fake, "teacher", TEACHER, undefined, "9999");
  check("re-opening a saved class from another PC needs the right password", wrongPass.includes("비밀번호"), wrongPass);
  check("the right password re-opens it", (await enterViaLobby(fake, "teacher", TEACHER, undefined, "1234")) === "");
  const restored = await fake.evaluate(() => [globalThis.__roboCraft.blockAt(70, 4, 70), globalThis.__roboCraft.blockAt(72, 4, 70)]);
  check("last lesson's bricks are still there", restored.every((b) => b !== 0), JSON.stringify(restored));
  check("last lesson's furniture is still there", JSON.stringify(await furniture(fake)) === JSON.stringify(sharedFurniture));
  const seats = await fake.evaluate(() => globalThis.__roboCraft.classroom().members.map((m) => m.name));
  check("the class roster is kept (minus the kicked student)", seats.includes("민지") && !seats.includes("준"), seats.join(","));
  await send(fake, { t: "k-reset-world" });
  await sleep(500);
  check("teacher can wipe the field", (await fake.evaluate(() => globalThis.__roboCraft.blockAt(70, 4, 70))) === 0);
  check("reset also clears shared furniture", (await furniture(fake)).length === 0);
  await send(fake, { t: "k-end" });

  check("no browser errors", errors.length === 0, errors.join(" | "));
} finally {
  for (const b of browsers) await b.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
