import { describe, expect, it } from "vitest";
import { playerNameSchema } from "@robo/shared";
import { cleanName } from "../src/ui/screens.js";

describe("tower nickname", () => {
  it("drops the invisible characters the server's name rule refuses", () => {
    for (const raw of ["민수👩‍💻", "a​b", "  철수\u0007  ", "🏳️‍🌈🏳️‍🌈🏳️‍🌈🏳️‍🌈🏳️‍🌈", "abcdefghijklmnopqrstuvwxyz"]) {
      const name = cleanName(raw);
      expect(name.length).toBeGreaterThan(0);
      expect(playerNameSchema.safeParse(name).success).toBe(true);
    }
    expect(cleanName("a​b")).toBe("ab");
  });

  it("never splits an emoji at the length limit", () => {
    const name = cleanName("123456789012345😀");
    expect(name).toBe("123456789012345");
  });
});
