import { CLASS_ERROR_TEXT, ClassClient, peekClass, takeReloadPassword, type ClassJoin, type ClassSession } from "../net/classClient.js";
import "../craft/classroom.css";
import "../craft/fire/fire.css"; // the theme picker
import { t } from "../ui/i18n.js";
import type { ClassTheme } from "@robo/shared";

export interface ClassEntry {
  client: ClassClient;
  session: ClassSession;
}

/** What the lobby settled: the live class (null: solo play) and the learning theme to play. */
export interface LobbyChoice {
  classroom: ClassEntry | null;
  theme: ClassTheme;
}

/**
 * The LESSONS (learning themes) a teacher or a solo player picks from. A new lesson is ONE entry
 * here (and its id in `ClassTheme`): the lesson select below is a list on the left and one big
 * preview on the right that changes with the pick (a game's map select), so it takes ten lessons
 * as well as two. `kind` is the shelf it stands on (the list can be narrowed to one), `thumb` its
 * small picture in the list, `art` its big one, `points` what is done in it, `colour` its brick.
 */
interface Lesson {
  id: ClassTheme; name: string; note: string; kind: string; colour: "green" | "red" | "blue" | "orange";
  thumb: string; art: string; artAt?: string; points: string[];
}
const THEMES = (): Lesson[] => [
  {
    id: "craft", name: t("🧱 크래프트 모드", "🧱 Craft mode"), note: t("끝없는 들판에서 함께 만들기", "Build together on an endless field"), kind: t("만들기", "Building"), colour: "green",
    thumb: `<img src="/home/solo.webp" width="640" height="480" alt="" />`, art: "/home/class-together.webp", artAt: "center 62%",
    points: [
      t("끝없는 들판에서 블록으로 자유롭게 지어요", "Build freely with blocks on an endless field"),
      t("가구를 놓고, 반려동물을 입양하고, 기계를 조립해요", "Place furniture, adopt a pet, assemble machines"),
      t("풍력 발전기를 세우는 과학 모드가 있어요", "A science mode: raise a wind turbine"),
      t("만든 것은 저장돼서 다음에 이어서 해요", "What is built is saved for next time"),
    ],
  },
  {
    id: "fire", name: t("🔥 화재 체험", "🔥 Fire drill"), note: t("소화기 사용법 · 119 신고 · 대피 훈련", "Extinguisher, calling 119, evacuation"), kind: t("안전", "Safety"), colour: "red",
    thumb: `<img class="lob-art-fire" src="/ui/quiz/pass-aim.webp" width="320" height="320" alt="" />`, art: "/home/lesson-fire.webp",
    points: [
      t("경보기를 누르고 119에 신고해요", "Press the alarm and call 119"),
      t("소화기 사용법 4단계를 배우고 작은 불을 꺼요", "Learn the extinguisher's four steps and put out a small fire"),
      t("젖은 수건으로 입을 막고 몸을 낮춰 대피해요", "Cover your mouth with a wet towel, stay low and get out"),
      t("끝나면 그림 퀴즈로 다시 확인해요", "A picture quiz afterwards goes over it again"),
    ],
  },
];
const themeName = (theme: ClassTheme): string => THEMES().find((x) => x.id === theme)?.name ?? "";

const LAST_KEY = "craftyap-class-last";

interface Remembered {
  room?: string;
  teacher?: string;
  student?: string;
}

function remembered(): Remembered {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as Remembered;
  } catch {
    return {};
  }
}

function remember(join: ClassJoin): void {
  try {
    const last = remembered();
    localStorage.setItem(
      LAST_KEY,
      JSON.stringify({
        room: join.room,
        teacher: join.role === "teacher" ? join.teacher : last.teacher,
        student: join.role === "student" ? join.student : last.student,
      } satisfies Remembered),
    );
  } catch {
    /* fine */
  }
}

/**
 * Connect straight away (deep links / E2E). Teacher:
 * `?mode=field&room=햇살반&host=김선생&pass=1234`; student:
 * `?mode=field&room=햇살반&student=민지`. Links from before named classes —
 * `&host=김선생` / `&teacher=김선생&student=민지` without `room` — still work:
 * such a class's name is its teacher's name. Null when no class is asked for.
 */
export async function classFromUrl(): Promise<ClassEntry | null> {
  const p = new URLSearchParams(location.search);
  const host = p.get("host");
  const student = p.get("student");
  const room = p.get("room") ?? host ?? p.get("teacher");
  const join: ClassJoin | null =
    host && room
      ? { role: "teacher", room, teacher: host, password: p.get("pass") ?? takeReloadPassword(), theme: p.get("theme") === "fire" ? "fire" : undefined }
      : room && student
        ? { role: "student", room, student }
        : null;
  if (!join) return null;
  const client = new ClassClient(join);
  try {
    return { client, session: await client.connect() };
  } catch (code) {
    alert(CLASS_ERROR_TEXT[code as keyof typeof CLASS_ERROR_TEXT] ?? String(code));
    return null;
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Education mode's front door. A teacher opens a class under a CLASS NAME and
 * their own name; a student types the class name and their own name, is shown
 * whose class that is, and confirms before walking in — so a typo in the class
 * name lands nowhere instead of in a stranger's lesson. Or play alone.
 * Resolves with the live class, or null for solo play.
 */
const ARROW = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6" /></svg>`;
const CHEVRON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>`;
const STUDS = `<span class="lob-studs" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`;

/**
 * The head of a lobby panel: the step's title. The step's own way back is kept as a hidden button
 * (`backClass` / `backAttrs` are what the code listens on); the ONE back button on screen is the
 * bar's, top left on every step, which presses it (see `nav` in chooseClass).
 */
function panelHead(title: string, backClass: string, backAttrs = ""): string {
  return `<div class="lob-head">
            <button class="lob-step-back ${backClass}" type="button" tabindex="-1" hidden ${backAttrs}></button>
            <h2>${title}</h2>
          </div>`;
}

/** The left column of a lobby panel: the role's picture and what happens, in three numbered steps. */
function guide(photo: "teacher" | "student", steps: string[]): string {
  return `<aside class="lob-guide">
              <img src="/home/${photo}.webp" width="640" height="480" alt="" />
              <ol>${steps.map((s) => `<li><span>${s}</span></li>`).join("")}</ol>
            </aside>`;
}

/** One brick to pick on the lobby's choice steps: a picture, a name, a line, where it goes. */
function card(attrs: string, colour: string, art: string, name: string, note: string, go: string): string {
  return `<button class="mode-btn lob-card ${colour}" ${attrs} type="button">${STUDS}
            <span class="lob-art">${art}</span>
            <span class="lob-face"><b>${name}</b><small>${note}</small><span class="lob-go">${go} ${ARROW}</span></span>
          </button>`;
}
const photo = (name: string) => `<img src="/home/${name}.webp" width="640" height="480" alt="" />`;

export function chooseClass(parent: HTMLElement, start: "pick" | "teacher" = "pick"): Promise<LobbyChoice> {
  return new Promise((resolve) => {
    const last = remembered();
    const screen = document.createElement("div");
    // the education lobby in the web home's look (index.html, ".lobby"): the green world of the
    // mode choice behind, bricks to pick and one studded panel per form
    screen.className = "screen mode-screen lobby";
    screen.dataset.board = "pick"; // not data-step: that marks the steps themselves
    screen.innerHTML = `
      <div class="lob-bar">
        <button class="lob-back" type="button" data-id="nav-back">${CHEVRON}<span data-id="nav-label"></span></button>
        <div class="lob-where">
          <span class="lob-mode"><img src="/ui/hub/icon-grad.webp" width="160" height="160" alt="" />${t("교육 모드", "Education mode")}</span>
          <ol class="lob-steps" data-id="steps" aria-label="${t("진행 단계", "Steps")}"></ol>
        </div>
        <a class="lob-help" href="/guide/#classroom">${t("교실 이용 안내", "Classroom guide")}</a>
      </div>
      <div class="lob-stage">
        <div class="mode-step lob-step" data-step="pick">
          <div class="lob-title"><h2>${t("어떻게 시작할까요?", "How do you want to start?")}</h2><p>${t("선생님은 반을 열고, 학생은 반 이름으로 들어와요. 혼자서 끝없는 들판을 꾸밀 수도 있어요.", "Teachers open a class; students join with its name. Or build alone on an endless field.")}</p></div>
          <div class="lob-cards">
            ${card('data-go="teacher"', "green", photo("teacher"), t("선생님 · 반 만들기", "Teacher · open a class"), t("반 이름을 정해서 열면 학생들이 들어와요", "Pick a class name and open it; students join with it"), t("반 열기", "Open"))}
            ${card('data-go="student"', "blue", photo("student"), t("학생 · 반 참여하기", "Student · join a class"), t("반 이름과 내 이름을 입력해요", "Enter the class name and your name"), t("참여하기", "Join"))}
            ${card('data-go="solo"', "orange", photo("solo"), t("혼자 하기", "Play solo"), t("끝없는 들판에서 혼자 만들고 실험해요", "Build and experiment on an endless field"), t("시작하기", "Start"))}
          </div>
        </div>
        <div class="mode-step lob-step lob-panel map" data-step="lesson" hidden>${STUDS}
          <div class="lob-head">
            <button class="lob-step-back mode-back" type="button" tabindex="-1" hidden></button>
            <h2 data-id="lesson-title"></h2>
            <span class="lesson-count">${t(`수업 ${THEMES().length}개`, `${THEMES().length} lessons`)}</span>
          </div>
          <div class="lob-body">
            <div class="lesson-side">
              <div class="lesson-kinds" data-id="lesson-kinds">
                <button type="button" class="on" data-kind="">${t("전체", "All")}</button>
                ${[...new Set(THEMES().map((th) => th.kind))].map((kind) => `<button type="button" data-kind="${kind}">${kind}</button>`).join("")}
              </div>
              <input class="lesson-find" data-id="lesson-find" type="search" autocomplete="off" placeholder="${t("수업 찾기", "Find a lesson")}" aria-label="${t("수업 찾기", "Find a lesson")}"${THEMES().length > 6 ? "" : " hidden"} />
              <div class="theme-pick lesson-list" role="radiogroup" aria-label="${t("수업 목록", "Lessons")}">
                ${THEMES().map((th, i) => `<label class="lesson-row ${th.colour}" data-solo="${th.id}" data-kind="${th.kind}"><input type="radio" name="theme" value="${th.id}"${i === 0 ? " checked" : ""} /><span class="lesson-thumb">${th.thumb}</span><span class="lesson-text"><b>${th.name}</b><small><i>${th.kind}</i>${th.note}</small></span></label>`).join("")}
                <p class="lesson-none" data-id="lesson-none" hidden>${t("찾는 수업이 없어요. 다른 말로 찾아 보세요.", "No lesson matches. Try other words.")}</p>
                <div class="lesson-row soon" aria-hidden="true"><span class="lesson-thumb"><em>+</em></span><span class="lesson-text"><b>${t("새 수업 준비 중", "More lessons soon")}</b><small>${t("곧 더 많은 수업이 열려요", "New lessons are on the way")}</small></span></div>
              </div>
            </div>
            <div class="lesson-stage">
              <div class="lesson-view" data-id="lesson-view" aria-live="polite"></div>
              <button class="lob-cta" type="button" data-id="lesson-go"><span data-id="lesson-go-label"></span> ${ARROW}</button>
            </div>
          </div>
        </div>
        <form class="mode-step lob-step lob-panel make" data-step="teacher" hidden>${STUDS}
          ${panelHead(t("반 정보 쓰기", "Class details"), "mode-back")}
          <div class="lob-body">
            <aside class="lesson-chosen" data-id="lesson-chosen"></aside>
            <div class="lob-form">
              <div class="lob-pair">
                <div><label for="cl-host-room">${t("반 이름", "Class name")}</label>
                <input id="cl-host-room" name="room" maxlength="20" autocomplete="off" required placeholder="${t("예: 햇살반, 3학년 2반", "e.g. Sunshine, Class 3-2")}" /></div>
                <div><label for="cl-host">${t("선생님 이름", "Teacher name")}</label>
                <input id="cl-host" name="teacher" maxlength="16" autocomplete="off" required placeholder="${t("예: 김선생", "e.g. Ms. Kim")}" /></div>
              </div>
              <label for="cl-pass">${t("반 비밀번호", "Class password")}</label>
              <input id="cl-pass" name="password" type="password" minlength="4" maxlength="32" autocomplete="off" aria-describedby="cl-pass-hint" placeholder="${t("4자 이상", "4+ characters")}" />
              <small class="lob-hint" id="cl-pass-hint">${t("다른 컴퓨터에서 이 반을 다시 열 때 필요해요", "Needed to reopen this class on another computer")}</small>
              <label for="cl-teams" data-theme-note="fire" hidden>${t("조 편성 (수업 중 F2에서 바꿀 수 있어요)", "Teams (change any time under F2)")}</label>
              <select id="cl-teams" data-theme-note="fire" hidden>
                <option value="0">${t("조 없이: 반 전체가 한 번에", "None: the whole class at once")}</option>
                <option value="4">${t("4인 1조", "Teams of four")}</option>
                <option value="5">${t("5인 1조", "Teams of five")}</option>
              </select>
              <p class="lesson-tip">
                <span data-theme-note="craft">${t("학생들에게 <b>반 이름</b>을 알려 주세요. 만든 것은 서버에 저장되고, 다음 수업에 같은 반 이름으로 열면 이어서 해요.", "Tell your students the <b>class name</b>. What the class builds is saved; open the same class name next lesson to carry on.")}</span>
                <span data-theme-note="fire" hidden>${t("학생들에게 <b>반 이름</b>을 알려 주세요. 수업은 <b>설명 시간</b>으로 시작하고, 설명이 끝나면 <b>F2</b>(수업 도구)에서 <b>🔥 모두 출발</b>을 눌러요.", "Tell your students the <b>class name</b>. The lesson starts with a <b>briefing</b>; when you have explained it, press <b>F2</b> (class tools) and <b>🔥 Everyone go</b>.")}</span>
              </p>
              <p class="class-error" data-id="error"></p>
              <button class="lob-cta" type="submit">${t("반 열기", "Open class")} ${ARROW}</button>
            </div>
          </div>
        </form>
        <form class="mode-step lob-step lob-panel wide" data-step="student" hidden>${STUDS}
          ${panelHead(t("반 참여하기", "Join a class"), "mode-back")}
          <div class="lob-body">
            ${guide("student", [
              t("선생님이 알려준 <b>반 이름</b>을 써요", "Type the <b>class name</b> your teacher gave you"),
              t("<b>내 이름</b>을 써요", "Type <b>your name</b>"),
              t("어느 선생님 반인지 확인하고 들어가요", "Check whose class it is, then join"),
            ])}
            <div class="lob-form">
              <label for="cl-room">${t("반 이름", "Class name")}</label>
              <input id="cl-room" name="room" maxlength="20" autocomplete="off" required placeholder="${t("선생님이 알려준 반 이름", "The class name your teacher gave you")}" />
              <label for="cl-student">${t("내 이름", "Your name")}</label>
              <input id="cl-student" name="student" maxlength="16" autocomplete="off" required placeholder="${t("예: 민지", "e.g. Minji")}" />
              <p class="class-error" data-id="error"></p>
              <button class="lob-cta blue" type="submit">${t("다음", "Next")} ${ARROW}</button>
            </div>
          </div>
        </form>
        <div class="mode-step lob-step lob-panel wide" data-step="confirm" hidden>${STUDS}
          ${panelHead(t("이 반이 맞나요?", "Is this your class?"), "", 'data-id="confirm-no"')}
          <div class="lob-body">
            ${guide("student", [
              t("<b>반 이름</b>과 <b>선생님 이름</b>이 맞는지 봐요", "Check the <b>class</b> and the <b>teacher</b>"),
              t("맞으면 <b>네, 들어갈래요</b>를 눌러요", "If they match, press <b>Yes, let me in</b>"),
              t("아니면 <b>뒤로</b>를 눌러 다시 써요", "If not, press <b>Back</b> and type it again"),
            ])}
            <div class="lob-form">
              <div class="class-confirm" data-id="confirm-card"></div>
              <p class="class-error" data-id="error"></p>
              <button class="lob-cta" type="button" data-id="confirm-yes">${t("네, 들어갈래요", "Yes, let me in")} ${ARROW}</button>
            </div>
          </div>
        </div>
      </div>`;
    parent.appendChild(screen);

    const steps = screen.querySelectorAll<HTMLElement>(".mode-step");
    const navLabel = screen.querySelector<HTMLElement>('[data-id="nav-label"]')!;
    /** Who is starting (set by the first step's pick): the steps line and the lesson select speak for them. */
    let who: "teacher" | "student" | "solo" | null = null;
    const PATHS = {
      teacher: [["pick", t("시작 방법", "How")], ["lesson", t("수업 고르기", "Lesson")], ["teacher", t("반 정보", "Details")], ["", t("입장", "Enter")]],
      solo: [["pick", t("시작 방법", "How")], ["lesson", t("수업 고르기", "Lesson")], ["", t("입장", "Enter")]],
      student: [["pick", t("시작 방법", "How")], ["student", t("정보 입력", "Details")], ["confirm", t("확인", "Confirm")], ["", t("입장", "Enter")]],
    } as const;
    const stepsLine = screen.querySelector<HTMLElement>('[data-id="steps"]')!;
    const show = (step: string) => {
      steps.forEach((s) => (s.hidden = s.dataset.step !== step));
      screen.dataset.board = step;
      navLabel.textContent = step === "pick" ? t("모드 선택", "Modes") : t("뒤로", "Back");
      const path = PATHS[who ?? "teacher"];
      const at = Math.max(0, path.findIndex(([name]) => name === step));
      stepsLine.innerHTML = path.map(([, label], i) => `<li class="${i < at ? "done" : i === at ? "on" : ""}">${label}</li>`).join("");
      if (step === "teacher") showChosen();
      screen.querySelector<HTMLElement>(`[data-step="${step}"] input, [data-step="${step}"] [data-id="confirm-yes"]`)?.focus();
    };
    const input = (id: string) => screen.querySelector<HTMLInputElement>(`#${id}`)!;
    input("cl-host-room").value = last.room ?? "";
    input("cl-host").value = last.teacher ?? "";
    input("cl-room").value = last.room ?? "";
    input("cl-student").value = last.student ?? "";

    /** The connect in progress. Leaving its step drops it: left running, it would join in the
     *  background and fight the next attempt for the same seat. */
    let connecting: ClassClient | null = null;
    const cancelConnect = () => {
      const client = connecting;
      connecting = null;
      client?.close();
    };
    // the one way back, in the same place on every step: out to the mode choice from the first step,
    // otherwise whatever this step's own back does (Esc is the same press)
    const back = () => {
      const step = screen.dataset.board ?? "pick";
      if (step === "pick") { location.href = "/?pick=1"; return; } // (a page load: the menu was removed when this lobby opened)
      screen.querySelector<HTMLButtonElement>(`[data-step="${step}"] :is(.mode-back, [data-id="confirm-no"])`)?.click();
    };
    screen.querySelector<HTMLButtonElement>('[data-id="nav-back"]')!.addEventListener("click", back);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && screen.dataset.board !== "pick") { e.preventDefault(); back(); } };
    document.addEventListener("keydown", onKey);
    show("pick");
    const done = (entry: ClassEntry | null, soloTheme: ClassTheme = "craft") => {
      if (!entry) cancelConnect();
      document.removeEventListener("keydown", onKey);
      screen.remove();
      resolve({ classroom: entry, theme: entry ? entry.session.theme : soloTheme });
    };
    // ---- the lesson select: a list on the left, the picked lesson large on the right ----
    const lessons = THEMES();
    const radios = () => [...screen.querySelectorAll<HTMLInputElement>('.theme-pick input[name="theme"]')];
    const picked = (): Lesson => lessons.find((l) => l.id === radios().find((r) => r.checked)?.value) ?? lessons[0]!;
    /** The lessons the list shows now (the kind filter may hide some), in order. */
    const listed = (): Lesson[] => lessons.filter((l) => !screen.querySelector<HTMLElement>(`.lesson-row[data-solo="${l.id}"]`)?.hidden);
    const view = screen.querySelector<HTMLElement>('[data-id="lesson-view"]')!;
    const showLesson = (): void => {
      const lesson = picked(), all = listed(), at = all.indexOf(lesson);
      screen.querySelectorAll<HTMLElement>(".lesson-row[data-solo]").forEach((row) => row.classList.toggle("picked", row.dataset.solo === lesson.id));
      view.className = `lesson-view ${lesson.colour}`;
      view.innerHTML = `
        <div class="lesson-hero">
          <img src="${lesson.art}" alt="" ${lesson.artAt ? `style="object-position: ${lesson.artAt}"` : ""} />
          <span class="lesson-kind">${lesson.kind}</span>
          ${all.length > 1 ? `<span class="lesson-at">${at + 1} / ${all.length}</span>
          <button type="button" class="lesson-arrow prev" data-turn="-1" aria-label="${t("이전 수업", "Previous lesson")}">${CHEVRON}</button>
          <button type="button" class="lesson-arrow next" data-turn="1" aria-label="${t("다음 수업", "Next lesson")}">${CHEVRON}</button>` : ""}
          <b class="lesson-name">${lesson.name}</b>
        </div>
        <p class="lesson-note">${lesson.note}</p>
        <ul class="lesson-points">${lesson.points.map((point) => `<li>${point}</li>`).join("")}</ul>`;
      themeNotes();
    };
    const pickLesson = (id: ClassTheme): void => {
      const radio = radios().find((r) => r.value === id);
      if (!radio || radio.checked) return;
      radio.checked = true;
      radio.closest<HTMLElement>(".lesson-row")?.scrollIntoView({ block: "nearest" });
      showLesson();
    };
    radios().forEach((radio) => radio.addEventListener("change", showLesson));
    view.addEventListener("click", (e) => {
      const turn = Number((e.target as HTMLElement).closest<HTMLElement>("[data-turn]")?.dataset.turn ?? 0);
      const all = listed();
      if (turn && all.length) pickLesson(all[(all.indexOf(picked()) + turn + all.length) % all.length]!.id);
    });
    // narrow the list: to one kind (전체 shows all) and to what the search box says; a lesson the
    // list no longer shows gives up the pick to the first one it does
    const find = screen.querySelector<HTMLInputElement>('[data-id="lesson-find"]')!;
    let kind = "";
    const narrow = (): void => {
      const words = find.value.trim().toLowerCase();
      for (const lesson of lessons) {
        const row = screen.querySelector<HTMLElement>(`.lesson-row[data-solo="${lesson.id}"]`);
        const text = `${lesson.name} ${lesson.note} ${lesson.kind} ${lesson.points.join(" ")}`.toLowerCase();
        if (row) row.hidden = (!!kind && lesson.kind !== kind) || (!!words && !text.includes(words));
      }
      const all = listed();
      screen.querySelector<HTMLElement>('[data-id="lesson-none"]')!.hidden = all.length > 0;
      screen.querySelector<HTMLButtonElement>('[data-id="lesson-go"]')!.disabled = all.length === 0;
      if (all.length && !all.includes(picked())) pickLesson(all[0]!.id);
      else showLesson();
    };
    screen.querySelectorAll<HTMLButtonElement>('[data-id="lesson-kinds"] button').forEach((chip) => chip.addEventListener("click", () => {
      screen.querySelectorAll<HTMLElement>('[data-id="lesson-kinds"] button').forEach((b) => b.classList.toggle("on", b === chip));
      kind = chip.dataset.kind ?? "";
      narrow();
    }));
    find.addEventListener("input", narrow);
    // a lesson is taken with Enter or a double click as well as with the button
    const list = screen.querySelector<HTMLElement>(".lesson-list")!;
    const take = () => screen.querySelector<HTMLButtonElement>('[data-id="lesson-go"]')!.click();
    list.addEventListener("dblclick", (e) => { if ((e.target as HTMLElement).closest(".lesson-row[data-solo]")) take(); });
    list.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); take(); } });
    find.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); take(); } });
    const openLesson = (forWhom: "teacher" | "solo"): void => {
      who = forWhom;
      screen.querySelector<HTMLElement>('[data-id="lesson-title"]')!.textContent = forWhom === "teacher" ? t("오늘의 수업 고르기", "Pick today's lesson") : t("무엇을 할까요?", "What would you like to do?");
      screen.querySelector<HTMLElement>('[data-id="lesson-go-label"]')!.textContent = forWhom === "teacher" ? t("이 수업으로 반 만들기", "Open a class with this lesson") : t("이 수업 시작하기", "Start this lesson");
      show("lesson");
    };
    screen.querySelector<HTMLButtonElement>('[data-id="lesson-go"]')!.addEventListener("click", () => {
      if (who === "solo") done(null, picked().id);
      else show("teacher");
    });
    /** The class-details step says which lesson the class is being opened for (수업 바꾸기 goes back to the select). */
    const showChosen = (): void => {
      const lesson = picked();
      const slot = screen.querySelector<HTMLElement>('[data-id="lesson-chosen"]')!;
      slot.className = `lesson-chosen ${lesson.colour}`;
      slot.innerHTML = `
        <span class="lesson-chosen-art"><img src="${lesson.art}" alt="" ${lesson.artAt ? `style="object-position: ${lesson.artAt}"` : ""} /><i>${lesson.kind}</i></span>
        <small>${t("오늘의 수업", "Today's lesson")}</small><b>${lesson.name}</b><p>${lesson.note}</p>
        <button type="button" class="lesson-change" data-id="lesson-change">${t("수업 바꾸기", "Change lesson")}</button>`;
      slot.querySelector<HTMLButtonElement>('[data-id="lesson-change"]')!.addEventListener("click", () => show("lesson"));
    };
    screen.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const go = btn.dataset.go!;
        if (go === "teacher" || go === "solo") openLesson(go);
        else { who = "student"; show(go); }
      }),
    );
    /** Bumped whenever a class lookup's answer would no longer be wanted. */
    let peekSeq = 0;
    screen.querySelectorAll<HTMLButtonElement>(".mode-back").forEach((btn) => btn.addEventListener("click", () => {
      cancelConnect();
      peekSeq++;
      // a cancelled connect or lookup never answers its step: hand the steps
      // back ready to use, or 반 열기 stays disabled after 뒤로 until a reload
      screen.querySelectorAll<HTMLButtonElement>('button[type="submit"], [data-id="confirm-yes"]').forEach((b) => { b.disabled = false; });
      screen.querySelectorAll<HTMLElement>('[data-id="error"]').forEach((el) => { el.textContent = ""; });
      show(screen.dataset.board === "teacher" ? "lesson" : "pick"); // the class's details go back to its lesson
    }));

    const namesOk = (join: ClassJoin): boolean => {
      const room = join.room.length >= 1 && join.room.length <= 20;
      const person = join.role === "teacher" ? join.teacher : join.student;
      return room && person.length >= 1 && person.length <= 16;
    };

    const connect = async (step: HTMLElement, join: ClassJoin) => {
      const error = step.querySelector<HTMLElement>('[data-id="error"]')!;
      const button = step.querySelector<HTMLButtonElement>('button[type="submit"], [data-id="confirm-yes"]')!;
      error.textContent = t("연결하는 중…", "Connecting…");
      button.disabled = true;
      cancelConnect();
      const client = new ClassClient(join);
      connecting = client;
      try {
        const session = await client.connect();
        if (connecting !== client) { client.close(); return; } // cancelled while it loaded
        connecting = null;
        remember(join);
        done({ client, session });
      } catch (code) {
        if (connecting !== client) return; // cancelled: its step is no longer on screen
        connecting = null;
        error.textContent = CLASS_ERROR_TEXT[code as keyof typeof CLASS_ERROR_TEXT] ?? t("연결하지 못했어요.", "Couldn't connect.");
        button.disabled = false;
        // "taken by another teacher": say WHOSE class it is (the same name a student's confirm card
        // shows), so a teacher who once saved it under another name knows how to open it again
        if (code === "room-taken" && join.role === "teacher") {
          void peekClass(join.room).then((info) => {
            if (connecting || !info.exists || !info.teacher || !step.isConnected) return;
            error.textContent = t(
              `'${info.room}' 반은 '${info.teacher}' 선생님 이름으로 이미 저장돼 있어요. 그 반을 다시 열려면 선생님 이름을 '${info.teacher}'(으)로 쓰고 처음 정한 비밀번호를 넣어 주세요. 새 반이라면 다른 반 이름을 정해 주세요.`,
              `'${info.room}' is already saved under the teacher name '${info.teacher}'. To reopen it, enter '${info.teacher}' as the teacher name with its password. For a new class, pick another class name.`,
            );
          }, () => {});
        }
      }
    };

    // --- teacher: open the class
    const teacherForm = screen.querySelector<HTMLFormElement>('[data-step="teacher"]')!;
    // the guide beside the form speaks for the lesson that is picked
    function themeNotes(): void {
      const id = picked().id;
      teacherForm.querySelectorAll<HTMLElement>("[data-theme-note]").forEach((el) => { el.hidden = el.dataset.themeNote !== id; });
    }
    showLesson();
    if (start === "teacher") openLesson("teacher"); // 선생님 로그인 on the home: straight at the lesson select
    teacherForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const join: ClassJoin = {
        role: "teacher",
        room: input("cl-host-room").value.trim(),
        teacher: input("cl-host").value.trim(),
        password: input("cl-pass").value || undefined,
        theme: picked().id,
      };
      if (!namesOk(join)) {
        teacherForm.querySelector<HTMLElement>('[data-id="error"]')!.textContent = CLASS_ERROR_TEXT["bad-name"];
        return;
      }
      // the fire drill's teams, asked for here, are sent by the drill once the class is open (fireDrill.presetTeams)
      try {
        const size = Number(teacherForm.querySelector<HTMLSelectElement>("#cl-teams")?.value ?? 0);
        if (join.theme === "fire" && size > 0) sessionStorage.setItem("craftyap-fire-teams", JSON.stringify({ size, at: Date.now() }));
        else sessionStorage.removeItem("craftyap-fire-teams");
      } catch { /* no storage: teams are made under F2 */ }
      void connect(teacherForm, join);
    });

    // --- student: class name + own name → whose class is it? → confirm
    const studentForm = screen.querySelector<HTMLFormElement>('[data-step="student"]')!;
    const confirmStep = screen.querySelector<HTMLElement>('[data-step="confirm"]')!;
    let pending: ClassJoin | null = null;
    studentForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const error = studentForm.querySelector<HTMLElement>('[data-id="error"]')!;
      const button = studentForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      const join: ClassJoin = { role: "student", room: input("cl-room").value.trim(), student: input("cl-student").value.trim() };
      if (!namesOk(join)) {
        error.textContent = CLASS_ERROR_TEXT["bad-name"];
        return;
      }
      error.textContent = t("반을 찾는 중…", "Looking for the class…");
      button.disabled = true;
      const seq = ++peekSeq;
      void peekClass(join.room)
        .then((info) => {
          if (seq !== peekSeq) return; // left the step while it looked: never jump to the card
          button.disabled = false;
          if (!info.exists) {
            error.textContent = t(`'${join.room}' 반을 찾을 수 없어요. 반 이름을 다시 확인해주세요.`, `There is no class called '${join.room}'. Please check the class name.`);
            return;
          }
          if (!info.open) {
            error.textContent = t(`${info.teacher ?? ""} 선생님의 '${info.room}' 반이 아직 열리지 않았어요. 선생님이 반을 열면 들어갈 수 있어요.`, `${info.teacher ?? ""}'s class '${info.room}' isn't open yet. You can join once the teacher opens it.`);
            return;
          }
          error.textContent = "";
          pending = { ...join, room: info.room };
          confirmStep.querySelector<HTMLElement>('[data-id="confirm-card"]')!.innerHTML = `
            <div class="class-confirm-room">🏫 ${escapeHtml(info.room)}</div>
            <div class="class-confirm-teacher">👩‍🏫 ${t(`<b>${escapeHtml(info.teacher ?? "")}</b> 선생님 반`, `<b>${escapeHtml(info.teacher ?? "")}</b>'s class`)}</div>
            <div class="class-confirm-me">🧒 ${t(`나는 <b>${escapeHtml(join.student)}</b> (으)로 들어가요`, `Joining as <b>${escapeHtml(join.student)}</b>`)}</div>
            ${info.theme && info.theme !== "craft" ? `<div class="class-confirm-theme">${t("오늘의 수업", "Today's lesson")}: ${themeName(info.theme)}</div>` : ""}`;
          confirmStep.querySelector<HTMLElement>('[data-id="error"]')!.textContent = "";
          show("confirm");
        })
        .catch((code: unknown) => {
          if (seq !== peekSeq) return;
          button.disabled = false;
          error.textContent = CLASS_ERROR_TEXT[code as keyof typeof CLASS_ERROR_TEXT] ?? t("연결하지 못했어요.", "Couldn't connect.");
        });
    });
    confirmStep.querySelector<HTMLButtonElement>('[data-id="confirm-yes"]')!.addEventListener("click", () => {
      if (pending) void connect(confirmStep, pending);
    });
    confirmStep.querySelector<HTMLButtonElement>('[data-id="confirm-no"]')!.addEventListener("click", () => {
      cancelConnect();
      confirmStep.querySelector<HTMLButtonElement>('[data-id="confirm-yes"]')!.disabled = false;
      show("student");
    });
  });
}
