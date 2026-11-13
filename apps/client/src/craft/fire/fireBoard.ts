import { classKey, DRILL_QUIZ_QUESTIONS, type ClassClientMessage, type DrillReport } from "@robo/shared";
import { t } from "../../ui/i18n.js";

/**
 * The fire drill's board in a class: the teams, who has been set off, and how far everyone has
 * got — and, for the teacher, the controls: form teams of four or five (or none), set a team or
 * everyone off, stop and go back to the briefing.
 *
 * WHERE it is shown (owner 2026-11-13: "the master controls are under F2 — that is what teachers
 * are told, not Tab"): the teacher's is a section of the F2 class tools (`drillBoardContent`,
 * mounted by the game through `ClassHud.mountToolsSection`); students open the same list, without
 * the controls, with Tab (`openDrillBoard`). One piece of content, two places.
 *
 * The board draws what the server says (`s-k-drill`); a button only sends, and the answer redraws.
 */

export interface DrillClassState {
  size: number;
  teams: [string, number][];
  /** Teams set off (0 = everyone). */
  go: number[];
  run: number;
  reports: DrillReport[];
  /** The quiz being asked right now (its number), if one is. */
  quiz?: number;
}

export interface DrillBoard {
  render(state: DrillClassState): void;
  close(): void;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** What a step index means, as a short status (the last one is "done"). */
function stepLabel(step: number): string {
  return [
    t("경보기 찾는 중", "Finding the alarm"), t("119 신고 중", "Calling 119"), t("소화기 배우는 중", "Learning the extinguisher"),
    t("불 끄는 중", "Fighting the fire"), t("수건 찾는 중", "Getting a towel"), t("대피 중", "Getting out"),
    t("모이는 중", "Gathering"), t("완료", "Done"),
  ][step] ?? "";
}

function progress(report: DrillReport | undefined, off: boolean): { text: string; done: boolean } {
  if (!off) return { text: t("대기", "Waiting"), done: false };
  if (!report) return { text: t("출발", "Off"), done: false };
  if (report.step >= 7) {
    const s = report.seconds ?? 0;
    return { text: `✅ ${"★".repeat(report.stars ?? 1)} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, done: true };
  }
  return { text: `${report.step + 1}/7 ${stepLabel(report.step)}`, done: false };
}

export interface DrillBoardOptions {
  teacher: boolean;
  /** Our own name (our team is marked). */
  me: string;
  /** Students online right now (listed when there are no teams). */
  students(): string[];
  /** The teacher tries the quiz on their own screen (nothing is sent). */
  preview?(): void;
  send(op: Omit<Extract<ClassClientMessage, { t: "k-drill" }>, "t">): void;
}

/** How many teams of about `size` a class of `count` makes, and how big they are ("3 · 3 · 3"): the server's rule, said aloud. */
export function teamSizes(count: number, size: number): number[] {
  if (size <= 0 || count <= 0) return [];
  const teams = Math.ceil(count / size);
  return Array.from({ length: teams }, (_, k) => Math.floor(((k + 1) * count) / teams) - Math.floor((k * count) / teams));
}

/** The board itself — controls (teacher) and teams — as an element to put anywhere. */
export function drillBoardContent(opts: DrillBoardOptions): { root: HTMLElement; render(state: DrillClassState): void } {
  const root = document.createElement("div");
  root.className = "fb";
  root.innerHTML = `<div data-id="controls"></div><div class="fb-teams" data-id="teams"></div>`;
  const controls = root.querySelector<HTMLElement>('[data-id="controls"]')!;
  const teamsEl = root.querySelector<HTMLElement>('[data-id="teams"]')!;
  // one listener: the buttons are redrawn with every state
  controls.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-op]");
    if (!btn || btn.disabled) return;
    if (btn.dataset.op === "preview") { opts.preview?.(); return; }
    const op = btn.dataset.op as "teams" | "start" | "stop" | "quiz" | "quiz-stop";
    opts.send({
      op,
      ...(btn.dataset.size !== undefined ? { size: Number(btn.dataset.size) } : {}),
      ...(btn.dataset.team !== undefined ? { team: Number(btn.dataset.team) } : {}),
    });
  });

  let drawn = "";
  const render = (state: DrillClassState): void => {
    const all = state.go.includes(0);
    const numbers = [...new Set(state.teams.map(([, team]) => team))].sort((a, b) => a - b);
    const off = (team: number) => all || state.go.includes(team);
    const reports = new Map(state.reports.map((r) => [classKey(r.name), r]));
    const mine = state.teams.find(([name]) => classKey(name) === classKey(opts.me))?.[1] ?? 0;

    if (opts.teacher) {
      const size = (n: number, label: string) => `<button class="fb-btn${state.size === n ? " on" : ""}" type="button" data-op="teams" data-size="${n}">${label}</button>`;
      const starts = numbers.length > 0
        ? numbers.map((n) => `<button class="fb-btn go" type="button" data-op="start" data-team="${n}"${off(n) ? " disabled" : ""}>${off(n) ? "✓ " : ""}${t(`${n}조 출발`, `Team ${n} go`)}</button>`).join("")
        : "";
      // what the teams are, in words: a teacher (and a developer) cannot see the rule in the buttons
      const online = opts.students().length, sizes = teamSizes(state.teams.length || online, state.size);
      const how = state.size > 0
        ? t(`이름 가나다순으로 ${state.size}명씩 고르게 나눴어요 → ${numbers.length}개 조 (${sizes.join(" · ")}명). 늦게 온 학생은 인원이 적은 조에 들어가요.`,
            `Split evenly in name order, about ${state.size} to a team → ${numbers.length} teams (${sizes.join(" · ")}). A late student joins the smallest team.`)
        : t("조 없이 반 전체가 한 번에 해요. 4인/5인 1조를 누르면 접속한 학생을 이름순으로 고르게 나눠요.",
            "No teams: the whole class goes at once. Fours / Fives splits the students online evenly, in name order.");
      const everyone = numbers.length > 0 ? t("모든 조 한꺼번에 출발", "All teams go at once") : t("모두 출발", "Everyone go");
      const asking = (state.quiz ?? 0) > 0;
      const answered = state.reports.filter((r) => (r.quiz ?? 0) > 0).length;
      const html = `
        <div class="fb-controls">
          <div class="fb-row"><span>${t("조 편성", "Teams")}</span>${size(0, t("조 없이", "None"))}${size(4, t("4인 1조", "Fours"))}${size(5, t("5인 1조", "Fives"))}</div>
          <p class="fb-note" data-id="teams-how">${how}</p>
          <div class="fb-row"><span>${t("출발", "Start")}</span>${starts}
            <button class="fb-btn go" type="button" data-op="start"${all ? " disabled" : ""}>${all ? "✓ " : "🔥 "}${everyone}</button>
            <button class="fb-btn stop" type="button" data-op="stop">${t("⏹ 멈추고 처음으로", "⏹ Stop, back to start")}</button></div>
          <p class="fb-note">${numbers.length > 0
            ? t("<b>N조 출발</b>은 그 조만, <b>모든 조 한꺼번에 출발</b>은 조와 상관없이 반 전체가 시작해요. 출발 전에는 불이 나지 않고 학생들은 교실에서 기다려요.",
                "<b>Team N go</b> starts that team only; <b>All teams go at once</b> starts the whole class whatever the teams. Before the go there is no fire and students wait in the classroom.")
            : t("출발 전에는 불이 나지 않고, 학생들은 교실에서 기다려요. 설명이 끝나면 <b>모두 출발</b>을 눌러요.",
                "Before the go there is no fire and students wait in the classroom. When you have explained it, press <b>Everyone go</b>.")}</p>
          <div class="fb-row"><span>${t("퀴즈", "Quiz")}</span>
            <button class="fb-btn quiz" type="button" data-op="quiz">📝 ${asking ? t("새 퀴즈 다시 내기", "Ask a new quiz") : t("퀴즈 시작 (5문제)", "Start the quiz (5 questions)")}</button>
            <button class="fb-btn stop" type="button" data-op="quiz-stop"${asking ? "" : " disabled"}>${t("퀴즈 끝내기", "End the quiz")}</button>
            ${opts.preview ? `<button class="fb-btn" type="button" data-op="preview">👀 ${t("미리 보기", "Preview")}</button>` : ""}
            <em class="fb-live" data-id="live"></em></div>
          <p class="fb-note">${t("퀴즈를 시작하면 모든 학생 화면에 같은 문제 5개가 나와요. 훈련 전에도, 끝난 뒤에도 낼 수 있어요. 점수는 아래 이름 옆에 나와요. <b>미리 보기</b>는 선생님 화면에서만 풀어 보는 거예요.",
            "Starting the quiz puts the same five questions on every student's screen — before the drill or after it. Scores appear beside the names below. <b>Preview</b> plays it on your screen only.")}</p>
        </div>`;
      // the buttons are only rebuilt when they CHANGE: progress comes in several times a second in a
      // big class, and a button replaced between a press and its release swallowed the click
      if (html !== drawn) { controls.innerHTML = html; drawn = html; }
      controls.querySelector<HTMLElement>('[data-id="live"]')!.textContent = asking ? t(`푸는 중 · ${answered}명 답함`, `Running · ${answered} answering`) : "";
    } else controls.innerHTML = "";

    const row = (name: string, isOff: boolean) => {
      const report = reports.get(classKey(name)), p = progress(report, isOff);
      const quiz = report?.quiz !== undefined ? ` <em class="fb-quiz${report.quiz >= DRILL_QUIZ_QUESTIONS ? " done" : ""}">📝 ${report.quizScore ?? 0}/${report.quiz}</em>` : "";
      return `<li class="${p.done ? "done" : ""}"><b>${escapeHtml(name)}</b><span>${p.text}${quiz}</span></li>`;
    };
    if (numbers.length > 0) {
      teamsEl.innerHTML = numbers.map((n) => {
        const members = state.teams.filter(([, team]) => team === n).map(([name]) => name);
        return `<section class="fb-team${off(n) ? " off" : ""}${n === mine ? " mine" : ""}" data-team="${n}">
          <h3>${t(`${n}조`, `Team ${n}`)} <small>${off(n) ? t("출발함", "Off") : t("대기", "Waiting")}</small></h3>
          <ul>${members.map((name) => row(name, off(n))).join("")}</ul></section>`;
      }).join("");
    } else {
      const names = opts.students().sort((a, b) => a.localeCompare(b, "ko"));
      teamsEl.innerHTML = names.length > 0
        ? `<section class="fb-team${all ? " off" : ""}" data-team="0"><h3>${t("우리 반", "The class")} <small>${all ? t("출발함", "Off") : t("대기", "Waiting")}</small></h3><ul>${names.map((name) => row(name, all)).join("")}</ul></section>`
        : `<p class="fb-empty">${t("아직 들어온 학생이 없어요", "No students have joined yet")}</p>`;
    }
  };
  return { root, render };
}

/** The board as a card over the game (Tab): what students look at; the teacher's controls are in F2. */
export function openDrillBoard(opts: DrillBoardOptions & { close(): void }): DrillBoard {
  const root = document.createElement("div");
  root.className = "fire-panel fire-board";
  root.dataset.panel = "board";
  root.innerHTML = `
    <div class="fire-card" role="dialog">
      <button class="fire-x" type="button" aria-label="${t("닫기", "Close")}">✕</button>
      <h2>${t("📋 훈련 진행판", "📋 Drill board")}</h2>
    </div>`;
  root.querySelector<HTMLButtonElement>(".fire-x")!.addEventListener("click", () => opts.close());
  const content = drillBoardContent(opts);
  root.querySelector(".fire-card")!.append(content.root);
  document.body.appendChild(root);
  return { render: (state) => content.render(state), close: () => root.remove() };
}
