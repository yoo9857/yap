import { CLASS_ERROR_TEXT, ClassClient, peekClass, type ClassJoin, type ClassSession } from "../net/classClient.js";
import "../craft/classroom.css";
import { t } from "../ui/i18n.js";

export interface ClassEntry {
  client: ClassClient;
  session: ClassSession;
}

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
      ? { role: "teacher", room, teacher: host, password: p.get("pass") ?? undefined }
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
export function chooseClass(parent: HTMLElement): Promise<ClassEntry | null> {
  return new Promise((resolve) => {
    const last = remembered();
    const screen = document.createElement("div");
    screen.className = "screen mode-screen board-screen";
    screen.dataset.board = "pick"; // not data-step: that marks the steps themselves
    // the same notice board as the home menu (index.html .board-screen styles)
    screen.innerHTML = `
      <div class="screen-card board">
        <div class="board-head">
          <img class="brand-logo" src="/craftyap-logo.png" alt="CraftYap" />
          <div class="board-sign">
            <h1 class="game-brand">${t("교육 모드", "Education mode")} <span>${t("함께 만드는 교실", "Build together")}</span></h1>
            <p class="game-intro">${t("선생님은 반을 열고, 학생은 반 이름으로 들어와요.<br />혼자서 끝없는 들판을 꾸밀 수도 있어요.", "Teachers open a class; students join with its name.<br />Or build alone on an endless field.")}</p>
          </div>
        </div>
        <div class="board-cork">
        <div class="mode-step" data-step="pick">
          <h2>${t("어떻게 시작할까요?", "How do you want to start?")}</h2>
          <div class="board-notes board-notes-3">
          <button class="mode-btn board-note" data-go="teacher" type="button">
            <span class="board-photo"><img src="/home/teacher.webp" width="640" height="480" alt="" /></span>
            <span class="mode-text"><b>${t("선생님 · 반 만들기", "Teacher · open a class")}</b><small>${t("반 이름을 정해서 열면 학생들이 들어와요", "Pick a class name and open it; students join with it")}</small></span>
            <span class="board-go">${t("반 열기", "Open")} <span aria-hidden="true">&rarr;</span></span>
          </button>
          <button class="mode-btn board-note" data-go="student" type="button">
            <span class="board-photo"><img src="/home/student.webp" width="640" height="480" alt="" /></span>
            <span class="mode-text"><b>${t("학생 · 반 참여하기", "Student · join a class")}</b><small>${t("반 이름과 내 이름을 입력해요", "Enter the class name and your name")}</small></span>
            <span class="board-go">${t("참여하기", "Join")} <span aria-hidden="true">&rarr;</span></span>
          </button>
          <button class="mode-btn board-note" data-go="solo" type="button">
            <span class="board-photo"><img src="/home/solo.webp" width="640" height="480" alt="" /></span>
            <span class="mode-text"><b>${t("혼자 하기", "Play solo")}</b><small>${t("끝없는 들판에서 혼자 만들고 실험해요", "Build and experiment on an endless field")}</small></span>
            <span class="board-go">${t("시작하기", "Start")} <span aria-hidden="true">&rarr;</span></span>
          </button>
          </div>
        </div>
        <form class="mode-step class-form-step" data-step="teacher" hidden>
          <h2>${t("반 만들기", "Open a class")}</h2>
          <div class="board-paper">
            <div class="class-form">
              <label for="cl-host-room">${t("반 이름", "Class name")}</label>
              <input id="cl-host-room" name="room" maxlength="20" autocomplete="off" required placeholder="${t("예: 햇살반, 3학년 2반", "e.g. Sunshine, Class 3-2")}" />
              <label for="cl-host">${t("선생님 이름", "Teacher name")}</label>
              <input id="cl-host" name="teacher" maxlength="16" autocomplete="off" required placeholder="${t("예: 김선생", "e.g. Ms. Kim")}" />
              <label for="cl-pass">${t("반 비밀번호", "Class password")}</label>
              <input id="cl-pass" name="password" type="password" minlength="4" maxlength="32" autocomplete="off" placeholder="${t("4자 이상 · 다른 컴퓨터에서 반을 다시 열 때 필요해요", "4+ characters · needed to reopen the class on another computer")}" />
            </div>
            <p class="class-note">${t("학생들에게는 <b>반 이름</b>을 알려주세요. 반에서 만든 것은 서버에 저장돼서, 다음 수업에 같은 반 이름으로 열면 이어서 할 수 있어요.", "Give your students the <b>class name</b>. What the class builds is saved on the server, so opening the same class name next lesson picks up where you left off.")}</p>
            <p class="class-error" data-id="error"></p>
            <button class="board-cta" type="submit">${t("반 열기", "Open class")} <span aria-hidden="true">&rarr;</span></button>
          </div>
          <button class="desk-link mode-back" type="button">&larr; ${t("뒤로", "Back")}</button>
        </form>
        <form class="mode-step class-form-step" data-step="student" hidden>
          <h2>${t("반 참여하기", "Join a class")}</h2>
          <div class="board-paper">
            <div class="class-form">
              <label for="cl-room">${t("반 이름", "Class name")}</label>
              <input id="cl-room" name="room" maxlength="20" autocomplete="off" required placeholder="${t("선생님이 알려준 반 이름", "The class name your teacher gave you")}" />
              <label for="cl-student">${t("내 이름", "Your name")}</label>
              <input id="cl-student" name="student" maxlength="16" autocomplete="off" required placeholder="${t("예: 민지", "e.g. Minji")}" />
            </div>
            <p class="class-note">${t("다음을 누르면 어느 선생님 반인지 먼저 보여 줘요.", "Next shows you whose class it is before you join.")}</p>
            <p class="class-error" data-id="error"></p>
            <button class="board-cta" type="submit">${t("다음", "Next")} <span aria-hidden="true">&rarr;</span></button>
          </div>
          <button class="desk-link mode-back" type="button">&larr; ${t("뒤로", "Back")}</button>
        </form>
        <div class="mode-step class-form-step" data-step="confirm" hidden>
          <h2>${t("이 반이 맞나요?", "Is this your class?")}</h2>
          <div class="board-paper">
            <div class="class-confirm" data-id="confirm-card"></div>
            <p class="class-error" data-id="error"></p>
            <button class="board-cta" type="button" data-id="confirm-yes">${t("네, 들어갈래요", "Yes, let me in")} <span aria-hidden="true">&rarr;</span></button>
          </div>
          <button class="desk-link" type="button" data-id="confirm-no">&larr; ${t("아니에요, 다시 입력할게요", "No, let me re-enter")}</button>
        </div>
        </div>
        <p class="game-help board-links"><a class="desk-link" href="/">🏠 ${t("처음으로", "Home")}</a><a class="desk-link" href="/guide/#classroom">📖 ${t("교실 이용 안내", "Classroom guide")}</a></p>
      </div>`;
    parent.appendChild(screen);

    const steps = screen.querySelectorAll<HTMLElement>(".mode-step");
    const show = (step: string) => {
      steps.forEach((s) => (s.hidden = s.dataset.step !== step));
      screen.dataset.board = step;
      screen.querySelector<HTMLElement>(`[data-step="${step}"] input, [data-step="${step}"] [data-id="confirm-yes"]`)?.focus();
    };
    const input = (id: string) => screen.querySelector<HTMLInputElement>(`#${id}`)!;
    input("cl-host-room").value = last.room ?? "";
    input("cl-host").value = last.teacher ?? "";
    input("cl-room").value = last.room ?? "";
    input("cl-student").value = last.student ?? "";

    const done = (entry: ClassEntry | null) => {
      screen.remove();
      resolve(entry);
    };
    screen.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((btn) =>
      btn.addEventListener("click", () => (btn.dataset.go === "solo" ? done(null) : show(btn.dataset.go!))),
    );
    screen.querySelectorAll<HTMLButtonElement>(".mode-back").forEach((btn) => btn.addEventListener("click", () => show("pick")));

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
      const client = new ClassClient(join);
      try {
        const session = await client.connect();
        remember(join);
        done({ client, session });
      } catch (code) {
        error.textContent = CLASS_ERROR_TEXT[code as keyof typeof CLASS_ERROR_TEXT] ?? t("연결하지 못했어요.", "Couldn't connect.");
        button.disabled = false;
      }
    };

    // --- teacher: open the class
    const teacherForm = screen.querySelector<HTMLFormElement>('[data-step="teacher"]')!;
    teacherForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const join: ClassJoin = {
        role: "teacher",
        room: input("cl-host-room").value.trim(),
        teacher: input("cl-host").value.trim(),
        password: input("cl-pass").value || undefined,
      };
      if (!namesOk(join)) {
        teacherForm.querySelector<HTMLElement>('[data-id="error"]')!.textContent = CLASS_ERROR_TEXT["bad-name"];
        return;
      }
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
      void peekClass(join.room)
        .then((info) => {
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
            <div class="class-confirm-me">🧒 ${t(`나는 <b>${escapeHtml(join.student)}</b> (으)로 들어가요`, `Joining as <b>${escapeHtml(join.student)}</b>`)}</div>`;
          confirmStep.querySelector<HTMLElement>('[data-id="error"]')!.textContent = "";
          show("confirm");
        })
        .catch((code: unknown) => {
          button.disabled = false;
          error.textContent = CLASS_ERROR_TEXT[code as keyof typeof CLASS_ERROR_TEXT] ?? t("연결하지 못했어요.", "Couldn't connect.");
        });
    });
    confirmStep.querySelector<HTMLButtonElement>('[data-id="confirm-yes"]')!.addEventListener("click", () => {
      if (pending) void connect(confirmStep, pending);
    });
    confirmStep.querySelector<HTMLButtonElement>('[data-id="confirm-no"]')!.addEventListener("click", () => show("student"));
  });
}
