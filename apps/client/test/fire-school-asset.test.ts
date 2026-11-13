// The school the game loads (school.min.glb) is MADE from the Blender export (school.glb) by
// tools/optimize-fire-school.mjs. A new export without a new .min would ship yesterday's school:
// this fails until the tool is run again. It also keeps what the tool is for from slipping back.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dir = resolve(__dirname, "../public/models/environments/fire-school");
interface Stamp { source: string; sourceBytes: number; bytes: number; before: { draws: number; triangles: number }; after: { draws: number; triangles: number; materials: number } }

describe("the fire school's optimised model", () => {
  const stamp = JSON.parse(readFileSync(resolve(dir, "school.min.json"), "utf8")) as Stamp;

  it("was made from the school.glb that is there now (else: node tools/optimize-fire-school.mjs)", () => {
    expect(existsSync(resolve(dir, "school.min.glb"))).toBe(true);
    expect(stamp.source).toBe(createHash("sha256").update(readFileSync(resolve(dir, "school.glb"))).digest("hex"));
    expect(statSync(resolve(dir, "school.min.glb")).size).toBe(stamp.bytes);
  });

  it("is a fraction of the export to download and to draw, and the same school", () => {
    expect(stamp.bytes).toBeLessThan(stamp.sourceBytes * 0.4);
    expect(stamp.bytes).toBeLessThan(6e6); // a phone on mobile data downloads this (the school itself grew: 265k triangles)
    expect(stamp.after.draws).toBeLessThanOrEqual(stamp.after.materials + 8); // about one mesh per material
    expect(stamp.after.draws).toBeLessThan(stamp.before.draws * 0.4);
    expect(stamp.after.triangles).toBe(stamp.before.triangles); // nothing was thrown away
  });
});
