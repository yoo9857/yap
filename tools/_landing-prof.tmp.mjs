import puppeteer from "puppeteer-core";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const t0 = Date.now();
await page.goto("https://craftyap.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".mode-btn", { timeout: 60000 });
const tReady = Date.now() - t0;
await page.waitForNetworkIdle({ idleTime: 900, timeout: 60000 }).catch(() => {});
const rows = await page.evaluate(() =>
  performance.getEntriesByType("resource").map((r) => ({
    url: r.name.replace("https://craftyap.com", ""),
    kb: Math.round((r.transferSize || r.encodedBodySize || 0) / 1024),
    ms: Math.round(r.responseEnd - r.startTime),
  })).sort((a, b) => b.kb - a.kb),
);
console.log(`mode-selector visible: ${tReady}ms`);
console.log("=== transferred sizes (top 10) ===");
rows.slice(0, 10).forEach((r) => console.log(`  ${String(r.kb).padStart(5)} KB  ${String(r.ms).padStart(5)}ms  ${r.url}`));
console.log(`total transferred: ${Math.round(rows.reduce((s, r) => s + r.kb, 0))} KB`);
await browser.close();
