import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The first page's headline is its largest paint, and it is drawn at the first paint only because
 * its letters come with the page: `public/fonts/jua-menu.woff2` (assets/fonts/build.py), whose
 * letters are listed in `assets/fonts/jua-menu.txt`. Text added to the first page, the mode choice
 * or the loader without rebuilding the file would be drawn late again, in Google's Jua.
 */
describe("the menu screens' own letters (Jua Menu)", () => {
  const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const held = new Set(readFileSync(new URL("../../../assets/fonts/jua-menu.txt", import.meta.url), "utf8"));
  const first = page.slice(page.indexOf('<div class="mode-step web-home"'), page.indexOf('<div class="hub-shell">'));
  const loader = page.slice(page.indexOf('<div id="boot-overlay"'));
  const text = (first + loader).replace(/<script[\s\S]*?<\/script>|<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ");

  it("holds every Korean letter and Latin letter written on the first page, the mode choice and the loader", () => {
    const missing = [...new Set(text)].filter((ch) => /[\uac00-\ud7a3A-Za-z0-9]/.test(ch) && !held.has(ch));
    expect(missing.join(""), "run: python assets/fonts/build.py").toBe("");
  });

  it("is preloaded, and asked for first by those screens", () => {
    expect(page).toContain('<link rel="preload" as="font" type="font/woff2" href="/fonts/jua-menu.woff2" crossorigin />');
    expect(page.match(/font-family: "Jua Menu", "Jua"/g)?.length).toBeGreaterThanOrEqual(3);
    // Google's stylesheet must not hold the first paint back
    expect(page).toMatch(/fonts\.googleapis\.com\/css2\?family=Jua&display=swap" rel="stylesheet" media="print"/);
  });
});
