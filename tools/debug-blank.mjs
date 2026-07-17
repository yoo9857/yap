import puppeteer from "puppeteer-core";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const b = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
});
const p = await b.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
p.on("console", (m) => console.log(`[${m.type()}]`, m.text().slice(0, 120)));
const t0 = Date.now();
try {
  await p.goto("http://localhost:5173/__e2e_blank", { waitUntil: "domcontentloaded", timeout: 20000 });
  console.log("blank ok", Date.now() - t0, "ms");
} catch (e) {
  console.log("blank FAIL", e.message);
}
await b.close();
