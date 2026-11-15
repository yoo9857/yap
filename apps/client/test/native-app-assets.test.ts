import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The native app (engine/crates/client) compiles web files in with `include_bytes!` through its
 * `web!("…")` macros: deleting or renaming such a file in `public/` breaks the app's build, and the
 * engine workflow only runs when engine paths change. (2026-11-15: the old menu picture was
 * removed with the menu redesign; the app still drew it — its build was broken for a day.)
 */
describe("the web files the native app compiles in", () => {
  const src = new URL("../../../engine/crates/client/src/", import.meta.url);
  const pub = new URL("../public/", import.meta.url);

  it("all exist", () => {
    const missing: string[] = [];
    for (const file of readdirSync(src).filter((f) => f.endsWith(".rs"))) {
      const code = readFileSync(new URL(file, src), "utf8");
      // each file's macro names the folder its paths are under
      const base = /macro_rules! web[\s\S]*?apps\/client\/public\/([^"]*)"/.exec(code)?.[1] ?? "";
      for (const [, path] of code.matchAll(/\bweb!\("([^"]+)"\)/g)) {
        if (!existsSync(new URL(base + path, pub))) missing.push(`${file}: public/${base}${path}`);
      }
    }
    expect(missing, "the app includes these files; restore them or change the app with them").toEqual([]);
  });
});
