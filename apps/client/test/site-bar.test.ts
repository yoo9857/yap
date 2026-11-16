import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every page of the site has the SAME bar: the same links, in the same order, with the same words
 * (2026-11-16: going from the first page to the guide or the notes, the menu changed its links,
 * size and place). The sizes are one set of numbers in guide.css and index.html; this pins the links
 * and the unit, so a page added or a link changed on one page alone fails here.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const links = (html: string, nav: string): string[] => {
  const block = new RegExp(`<nav class="${nav}"[^>]*>([^]*?)</nav>`).exec(html)?.[1] ?? "";
  return [...block.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => `${m[2]} → ${m[1]}`);
};

describe("the site's bar", () => {
  const home = links(read("index.html"), "web-nav");
  it("has its links on the first page", () => {
    expect(home.length).toBeGreaterThanOrEqual(4);
    expect(home[0]).toBe("게임 소개 → /guide/");
  });
  for (const page of ["public/guide/index.html", "public/cases/index.html", "public/note/index.html", "public/note/patch-2026-11-16/index.html", "public/404.html", "public/teacher/index.html", "public/admin/index.html"]) {
    it(`is the same on ${page}`, () => {
      expect(links(read(page), "header-nav")).toEqual(home);
    });
  }
  it("is sized by one unit on the first page and on the other pages", () => {
    const unit = (text: string) => /--menu-u:\s*([^;}]+)/.exec(text)?.[1]?.replace(/\s+/g, "") ?? "";
    expect(unit(read("index.html"))).not.toBe("");
    expect(unit(read("public/guide/guide.css"))).toBe(unit(read("index.html")));
  });
});
