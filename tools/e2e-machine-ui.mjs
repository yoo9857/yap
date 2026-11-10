// Acceptance for readable garage screens, preview clearance and folded sharing.
// Start the client, then node tools/e2e-machine-ui.mjs. Isolated browser saves.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
});
try {
  await mkdir("output/garage-ui-refined", { recursive: true });
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /THREE.WebGLProgram|Shader Error|WebGL: INVALID/.test(message.text())) errors.push(message.text());
  });
  await page.setViewport({ width: 1600, height: 900 });
  await page.goto(`${process.env.BASE_URL ?? "http://127.0.0.1:5173"}/?mode=craft`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => !!window.__roboCraft);
  await page.click(".machine-launch");
  await page.click('.machine-coach [data-id="skip"]');
  await page.waitForFunction(() => window.__roboCraft.machine().assetsLoaded);
  await page.click('.mw-section[data-screen="library"]');
  for (const preset of ['rover', 'plane', 'ship']) {
    await page.click(`[data-preset="${preset}"]`);
    await page.click('[data-id="save"]');
  }
  await page.click('[data-preset="rover"]');
  await page.click('.mw-section[data-screen="tune"]');
  const wheelIndex = await page.evaluate(() => window.__roboCraft.machine().blueprint.parts.findIndex(part => part.kind === 'wheel'));
  await page.select('[data-inspect-index]', String(wheelIndex));
  await page.click('[data-custom-option="color"][data-value="coral"]');
  await page.click('.mw-section[data-screen="library"]');
  await page.click('[data-id="save"]');
  assert.equal(await page.$$eval('[data-action="load"] img', images => images.every(image => image.src.startsWith('data:image/'))), true);
  const savedId = await page.$eval('[data-action="replace"]', element => element.dataset.slot);
  await page.click(`[data-action="replace"][data-slot="${savedId}"]`);
  await page.screenshot({ path: 'output/garage-ui-refined/replace-review.png' });
  await page.keyboard.press('Escape');
  await page.click('[data-action="delete"]');
  await page.click('[data-id="recovery"] > summary');
  await page.screenshot({ path: 'output/garage-ui-refined/recovery.png' });
  await page.click('[data-id="recovery"] > summary');
  for (const [width, height] of [[1600,900], [1280,720], [1024,768], [768,720], [390,844]]) {
    await page.setViewport({ width, height });
    for (const screen of ["parts", "tune", "missions", "library", "help"]) {
      await page.click(`.mw-section[data-screen="${screen}"]`);
      if (screen === "tune") {
        const wheel = await page.evaluate(() => window.__roboCraft.machine().blueprint.parts.findIndex(part => part.kind === "wheel"));
        await page.select("[data-inspect-index]", String(wheel));
        await page.click('[data-tune-section="performance"]');
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await page.evaluate(() => {
        const rect = element => {
          const r = element.getBoundingClientRect();
          return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};
        };
        const overview = document.querySelector(".mw-overview"), run = document.querySelector('[data-id="run"]');
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          tools: rect(document.querySelector(".mw-navigation")),
          overview: getComputedStyle(overview).display === "none" ? null : rect(overview),
          dock: rect(document.querySelector(".mw-body")), footer: rect(document.querySelector(".mw-foot")),
          stage: rect(document.querySelector('[data-id="preview-stage"]')),
          preview: window.__roboCraft.machine().editor.preview,
          actionHeight: run.hidden ? null : run.getBoundingClientRect().height,
          optionType: [...document.querySelectorAll(".mw-option")].filter(button => button.getClientRects().length).map(button => Number.parseFloat(getComputedStyle(button).fontSize)),
          optionLabelsFit: [...document.querySelectorAll(".mw-option")].filter(button => button.getClientRects().length).every(button => {
            const span = button.querySelector("span");
            return button.scrollWidth <= button.clientWidth + 1 && span.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(button).lineHeight) + 1;
          }),
          goalsPlain: [...document.querySelectorAll(".mw-mission")].every(goal => getComputedStyle(goal).backgroundColor === "rgba(0, 0, 0, 0)"),
          importOpen: document.querySelector('[data-id="share-import"]').open,
        };
      });
      const label = `${width}×${height} ${screen}`;
      assert.equal(layout.overflow, false, `${label}: viewport overflow`);
      if (layout.overview) assert.ok(layout.tools.right < layout.overview.left - 4, `${label}: tools overlap the specs`);
      assert.ok(layout.dock.bottom <= layout.footer.top + 1, `${label}: dock overlaps the footer`);
      if (layout.actionHeight) assert.ok(layout.actionHeight >= 44, `${label}: primary action is too small`);
      assert.ok(layout.optionType.every(size => size >= 13), `${label}: editing text is too small`);
      assert.equal(layout.optionLabelsFit, true, `${label}: editing labels wrap or are clipped`);
      assert.equal(layout.goalsPlain, true, `${label}: mission card backgrounds returned`);
      assert.equal(layout.importOpen, false, `${label}: import code is exposed by default`);
      if (width >= 1024 && layout.preview) {
        assert.ok(layout.preview.bottom < layout.dock.top, `${label}: machine is obscured by its workbench`);
        assert.ok(layout.preview.top > layout.stage.top + 25, `${label}: machine overlaps the toolbar`);
      }
      if (width >= 1024) await page.screenshot({ path: `output/garage-ui-refined/${screen}-${width}.png` });
    }
    if (width >= 1024) {
      await page.click('.mw-section[data-screen="library"]');
      for (const preset of ['plane', 'ship', 'rover']) {
        await page.click(`[data-preset="${preset}"]`);
        for (const view of ['front', 'side', 'top', 'fit']) {
          await page.click(`[data-preview="${view}"]`);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const frame = await page.evaluate(() => {
            const stage = document.querySelector('[data-id="preview-stage"]').getBoundingClientRect();
            return {stage:{left:stage.left,right:stage.right,top:stage.top,bottom:stage.bottom},preview:window.__roboCraft.machine().editor.preview};
          });
          assert.ok(frame.preview.top > frame.stage.top + 12 && frame.preview.bottom < frame.stage.bottom, `${width} ${preset} ${view}: vertical framing`);
          assert.ok(frame.preview.left > frame.stage.left && frame.preview.right < frame.stage.right, `${width} ${preset} ${view}: horizontal framing`);
        }
      }
    }
    console.log(`PASS ${width}×${height}: five readable screens, preview and actions clear`);
  }
  assert.deepEqual(errors, []);
  console.log("PASS clean browser console");
} finally {
  await browser.close();
}
