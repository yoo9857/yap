import { describe, expect, it } from "vitest";
import { objectParticle, withObjectParticle } from "../src/craft/korean.js";
import { PET_SPECIES, SPECIES } from "../src/player/creatureRig.js";

describe("Korean object particle", () => {
  it("picks 을 after a final consonant and 를 after a vowel", () => {
    expect(objectParticle("기린")).toBe("을"); // ㄴ 받침
    expect(objectParticle("시바견")).toBe("을"); // ㄴ 받침
    expect(objectParticle("판다")).toBe("를");
    expect(objectParticle("고양이")).toBe("를");
    expect(objectParticle("코끼리")).toBe("를");
  });

  it("falls back to 를 for anything that is not a Hangul syllable", () => {
    for (const odd of ["", "cat", "42", "🐈", "LEGO"]) {
      expect(objectParticle(odd), odd).toBe("를");
    }
  });

  it("reads correctly for every pet name in the roster", () => {
    const sentences = PET_SPECIES.map((k) => `${withObjectParticle(SPECIES[k].name)} 입양했어요`);
    expect(sentences).toEqual([
      "시바견을 입양했어요",
      "하얀 고양이를 입양했어요",
      "아기 코끼리를 입양했어요",
      "아기 기린을 입양했어요",
      "판다를 입양했어요",
    ]);
  });
});
