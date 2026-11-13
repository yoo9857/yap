// The teacher's quiz (craft/fire/quizRules.ts): which five picture puzzles a quiz plays, how they
// are laid out, and what counts as right. Pure — and every picture it names has to be there.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DRILL_QUIZ_QUESTIONS } from "@robo/shared";
import { QUIZ_ART } from "../src/craft/fire/quizArt.js";
import { QUIZ_SORT_CARDS, quizPictures, quizPool, quizRounds, roundRight, type QuizRound } from "../src/craft/fire/quizRules.js";

// the rules are judged on the WHOLE pack (every picture there), whatever has been generated so far
const WHOLE = quizPictures();
const many = Array.from({ length: 60 }, (_, i) => quizRounds(i + 1, WHOLE));
const of = <K extends QuizRound["kind"]>(kind: K) => many.flat().filter((r): r is Extract<QuizRound, { kind: K }> => r.kind === kind);

describe("the teacher's quiz, a game of picture puzzles", () => {
  it("plays five different rounds, and over many quizzes every kind of puzzle comes up", () => {
    for (const rounds of many) {
      expect(rounds).toHaveLength(DRILL_QUIZ_QUESTIONS);
      expect(new Set(rounds.map((r) => r.id)).size).toBe(DRILL_QUIZ_QUESTIONS);
      for (const r of rounds) { expect(r.ask.length).toBeGreaterThan(5); expect(r.why.length).toBeGreaterThan(5); }
    }
    expect(new Set(many.flat().map((r) => r.kind))).toEqual(new Set(["pick", "order", "spot", "dial", "sort"]));
  });

  it("is the same quiz for everyone in the class (a function of its number), and another one next time", () => {
    expect(quizRounds(7, WHOLE)).toEqual(quizRounds(7, WHOLE));
    expect(new Set(many.slice(0, 8).map((rounds) => JSON.stringify(rounds))).size).toBeGreaterThan(5);
  });

  it("pick: two to four pictures, one right — and not always in the same place", () => {
    const picks = of("pick");
    expect(picks.length).toBeGreaterThan(20);
    for (const r of picks) {
      expect(r.cards.length).toBeGreaterThanOrEqual(2); expect(r.cards.length).toBeLessThanOrEqual(4);
      expect(new Set(r.cards.map((c) => c.img)).size).toBe(r.cards.length);
      expect(r.cards[r.answer]!.img).toMatch(/^act-|^fire-bin$/); // the right picture is a thing to DO (or the small fire)
      expect(roundRight(r, r.answer)).toBe(true);
      expect(roundRight(r, (r.answer + 1) % r.cards.length)).toBe(false);
    }
    expect(new Set(picks.map((r) => r.answer)).size).toBeGreaterThan(1);
  });

  it("order: the extinguisher's four steps, shuffled, never laid out already solved", () => {
    const orders = of("order");
    expect(orders.length).toBeGreaterThan(5);
    for (const r of orders) {
      expect(r.order.map((k) => r.cards[k]!.img)).toEqual(["pass-pin", "pass-aim", "pass-squeeze", "pass-sweep"]);
      expect(r.order).not.toEqual([0, 1, 2, 3]);
      expect(roundRight(r, r.order)).toBe(true);
      expect(roundRight(r, [0, 1, 2, 3])).toBe(false);
      expect(roundRight(r, r.order.slice(0, 3))).toBe(false);
    }
  });

  it("spot: the base of the fire, not the flames or the smoke; dial: 119", () => {
    for (const r of of("spot")) {
      expect(r.spots[r.answer]!.label).toMatch(/아래쪽|base/i);
      for (const s of r.spots) { expect(s.x).toBeGreaterThan(0.05); expect(s.x).toBeLessThan(0.95); expect(s.y).toBeGreaterThan(0.05); expect(s.y).toBeLessThan(0.95); }
      expect(r.spots[r.answer]!.y).toBeGreaterThan(Math.max(...r.spots.filter((_, k) => k !== r.answer).map((s) => s.y))); // the lowest of them
      expect(roundRight(r, r.answer)).toBe(true);
    }
    for (const r of of("dial")) { expect(roundRight(r, "119")).toBe(true); expect(roundRight(r, "112")).toBe(false); expect(roundRight(r, "")).toBe(false); }
  });

  it("sort: as many things to do as not to, and every card has to be put right", () => {
    for (const r of of("sort")) {
      expect(r.cards).toHaveLength(QUIZ_SORT_CARDS);
      expect(r.cards.filter((c) => c.good)).toHaveLength(QUIZ_SORT_CARDS / 2);
      for (const c of r.cards) expect(c.img.startsWith(c.good ? "act-" : "bad-")).toBe(true);
      const right = r.cards.map((c) => c.good);
      expect(roundRight(r, right)).toBe(true);
      expect(roundRight(r, right.map((g, i) => (i === 0 ? !g : g)))).toBe(false);
    }
  });

  it("only plays rounds whose pictures exist: an unfinished pack is a shorter pool, never a broken picture", () => {
    for (const name of QUIZ_ART) expect(existsSync(resolve(__dirname, `../public/ui/quiz/${name}.webp`)), name).toBe(true);
    const pool = quizPool();
    expect(pool.length).toBeGreaterThanOrEqual(DRILL_QUIZ_QUESTIONS); // enough for a whole quiz today
    for (const r of pool) {
      const imgs = r.kind === "pick" || r.kind === "order" || r.kind === "sort" ? r.cards.map((c) => c.img) : [r.img];
      for (const img of imgs) expect(QUIZ_ART, `${r.id}: ${img}`).toContain(img);
    }
    for (let quiz = 1; quiz < 20; quiz++) expect(quizRounds(quiz)).toHaveLength(DRILL_QUIZ_QUESTIONS);
    // with nothing but the extinguisher's four pictures there is exactly one round to play
    expect(quizPool(["pass-pin", "pass-aim", "pass-squeeze", "pass-sweep"]).map((r) => r.id)).toEqual(["pass"]);
    // a pick keeps its right card and at least one wrong one, or it is left out
    expect(quizPool(["act-exit"]).length).toBe(0);
    expect(quizPool(["act-exit", "bad-elevator"]).map((r) => r.id)).toEqual(["way"]);
  });

  it("says which pictures are still to be generated (not a failure: node assets/fire-quiz/generate.mjs)", () => {
    const missing = WHOLE.filter((name) => !QUIZ_ART.includes(name));
    if (missing.length > 0) console.warn(`quiz pictures still to generate: ${missing.join(", ")}`);
    expect(missing.length).toBeLessThan(WHOLE.length / 2);
  });
});
