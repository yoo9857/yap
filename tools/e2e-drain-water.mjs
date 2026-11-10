// Local-only browser integration: F2 -> server -> every student's field and water meshes.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5173";
assert(["localhost", "127.0.0.1"].includes(new URL(BASE).hostname), "Run this check against a local test server only");
const OUT = "tmp/water-drain-qa";
mkdirSync(OUT, { recursive: true });
const ROOM = `물정리${Date.now() % 100000}`;
const browsers = [], errors = [];
const check = (name, ok) => { assert(ok, name); console.log(`PASS ${name}`); };
async function open(query) {
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
  });
  browsers.push(browser);
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (dialog) => { errors.push(`Unexpected confirmation: ${dialog.message()}`); void dialog.dismiss(); });
  const url = `${BASE}/?${new URLSearchParams({ mode: "field", room: ROOM, ...query })}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => globalThis.__roboCraft?.classroom?.()?.online && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  return page;
}
const send = (page, message) => page.evaluate((m) => globalThis.__roboCraft.classSend(m), message);
async function water(page, expected) {
  await page.waitForFunction((expected) => (globalThis.__roboCraft.waterAt(60, 4, 60) > 0) === expected, { timeout: 15000 }, expected);
}
try {
  const teacher = await open({ host: "김선생", pass: "1234" });
  const student = await open({ student: "민지" });
  await teacher.evaluate(() => globalThis.__roboCraft.placeAt(65, 4, 60, "stone"));
  check("teacher places furniture", await teacher.evaluate(() => globalThis.__roboCraft.furniturePlace("chair", 70, 4, 60)));
  await student.evaluate(() => globalThis.__roboCraft.placeAt(60, 4, 60, "water"));
  await water(teacher, true); await water(student, true);
  await student.keyboard.press("F2");
  check("student has no teacher cleanup button", await student.$(".ct-drain") === null);
  await send(student, { t: "k-drain-water" });
  await water(teacher, true);
  check("server refuses student water cleanup", await teacher.evaluate(() => globalThis.__roboCraft.waterAt(60, 4, 60) > 0));
  await teacher.keyboard.press("F2");
  await teacher.waitForSelector(".ct:not([hidden]) .ct-drain");
  check("F2 labels the cleanup button", (await teacher.$eval(".ct-drain", (el) => el.textContent)).includes("빠르게 물 빼기"));
  await teacher.screenshot({ path: `${OUT}/teacher-f2.png` });
  await teacher.setViewport({ width: 600, height: 800 });
  check("narrow F2 footer stays inside the screen", await teacher.$eval(".ct-foot", (el) => el.scrollWidth <= el.clientWidth));
  await teacher.screenshot({ path: `${OUT}/teacher-f2-narrow.png` });
  await teacher.setViewport({ width: 1366, height: 768 });
  await teacher.click(".ct-drain");
  await water(teacher, false); await water(student, false);
  check("one F2 click drains water on teacher and student", true);
  await student.waitForFunction(() => globalThis.__roboCraft.blockAt(65, 4, 60) === 3 && globalThis.__roboCraft.furniture().items.length === 1, { timeout: 10000 });
  check("student retains buildings and furniture", true);
  check("both users remain connected", await teacher.evaluate(() => globalThis.__roboCraft.classroom().online) && await student.evaluate(() => globalThis.__roboCraft.classroom().online));
  await teacher.screenshot({ path: `${OUT}/teacher-after-drain.png` });
  await student.reload({ waitUntil: "domcontentloaded" });
  await student.waitForFunction(() => globalThis.__roboCraft?.classroom?.()?.online && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  await water(student, false);
  check("reload keeps water drained and furniture intact", await student.evaluate(() => globalThis.__roboCraft.blockAt(65, 4, 60) === 3 && globalThis.__roboCraft.furniture().items.length === 1));
  await student.evaluate(() => globalThis.__roboCraft.placeAt(60, 4, 60, "water"));
  await water(teacher, true);
  check("new water placement works after cleanup", true);
  await teacher.keyboard.press("F2");
  await teacher.waitForSelector(".ct:not([hidden]) .ct-drain");
  await teacher.click(".ct-drain");
  await water(student, false);
  check("cleanup can be repeated", true);
  check("no browser errors or extra confirmations", errors.length === 0);
  await send(teacher, { t: "k-end" });
  console.log(`Screenshots: ${OUT}`);
} finally {
  for (const browser of browsers) await browser.close();
}
