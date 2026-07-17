import puppeteer from "puppeteer-core";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warn") console.log(`[${m.type()}]`, m.text().slice(0, 200));
});
await page.goto("http://localhost:5173/?mode=builder", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => !!globalThis.__roboBuilder, { timeout: 10000 });
await page.evaluate(() => globalThis.__roboBuilder.jumpTo(3, 0.5));
await new Promise((r) => setTimeout(r, 1500));
const snap = await page.evaluate(() => globalThis.__roboBuilder.snapshot());
console.log("state:", JSON.stringify(snap));
const info = await page.evaluate(() => {
  const scene = document.querySelector("canvas");
  return { canvas: !!scene };
});
console.log(info);
await browser.close();
