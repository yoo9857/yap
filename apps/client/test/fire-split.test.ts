import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The fire drill is its own download (src/craft/fire/fireKit.ts): its code, its hand-pose data and
 * the school's collision geometry are megabytes a sandbox player never uses. One careless value
 * import outside the fire folder puts all of it back into every player's first load (it was
 * 3.2 MB of 3.3 before the split, 2026-11-13) and nothing else would notice — so this does.
 */
const SRC = resolve(__dirname, "../src");
const FIRE = join(SRC, "craft", "fire");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (path !== FIRE) sources(path, out); } else if (/\.ts$/.test(name)) out.push(path);
  }
  return out;
}

describe("the fire drill stays out of everyone else's download", () => {
  const files = sources(SRC).map((path) => ({ name: relative(SRC, path).replace(/\\/g, "/"), text: readFileSync(path, "utf8") }));

  it("outside its folder its modules are imported as TYPES only (or its stylesheet, or the kit by a dynamic import)", () => {
    const bad: string[] = [];
    for (const { name, text } of files) {
      for (const m of text.matchAll(/^\s*import\s+(?!type\b)[^;\n]*?from\s+["']([^"']*\/fire\/[^"']*)["']/gm)) bad.push(`${name}: ${m[0].trim()}`);
      for (const m of text.matchAll(/^\s*import\s+["']([^"']*\/fire\/[^"']*)["']/gm)) if (!/\.css$/.test(m[1]!)) bad.push(`${name}: ${m[0].trim()}`);
      for (const m of text.matchAll(/import\(\s*["']([^"']*\/fire\/[^"']*)["']\s*\)/g)) if (!/\/fireKit\.js$/.test(m[1]!)) bad.push(`${name}: ${m[0]} (load fireKit.js instead)`);
    }
    expect(bad).toEqual([]);
  });

  it("…and the school (shared) is reached through the kit, not imported by value", () => {
    const bad: string[] = [];
    for (const { name, text } of files) {
      for (const m of text.matchAll(/^\s*import\s+(?!type\b)\{([^}]*)\}\s*from\s+["']@robo\/shared["']/gm)) {
        const values = m[1]!.split(",").map((part) => part.trim()).filter((part) => part && !/^type\s/.test(part));
        for (const value of values) if (/^(fireSchool|FIRE_CAMPUS|FIRE_SCHOOL_BLOCKS)\b/.test(value)) bad.push(`${name}: ${value}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the kit is loaded for the fire theme, and the game refuses that theme without it", () => {
    const main = files.find((f) => f.name === "main.ts")!.text, game = files.find((f) => f.name === "craft/craftGame.ts")!.text;
    expect(main).toMatch(/theme === "fire" \? import\("\.\/craft\/fire\/fireKit\.js"\)/);
    expect(game).toMatch(/the fire theme needs its code/);
  });
});
