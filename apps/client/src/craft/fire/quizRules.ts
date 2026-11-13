import { DRILL_QUIZ_QUESTIONS } from "@robo/shared";
import { t } from "../../ui/i18n.js";
import { QUIZ_ART } from "./quizArt.js";

/**
 * The teacher's quiz (F2 → 퀴즈 시작) as a GAME, not a test paper (owner 2026-11-13: "like a real
 * game's puzzle quiz, with drawn pictures"): five ROUNDS, each a small puzzle played on pictures —
 * dial the number, put the extinguisher's steps in order, press where to aim, sort what to do
 * from what not to, pick the right picture. Pure: which rounds a quiz plays, and in what order
 * its pieces are laid out, is a function of the quiz's NUMBER (the server counts them), so the
 * whole class plays the same five the same way — the teacher can go through them aloud — and the
 * next quiz plays other ones. Nobody fails: a wrong move shows the right one and why.
 *
 * Pictures: assets/fire-quiz (Codex image generation) → public/ui/quiz/<name>.webp. They carry no
 * text and no marks; every word and every ⭕/❌ is drawn by the quiz.
 */
export interface QuizCard {
  /** The picture's name (public/ui/quiz/<img>.webp). */
  img: string;
  label: string;
}

interface RoundBase {
  /** A stable name (tests, and telling rounds apart). */
  id: string;
  ask: string;
  /** Said after the round, right or wrong: the reason. */
  why: string;
}
export type QuizRound = RoundBase & (
  /** Press the right picture. */
  | { kind: "pick"; cards: QuizCard[]; answer: number }
  /** Press the cards in the right order. `cards` are laid out as shown; `order[k]` is which card comes k-th. */
  | { kind: "order"; cards: QuizCard[]; order: number[] }
  /** Press the right place on a picture. A spot is a point on it (0–1 from its top-left). */
  | { kind: "spot"; img: string; spots: { x: number; y: number; label: string }[]; answer: number }
  /** Dial a number on a keypad. */
  | { kind: "dial"; img: string; number: string }
  /** One card at a time: is this what to do (⭕) or not (❌)? */
  | { kind: "sort"; cards: (QuizCard & { good: boolean })[] }
);

/** How many cards a sort round shows (half of them things to do). */
export const QUIZ_SORT_CARDS = 4;

/** What to do, and what not to: the sort round draws from these. */
function deeds(): (QuizCard & { good: boolean })[] {
  return [
    { img: "act-alarm", label: t("화재경보기 누르기", "Press the fire alarm"), good: true },
    { img: "act-towel", label: t("젖은 수건으로 코와 입 막기", "Wet towel over nose and mouth"), good: true },
    { img: "act-low", label: t("몸을 낮춰 이동하기", "Move low"), good: true },
    { img: "act-exit", label: t("비상구 표시 따라 계단으로", "Follow the exit sign to the stairs"), good: true },
    { img: "act-gather", label: t("모이는 곳에 모이기", "Gather at the meeting place"), good: true },
    { img: "bad-elevator", label: t("엘리베이터 타기", "Take the lift"), good: false },
    { img: "bad-goback", label: t("가방 가지러 다시 들어가기", "Go back in for my bag"), good: false },
    { img: "bad-hide", label: t("책상 밑에 숨기", "Hide under a desk"), good: false },
    { img: "bad-upright", label: t("연기 속을 서서 걷기", "Walk upright through smoke"), good: false },
  ];
}

/** Is this picture built (public/ui/quiz, listed by assets/fire-quiz/build.mjs)? */
export const quizArtReady = (img: string, art: readonly string[] = QUIZ_ART): boolean => art.includes(img);

/**
 * The rounds that can be played with the pictures that exist: a round whose pictures are not all
 * there is left out (a pick may lose a wrong card, never its right one, and keeps at least two);
 * a sort needs two things to do and two not to. The pack is generated a few pictures at a time.
 */
export function quizPool(art: readonly string[] = QUIZ_ART): QuizRound[] {
  const has = (img: string): boolean => art.includes(img);
  const out: QuizRound[] = [];
  for (const r of everyRound()) {
    if (r.kind === "pick") {
      const right = r.cards[r.answer]!;
      const cards = r.cards.filter((c) => has(c.img));
      if (has(right.img) && cards.length >= 2) out.push({ ...r, cards, answer: cards.indexOf(right) });
    } else if (r.kind === "order") {
      if (r.cards.every((c) => has(c.img))) out.push(r);
    } else if (r.kind === "sort") {
      const cards = r.cards.filter((c) => has(c.img));
      if (cards.filter((c) => c.good).length >= QUIZ_SORT_CARDS / 2 && cards.filter((c) => !c.good).length >= QUIZ_SORT_CARDS / 2) out.push({ ...r, cards });
    } else if (has(r.img)) out.push(r);
  }
  return out;
}

/** Every round there is, each with its RIGHT answer first / in the right order (a quiz shuffles the layout). */
function everyRound(): QuizRound[] {
  return [
    {
      id: "dial", kind: "dial", img: "phone", number: "119",
      ask: t("불이 났어요! 전화기로 신고해요", "There is a fire! Call for help"),
      why: t("불이 나면 119. 어디에서 무슨 일이 났는지 말해요. (112는 경찰이에요)", "For a fire: 119 — say where and what is burning. (112 is the police.)"),
    },
    {
      id: "pass", kind: "order", order: [0, 1, 2, 3],
      cards: [
        { img: "pass-pin", label: t("안전핀 뽑기", "Pull the pin") },
        { img: "pass-aim", label: t("불 쪽으로 겨누기", "Aim at the fire") },
        { img: "pass-squeeze", label: t("손잡이 꽉 쥐기", "Squeeze the handle") },
        { img: "pass-sweep", label: t("빗자루로 쓸듯이 뿌리기", "Sweep from side to side") },
      ],
      ask: t("소화기 사용 순서대로 눌러요", "Press the extinguisher's steps in order"),
      why: t("핀을 뽑아야 손잡이가 눌려요. 그다음 겨누고 → 쥐고 → 쓸듯이!", "The handle only works once the pin is out. Then aim → squeeze → sweep!"),
    },
    {
      id: "base", kind: "spot", img: "fire-bin", answer: 0,
      // measured on fire-bin.webp: the burning paper at the bin's rim, the flames, the smoke
      spots: [
        { x: 0.5, y: 0.55, label: t("불의 아래쪽", "The base of the fire") },
        { x: 0.5, y: 0.37, label: t("불꽃", "The flames") },
        { x: 0.55, y: 0.2, label: t("연기", "The smoke") },
      ],
      ask: t("소화기를 어디에 뿌릴까요? 그림을 눌러요", "Where do you spray? Press the picture"),
      why: t("타고 있는 물건(불의 아래쪽)을 덮어야 꺼져요. 불꽃만 뿌리면 다시 살아나요.", "Cover what is burning — the base — and it goes out. Spraying only the flames lets it come back."),
    },
    {
      id: "size", kind: "pick", answer: 0,
      cards: [
        { img: "fire-bin", label: t("쓰레기통의 작은 불", "A small fire in a bin") },
        { img: "fire-big", label: t("문을 가득 채운 큰불", "A big fire filling a doorway") },
      ],
      ask: t("소화기로 꺼도 되는 불은 어느 쪽일까요?", "Which fire may you fight with an extinguisher?"),
      why: t("작은 불만 꺼요. 내 키보다 큰 불은 끄지 말고 바로 대피!", "Only a small one. A fire taller than you: do not fight it, get out!"),
    },
    {
      id: "first", kind: "pick", answer: 0,
      cards: [
        { img: "act-alarm", label: t("“불이야!” 외치고 경보기 누르기", "Shout “Fire!” and press the alarm") },
        { img: "bad-hide", label: t("책상 밑에 숨기", "Hide under a desk") },
        { img: "bad-goback", label: t("내 가방부터 챙기기", "Fetch my bag first") },
      ],
      ask: t("불을 봤어요. 가장 먼저 할 일은?", "You see a fire. What do you do first?"),
      why: t("먼저 모두에게 알려야 다 같이 대피할 수 있어요.", "Everyone has to know first, so everyone can get out."),
    },
    {
      id: "smoke", kind: "pick", answer: 0,
      cards: [
        { img: "act-low", label: t("몸을 낮춰서 지나가기", "Go through low") },
        { img: "bad-upright", label: t("서서 걸어가기", "Walk through upright") },
        { img: "bad-hide", label: t("숨어서 기다리기", "Hide and wait") },
      ],
      ask: t("복도에 연기가 가득해요. 어떻게 지나갈까요?", "The corridor is full of smoke. How do you get through?"),
      why: t("연기는 위로 올라가요. 아래쪽 공기가 더 맑아요. 젖은 수건으로 코와 입도 막아요.", "Smoke rises: the air near the floor is cleaner. Cover your nose and mouth with a wet towel too."),
    },
    {
      id: "way", kind: "pick", answer: 0,
      cards: [
        { img: "act-exit", label: t("초록 비상구 표시를 따라 계단으로", "Follow the green exit sign to the stairs") },
        { img: "bad-elevator", label: t("엘리베이터로", "By the lift") },
      ],
      ask: t("어디로 나가야 할까요?", "Which way out?"),
      why: t("불이 나면 엘리베이터는 멈출 수 있어요. 비상구 표시를 따라 계단으로!", "A lift can stop in a fire. Follow the exit signs and take the stairs!"),
    },
    {
      id: "after", kind: "pick", answer: 0,
      cards: [
        { img: "act-gather", label: t("모이는 곳으로 가서 기다리기", "Go to the meeting place and wait") },
        { img: "bad-goback", label: t("두고 온 물건을 가지러 다시 들어가기", "Go back in for what I left") },
      ],
      ask: t("건물 밖으로 나왔어요. 이제 어떻게 할까요?", "You are out of the building. What now?"),
      why: t("모여야 모두 나왔는지 선생님이 알 수 있어요. 다시 들어가지 않아요.", "Only when everyone gathers can the teacher know all are out. Never go back in."),
    },
    {
      id: "deeds", kind: "sort", cards: deeds(),
      ask: t("해도 될까요, 안 될까요? ⭕ ❌ 로 나눠요", "Do it, or not? Sort with ⭕ and ❌"),
      why: t("알리고, 낮추고, 막고, 계단으로 나가서, 모여요. 숨거나 돌아가지 않아요.", "Tell everyone, get low, cover up, take the stairs, gather. Never hide and never go back."),
    },
  ];
}

/** A small deterministic generator (the quiz's number is its seed). */
function generator(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffledIndices(n: number, rand: () => number): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The rounds quiz number `quiz` plays, laid out as it shows them. */
export function quizRounds(quiz: number, art: readonly string[] = QUIZ_ART): QuizRound[] {
  const rand = generator(quiz);
  const all = quizPool(art);
  return shuffledIndices(all.length, rand).slice(0, DRILL_QUIZ_QUESTIONS).map((i): QuizRound => {
    const r = all[i]!;
    if (r.kind === "pick") {
      const at = shuffledIndices(r.cards.length, rand);
      return { ...r, cards: at.map((k) => r.cards[k]!), answer: at.indexOf(r.answer) };
    }
    if (r.kind === "order") {
      // never laid out already solved
      let at = shuffledIndices(r.cards.length, rand);
      if (at.every((k, i) => k === i)) at = [...at.slice(1), at[0]!];
      return { ...r, cards: at.map((k) => r.cards[k]!), order: r.order.map((k) => at.indexOf(k)) };
    }
    if (r.kind === "sort") {
      const good = r.cards.filter((c) => c.good), bad = r.cards.filter((c) => !c.good);
      const take = <T,>(from: T[], n: number): T[] => shuffledIndices(from.length, rand).slice(0, n).map((k) => from[k]!);
      const cards = [...take(good, QUIZ_SORT_CARDS / 2), ...take(bad, QUIZ_SORT_CARDS / 2)];
      return { ...r, cards: shuffledIndices(cards.length, rand).map((k) => cards[k]!) };
    }
    return r;
  });
}

/** Every picture the whole quiz wants (assets/fire-quiz/generate.mjs makes them; a test lists what is still missing). */
export function quizPictures(): string[] {
  const names = new Set<string>(["medal", "cheer", "think"]);
  for (const r of everyRound()) {
    if (r.kind === "pick" || r.kind === "order" || r.kind === "sort") for (const c of r.cards) names.add(c.img);
    else names.add(r.img);
  }
  return [...names].sort();
}

/** Is this move the round's answer? `pick` / `spot`: the index pressed; `order`: the cards in the order pressed; `dial`: the digits; `sort`: ⭕ (true) / ❌ for each card. */
export function roundRight(round: QuizRound, move: number | number[] | string | boolean[]): boolean {
  switch (round.kind) {
    case "pick":
    case "spot":
      return move === round.answer;
    case "order":
      return Array.isArray(move) && move.length === round.order.length && round.order.every((k, i) => move[i] === k);
    case "dial":
      return move === round.number;
    case "sort":
      return Array.isArray(move) && move.length === round.cards.length && round.cards.every((c, i) => move[i] === c.good);
  }
}
