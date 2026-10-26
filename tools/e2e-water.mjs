// Real bucket input, swimming and two-browser classroom water, against pnpm dev.
import puppeteer from "puppeteer-core";
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const browsers = [], errors = [], results = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
async function open(query) {
  const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1100,700"] });
  browsers.push(browser);
  const page = await browser.newPage(); await page.setViewport({ width: 1100, height: 700 });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${BASE}/?mode=field${query}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 60000 });
  await page.evaluate(() => {
    const game = globalThis.__roboCraft, p = game.snapshot().pos, a = game.absolute();
    const origin = [a[0] - p[0], a[1] - p[2]];
    const grid = (x, z) => { const p = game.snapshot().pos, a = game.absolute(); return [x + origin[0] - (a[0] - p[0]), z + origin[1] - (a[1] - p[2])]; };
    globalThis.__waterTest = { ...game,
      teleport: (x, y, z) => { const [gx, gz] = grid(x, z); game.teleport(gx, y, gz); },
      placeAt: (x, y, z, block) => { const [gx, gz] = grid(x, z); return game.placeAt(gx, y, gz, block); },
      mineAt: (x, y, z) => { const [gx, gz] = grid(x, z); return game.mineAt(gx, y, gz); },
      blockAt: (x, y, z) => { const [gx, gz] = grid(x, z); return game.blockAt(gx, y, gz); },
      designCell: ([x, y, z]) => { const p = game.snapshot().pos, a = game.absolute(); return [x + a[0] - p[0] - origin[0], y, z + a[1] - p[2] - origin[1]]; },
    };
  });
  await wait(500); return page;
}
const state = (page) => page.evaluate(() => globalThis.__roboCraft.water());
const until = (page, fn, arg, timeout = 12000) => page.waitForFunction(fn, { timeout, polling: 100 }, arg);
async function capture(page) {
  if (!(await page.evaluate(() => !!document.pointerLockElement))) {
    await page.mouse.click(550, 400);
    await until(page, () => !!document.pointerLockElement);
  }
}
async function click(page, button) {
  await page.mouse.down({ button }); await wait(100); await page.mouse.up({ button });
}
try {
  const page = await open("&reset=1");
  await capture(page); await page.keyboard.press("Digit0");
  check("0 selects the endless water bucket", (await state(page)).selected === "water");
  const programs = await page.evaluate(() => globalThis.__roboCraft.programs().length);
  await page.evaluate(() => { const c = globalThis.__waterTest; c.teleport(80.5, 4, 78.5); c.look(0, -0.65); });
  await wait(200);
  const source = await page.evaluate(() => {
    const c = globalThis.__waterTest, hit = c.aimInfo().voxel;
    if (!hit) throw new Error("bucket must aim at ground");
    return c.designCell([hit[0], hit[1] + 1, hit[2]]);
  });
  await click(page, "right");
  await until(page, () => globalThis.__roboCraft.water().sources === 1);
  check("right click pours a source", await page.evaluate(([x, y, z]) => globalThis.__waterTest.blockAt(x, y, z) === 19, source));
  await until(page, ([x, y, z]) => globalThis.__waterTest.blockAt(x + 7, y, z) === 26, source);
  check("flow reaches seven cells and stops before the eighth", await page.evaluate(([x, y, z]) => globalThis.__waterTest.blockAt(x + 8, y, z) === 0, source));
  check("first flow reuses the warmed water shader", (await page.evaluate(() => globalThis.__roboCraft.programs().length)) === programs);
  await page.evaluate(([x, , z]) => { const c = globalThis.__waterTest; c.teleport(x + 0.5, 6, z + 0.5); c.look(0, -1.55); }, source);
  await wait(160); await click(page, "left");
  await until(page, () => globalThis.__roboCraft.water().sources === 0);
  await until(page, () => globalThis.__roboCraft.water().cells === 0);
  check("left click scoops the source and its entire orphan stream drains", (await state(page)).cells === 0);

  await page.evaluate(() => {
    const c = globalThis.__waterTest;
    for (let x = 85; x <= 94; x++) for (let z = 77; z <= 86; z++) for (let y = 1; y <= 3; y++) {
      c.mineAt(x, y, z); c.placeAt(x, y, z, y === 1 || x === 85 || x === 94 || z === 77 || z === 86 ? "sand" : "water");
    }
    c.teleport(89.5, 2.05, 81.5); c.look(0, 0);
  });
  await page.keyboard.press("KeyV"); // eye-level camera for the underwater check
  await until(page, () => globalThis.__roboCraft.water().wet > 0.35 && globalThis.__roboCraft.water().underwater);
  check("entering deep water switches swimming physics and underwater tint", await page.$eval(".craft-underwater", (el) => el.classList.contains("on")));
  const low = (await state(page)).y;
  await page.keyboard.down("Space"); await wait(2300);
  const high = await state(page);
  check("Space swims up and brings the camera out of the water", high.y > low + 0.5 && !high.underwater, `${low.toFixed(2)} -> ${high.y.toFixed(2)}`);
  await page.keyboard.down("KeyW"); await wait(3000); await page.keyboard.up("KeyW"); await page.keyboard.up("Space");
  const bank = await state(page);
  check("swimming into the bank climbs onto dry ground", bank.y >= 3.95 && bank.wet < 0.35, JSON.stringify(bank));
  const saved = (await state(page)).sources;
  await page.evaluate(() => globalThis.__roboCraft.saveNow());
  await page.goto(`${BASE}/?mode=field`, { waitUntil: "load", timeout: 60000 });
  await until(page, () => !!globalThis.__roboCraft);
  await until(page, (n) => globalThis.__roboCraft.water().sources >= n, saved);
  check("reload restores the saved water", (await state(page)).sources >= saved);
  await until(page, () => globalThis.__roboCraft.waterStats().queued + globalThis.__roboCraft.waterStats().pending === 0);
  check("background meshing finishes and stays available", (await page.evaluate(() => globalThis.__roboCraft.waterStats())).worker);

  const room = `Water${Date.now().toString(36)}`;
  const teacher = await open(`&room=${room}&host=Teacher&pass=1234`);
  const student = await open(`&room=${room}&student=Student`);
  check("teacher and student join the same water-capable classroom", await student.evaluate(() => globalThis.__roboCraft.classroom()?.role === "student"));
  await teacher.evaluate(() => globalThis.__waterTest.placeAt(76, 4, 86, "water"));
  await until(student, () => globalThis.__waterTest.blockAt(83, 4, 86) === 26);
  check("server-generated flow reaches the other browser", await student.evaluate(() => globalThis.__waterTest.blockAt(76, 4, 86) === 19));
  await teacher.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-settings", chatLocked: false, buildLocked: true }));
  await wait(300); await capture(student); await student.keyboard.press("Digit0");
  await student.evaluate(() => { const c = globalThis.__waterTest; c.teleport(85.5, 4, 78.5); c.look(0, -0.65); });
  await wait(200); const prior = (await state(student)).sources;
  await click(student, "right"); await wait(400);
  check("build lock blocks a real student bucket pour", (await state(student)).sources === prior);
  await teacher.evaluate(() => globalThis.__roboCraft.classSend({ t: "k-end" }));
  check("no JavaScript or WebGL errors", errors.length === 0, errors.join(" | "));
} finally { for (const browser of browsers) await browser.close(); }
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exitCode = results.every(Boolean) ? 0 : 1;
