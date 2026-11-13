import { t } from "../../ui/i18n.js";
import { quizArtReady, roundRight, type QuizCard, type QuizRound } from "./quizRules.js";
import "./fireQuiz.css";

/**
 * The teacher's quiz on a student's screen, played as a game: five rounds of small picture
 * puzzles (quizRules.ts) — dial 119 on a keypad, press the extinguisher's steps in order, press
 * where to aim on the burning bin, sort what to do from what not to, pick the right picture.
 * Every move answers at once (the right thing lights up, the reason is said, the mascot cheers);
 * nobody fails. At the end: a medal, the stars, and each round's reason again. It frees the mouse
 * like the drill's lesson cards (the drill waits while it is up).
 *
 * The look is the in-game pack's (assets/ui-game): LINELESS soft toy plastic — a yellow brick
 * board with studs, cream face, parts that press down on their own darker edge. All of it is CSS
 * (fireQuiz.css); the pieces that are objects (stars, the ⭕/❌ buttons, the aiming ring) are
 * pictures when they have been generated (`ui-*`), and drawn in CSS until then.
 *
 * Pictures are public/ui/quiz/*.webp (assets/fire-quiz); bump QUIZ_ART_V when they are rebuilt.
 */
const QUIZ_ART_V = 2;
const art = (name: string): string => `/ui/quiz/${name}.webp?v=${QUIZ_ART_V}`;
/** The mascot (or the medal) if its picture exists yet; else what stands in for it. */
const extra = (name: string, cls: string, instead = ""): string => (quizArtReady(name) ? `<img class="${cls}" src="${art(name)}" alt="" draggable="false" />` : instead);
/** The UI's own pictures: all there, or none used (a half-drawn kit is worse than the CSS one). */
const UI_ART = ["ui-o", "ui-x", "ui-target", "ui-star", "ui-star-off"] as const;

export interface QuizPanel {
  close(): void;
  /** Dev / E2E: play the round that is up (`right`: correctly) and go on. */
  answer(right: boolean): void;
  readonly done: boolean;
}

export type QuizSound = "good" | "oof" | "click";

const card = (c: QuizCard): string =>
  `<span class="fz-pic"><img src="${art(c.img)}" alt="" draggable="false" /></span><span class="fz-label">${c.label}</span>`;

export function openQuizPanel(rounds: readonly QuizRound[], hooks: {
  /** After every round: how many are played, how many right, and each round's result so far. */
  progress(answered: number, score: number, results: readonly boolean[]): void;
  /** The student closed the finished quiz. */
  close(): void;
  sound?(name: QuizSound): void;
  /** Rounds already played (a page that was refreshed mid-quiz goes on where it was; all played: the result). */
  resume?: readonly boolean[];
  /** Given: the quiz may be left at any time (a teacher's preview, a quiz played alone) — a close button in the corner. */
  dismiss?(): void;
}): QuizPanel {
  const root = document.createElement("div");
  root.className = "fire-panel fire-quiz";
  root.dataset.panel = "quiz";
  if (UI_ART.every((name) => quizArtReady(name))) {
    root.classList.add("fz-art");
    for (const name of UI_ART) root.style.setProperty(`--fz-${name.slice(3)}`, `url("${art(name)}")`);
  }
  root.innerHTML = `
    <div class="fz-card" role="dialog" aria-label="${t("화재 안전 퀴즈", "Fire safety quiz")}">
      <div class="fz-studs" aria-hidden="true">${"<i></i>".repeat(8)}</div>
      <header class="fz-head">
        <b class="fz-title">${t("화재 안전 퀴즈", "Fire safety quiz")}</b>
        <ol class="fz-pips">${rounds.map(() => "<li></li>").join("")}</ol>
        ${hooks.dismiss ? `<button class="fz-close" type="button" data-id="dismiss" aria-label="${t("닫기", "Close")}"></button>` : ""}
      </header>
      <div class="fz-face"><div class="fz-body" data-id="body"></div></div>
    </div>`;
  const body = root.querySelector<HTMLElement>('[data-id="body"]')!;
  const pips = [...root.querySelectorAll<HTMLElement>(".fz-pips li")];
  document.body.appendChild(root);
  root.querySelector<HTMLButtonElement>('[data-id="dismiss"]')?.addEventListener("click", () => hooks.dismiss?.());
  // every picture this quiz shows is fetched now, so no round opens with holes in it
  const wanted = new Set<string>(["think", "cheer", "medal"].filter((name) => quizArtReady(name)));
  for (const r of rounds) for (const img of r.kind === "pick" || r.kind === "order" || r.kind === "sort" ? r.cards.map((c) => c.img) : [r.img]) wanted.add(img);
  const preload = [...wanted].map((name) => { const img = new Image(); img.src = art(name); return img; });
  const results: boolean[] = (hooks.resume ?? []).slice(0, rounds.length);
  results.forEach((ok, i) => { pips[i]!.className = ok ? "right" : "wrong"; });
  let done = false;
  let timer = 0;
  /** The round that is up: has it been judged, and how to judge it from code (dev). */
  let judged = false;
  let showRight: () => void = () => {};

  const score = (): number => results.filter(Boolean).length;

  /** The round is over: mark it, say why, offer the next. */
  const judge = (ok: boolean): void => {
    if (judged) return;
    judged = true;
    clearTimeout(timer);
    showRight();
    const i = results.length, round = rounds[i]!;
    results.push(ok);
    pips[i]!.className = ok ? "right" : "wrong";
    hooks.sound?.(ok ? "good" : "oof");
    hooks.progress(results.length, score(), results);
    const foot = document.createElement("div");
    foot.className = `fz-foot ${ok ? "right" : "wrong"}`;
    foot.innerHTML = `
      ${extra(ok ? "cheer" : "think", "fz-mascot", `<span class="fz-mascot fz-emoji">${ok ? "🎉" : "💡"}</span>`)}
      <p><b>${ok ? t("정답이에요!", "That's right!") : t("아쉬워요! 이렇게 해요", "Not quite! Like this")}</b>${round.why}</p>
      <button class="fz-btn" type="button" data-id="next">${results.length < rounds.length ? t("다음", "Next") : t("결과 보기", "My result")}</button>`;
    body.appendChild(foot);
    foot.querySelector<HTMLButtonElement>('[data-id="next"]')!.addEventListener("click", () => { hooks.sound?.("click"); next(); });
    body.classList.add("judged");
    foot.scrollIntoView({ block: "nearest" });
  };

  const next = (): void => {
    clearTimeout(timer);
    if (results.length < rounds.length) play();
    else finish();
  };

  const play = (): void => {
    const i = results.length, round = rounds[i]!;
    judged = false;
    showRight = () => {};
    body.className = `fz-body fz-k-${round.kind}`;
    body.scrollTop = 0;
    pips.forEach((p, k) => p.classList.toggle("now", k === i));
    const ask = `<div class="fz-ask">${extra("think", "fz-mascot", `<span class="fz-mascot fz-emoji">🧯</span>`)}<p><small>${t(`문제 ${i + 1}`, `Question ${i + 1}`)}</small>${round.ask}</p></div>`;

    if (round.kind === "pick") {
      body.innerHTML = `${ask}<div class="fz-tiles n${round.cards.length}">${round.cards.map((c, k) => `<button class="fz-tile" type="button" data-k="${k}">${card(c)}</button>`).join("")}</div>`;
      const tiles = [...body.querySelectorAll<HTMLButtonElement>(".fz-tile")];
      showRight = () => tiles.forEach((b, k) => { b.disabled = true; if (k === round.answer) b.classList.add("right"); });
      tiles.forEach((b, k) => b.addEventListener("click", () => {
        if (judged) return;
        if (k !== round.answer) b.classList.add("wrong");
        judge(roundRight(round, k));
      }));
    } else if (round.kind === "spot") {
      body.innerHTML = `${ask}<div class="fz-stage"><img src="${art(round.img)}" alt="" draggable="false" />${round.spots.map((s, k) =>
        `<button class="fz-ring${s.x > 0.6 ? " left" : ""}" type="button" data-k="${k}" style="left:${s.x * 100}%;top:${s.y * 100}%"><i></i><span>${s.label}</span></button>`).join("")}</div>`;
      const rings = [...body.querySelectorAll<HTMLButtonElement>(".fz-ring")];
      showRight = () => rings.forEach((b, k) => { b.disabled = true; if (k === round.answer) b.classList.add("right"); });
      rings.forEach((b, k) => b.addEventListener("click", () => {
        if (judged) return;
        if (k !== round.answer) b.classList.add("wrong");
        judge(roundRight(round, k));
      }));
    } else if (round.kind === "dial") {
      body.innerHTML = `${ask}<div class="fz-dialer">
        <img class="fz-phone-art" src="${art(round.img)}" alt="" draggable="false" />
        <div class="fz-device">
          <output data-id="typed"></output>
          <div class="fz-keys">${["1", "2", "3", "4", "5", "6", "7", "8", "9", "back", "0", "call"].map((k) =>
            `<button class="fz-key${k === "call" ? " call" : k === "back" ? " back" : ""}" type="button" data-k="${k}" aria-label="${k}">${k === "call" ? "<i></i>" : k === "back" ? "←" : k}</button>`).join("")}</div>
        </div>
      </div>`;
      const out = body.querySelector<HTMLElement>('[data-id="typed"]')!;
      let typed = "";
      const show = (): void => { out.textContent = typed; out.classList.toggle("empty", typed === ""); };
      show();
      showRight = () => {
        body.querySelectorAll<HTMLButtonElement>(".fz-key").forEach((b) => { b.disabled = true; });
        out.textContent = round.number;
        out.classList.remove("empty");
        out.classList.add("right");
      };
      body.querySelectorAll<HTMLButtonElement>(".fz-key").forEach((b) => b.addEventListener("click", () => {
        if (judged) return;
        const k = b.dataset.k!;
        hooks.sound?.("click");
        if (k === "back") typed = typed.slice(0, -1);
        else if (k === "call") { if (typed.length > 0) { if (typed !== round.number) out.classList.add("wrong"); judge(roundRight(round, typed)); } return; }
        else if (typed.length < 4) typed += k;
        show();
      }));
    } else if (round.kind === "order") {
      body.innerHTML = `${ask}
        <ol class="fz-slots">${round.cards.map((_, k) => `<li data-slot="${k}"><i>${k + 1}</i></li>`).join("")}</ol>
        <div class="fz-tiles n${round.cards.length} fz-tray">${round.cards.map((c, k) => `<button class="fz-tile" type="button" data-k="${k}">${card(c)}</button>`).join("")}</div>`;
      const slots = [...body.querySelectorAll<HTMLElement>(".fz-slots li")];
      const tiles = [...body.querySelectorAll<HTMLButtonElement>(".fz-tile")];
      const picked: number[] = [];
      const draw = (which: readonly number[], marks = false): void => {
        slots.forEach((slot, s) => {
          const k = which[s];
          slot.innerHTML = k === undefined ? `<i>${s + 1}</i>` : `<i>${s + 1}</i><img src="${art(round.cards[k]!.img)}" alt="" draggable="false" /><span>${round.cards[k]!.label}</span>`;
          slot.className = k === undefined ? "" : marks ? (picked[s] === round.order[s] ? "filled right" : "filled fixed") : "filled";
        });
        tiles.forEach((b, k) => { b.disabled = marks || which.includes(k); });
      };
      showRight = () => draw(round.order, true);
      tiles.forEach((b, k) => b.addEventListener("click", () => {
        if (judged || picked.includes(k)) return;
        hooks.sound?.("click");
        picked.push(k);
        draw(picked);
        if (picked.length === round.cards.length) timer = window.setTimeout(() => judge(roundRight(round, picked)), 350);
      }));
      // a slot gives its card back (and the ones after it), until the row is full
      slots.forEach((slot, s) => slot.addEventListener("click", () => {
        if (judged || s >= picked.length || picked.length === round.cards.length) return;
        hooks.sound?.("click");
        picked.length = s;
        draw(picked);
      }));
    } else {
      body.innerHTML = `${ask}
        <div class="fz-sorter">
          <button class="fz-ox fz-x" type="button" data-good="0"><i></i><span>${t("안 돼요", "Don't")}</span></button>
          <div class="fz-deck" data-id="deck"></div>
          <button class="fz-ox fz-o" type="button" data-good="1"><i></i><span>${t("해요", "Do it")}</span></button>
        </div>
        <ol class="fz-sorted" data-id="sorted"></ol>`;
      const deck = body.querySelector<HTMLElement>('[data-id="deck"]')!, sorted = body.querySelector<HTMLElement>('[data-id="sorted"]')!;
      const said: boolean[] = [];
      const deal = (): void => {
        const c = round.cards[said.length];
        deck.innerHTML = c ? `<div class="fz-tile big">${card(c)}</div><ul class="fz-left">${round.cards.map((_, k) => `<li class="${k < said.length ? "done" : k === said.length ? "now" : ""}"></li>`).join("")}</ul>` : "";
      };
      const chip = (k: number, answer: boolean): string => {
        const c = round.cards[k]!;
        return `<li class="${answer === c.good ? "right" : "wrong"}"><img src="${art(c.img)}" alt="" draggable="false" /><b class="${c.good ? "o" : "x"}">${c.good ? "O" : "X"}</b><span>${c.label}</span></li>`;
      };
      showRight = () => {
        body.querySelectorAll<HTMLButtonElement>(".fz-ox").forEach((b) => { b.disabled = true; });
        deck.innerHTML = "";
        deck.classList.add("empty");
        sorted.innerHTML = round.cards.map((c, k) => chip(k, said[k] ?? !c.good)).join("");
      };
      deal();
      body.querySelectorAll<HTMLButtonElement>(".fz-ox").forEach((b) => b.addEventListener("click", () => {
        if (judged || said.length >= round.cards.length) return;
        const answer = b.dataset.good === "1", k = said.length;
        said.push(answer);
        hooks.sound?.(answer === round.cards[k]!.good ? "click" : "oof");
        sorted.insertAdjacentHTML("beforeend", chip(k, answer));
        if (said.length === round.cards.length) { judge(roundRight(round, said)); return; }
        // the card flies to the side it was sent, then the next is dealt
        deck.querySelector(".fz-tile")?.classList.add(answer ? "go-right" : "go-left");
        clearTimeout(timer);
        timer = window.setTimeout(deal, 190);
      }));
    }
  };

  const finish = (): void => {
    done = true;
    pips.forEach((p) => p.classList.remove("now"));
    const n = score(), great = n >= rounds.length - 1;
    const colours = ["#ffd21c", "#3d8bf0", "#5cc455", "#ff5a6e", "#ffffff"];
    body.className = "fz-body fz-result";
    body.scrollTop = 0;
    body.innerHTML = `
      ${great ? `<div class="fz-confetti" aria-hidden="true">${Array.from({ length: 18 }, (_, k) =>
        `<i style="left:${4 + ((k * 53) % 92)}%;background:${colours[k % colours.length]};animation-delay:${((k * 37) % 100) / 100}s;animation-duration:${2.2 + ((k * 29) % 12) / 10}s"></i>`).join("")}</div>` : ""}
      <div class="fz-medal">${extra("medal", "fz-medal-art", `<span class="fz-medal-art fz-emoji">🏅</span>`)}${extra(great ? "cheer" : "think", "fz-mascot")}</div>
      <ol class="fz-stars">${rounds.map((_, k) => `<li class="${k < n ? "on" : ""}" style="animation-delay:${0.25 + k * 0.14}s"></li>`).join("")}</ol>
      <p class="fz-score"><b>${n}</b> / ${rounds.length}</p>
      <p class="fz-cheer">${n === rounds.length ? t("모두 맞혔어요! 불이 나도 침착하게 할 수 있어요", "All right! You would keep calm in a fire")
        : great ? t("아주 잘했어요! 틀린 것만 다시 봐요", "Very good! Look again at the one you missed")
          : t("괜찮아요! 아래를 다시 읽어 봐요", "That is fine! Read these once more")}</p>
      <ol class="fz-review">${rounds.map((r, i) => `<li class="${results[i] ? "right" : "wrong"}"><b class="${results[i] ? "o" : "x"}">${results[i] ? "O" : "X"}</b><span>${r.why}</span></li>`).join("")}</ol>
      <button class="fz-btn" type="button" data-id="close">${t("닫기", "Close")}</button>`;
    body.querySelector<HTMLButtonElement>('[data-id="close"]')!.addEventListener("click", () => hooks.close());
  };

  if (results.length >= rounds.length) finish();
  else play();
  return {
    close: () => { clearTimeout(timer); preload.length = 0; root.remove(); },
    answer: (right) => {
      if (done) return;
      clearTimeout(timer);
      if (!judged) judge(right);
      next();
    },
    get done() { return done; },
  };
}
