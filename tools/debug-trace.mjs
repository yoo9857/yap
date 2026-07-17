import puppeteer from "puppeteer-core";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage();
await page.goto("http://localhost:5173/?mode=tower", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(
  () => document.getElementById("boot-overlay")?.classList.contains("hidden"),
  { timeout: 20000 },
);
await page.evaluate(() => {
  const p = globalThis.__robo.level().find((q) => q.kind === "moving");
  const pos = globalThis.__robo.platformPos(p.id);
  globalThis.__robo.teleport(pos[0], pos[1] + p.size[1] / 2 + 0.05, pos[2]);
});
await new Promise((r) => setTimeout(r, 4500)); // ride into the drift zone
const trace = await page.evaluate(() => globalThis.__robo.trace());
let bad = 0;
for (const t of trace) if (Math.abs(t.cx - t.dx) > 1e-4) bad++;
console.log(`trace ${trace.length} ticks, ${bad} with |cx-dx|>1e-4`);
for (const t of trace.filter((t) => Math.abs(t.cx - t.dx) > 1e-4).slice(0, 25)) {
  console.log(
    `dx=${t.dx.toFixed(5)} cx=${t.cx.toFixed(5)} dy=${t.dy.toFixed(4)} cy=${t.cy.toFixed(4)} pdx=${t.pdx.toFixed(4)} g=${t.g}`,
  );
}
await browser.close();
