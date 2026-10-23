import { CLASS_ERROR_TEXT, ClassClient, peekClass, type ClassJoin, type ClassSession } from "../net/classClient.js";
import "../craft/classroom.css";

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
    screen.className = "screen mode-screen";
    screen.innerHTML = `
      <div class="screen-card">
        <img class="brand-logo" src="/craftyap-logo.png" alt="CraftYap" />
        <div class="mode-step" data-step="pick">
          <h1>교육 모드</h1>
          <button class="mode-btn" data-go="teacher">
            <span class="mode-emoji">👩‍🏫</span>
            <span class="mode-text"><b>선생님 · 반 만들기</b><small>반 이름을 정해서 열면 학생들이 들어와요</small></span>
          </button>
          <button class="mode-btn" data-go="student">
            <span class="mode-emoji">🧒</span>
            <span class="mode-text"><b>학생 · 반 참여하기</b><small>반 이름과 내 이름을 입력해요</small></span>
          </button>
          <button class="mode-btn" data-go="solo">
            <span class="mode-emoji">🌱</span>
            <span class="mode-text"><b>혼자 하기</b><small>끝없는 들판에서 혼자 만들고 실험해요</small></span>
          </button>
          <a class="desk-link" href="/">&larr; 처음으로</a>
        </div>
        <form class="mode-step class-form-step" data-step="teacher" hidden>
          <h1>반 만들기</h1>
          <div class="class-form">
            <label for="cl-host-room">반 이름</label>
            <input id="cl-host-room" name="room" maxlength="20" autocomplete="off" required placeholder="예: 햇살반, 3학년 2반" />
            <label for="cl-host">선생님 이름</label>
            <input id="cl-host" name="teacher" maxlength="16" autocomplete="off" required placeholder="예: 김선생" />
            <label for="cl-pass">반 비밀번호</label>
            <input id="cl-pass" name="password" type="password" minlength="4" maxlength="32" autocomplete="off" placeholder="4자 이상 · 다른 컴퓨터에서 반을 다시 열 때 필요해요" />
          </div>
          <p class="class-note">학생들에게는 <b>반 이름</b>을 알려주세요. 반에서 만든 것은 서버에 저장돼서, 다음 수업에 같은 반 이름으로 열면 이어서 할 수 있어요.</p>
          <p class="class-error" data-id="error"></p>
          <button class="mode-btn" type="submit"><span class="mode-text"><b>반 열기</b><small>학생들은 반 이름으로 들어와요</small></span></button>
          <button class="desk-link mode-back" type="button">&larr; 뒤로</button>
        </form>
        <form class="mode-step class-form-step" data-step="student" hidden>
          <h1>반 참여하기</h1>
          <div class="class-form">
            <label for="cl-room">반 이름</label>
            <input id="cl-room" name="room" maxlength="20" autocomplete="off" required placeholder="선생님이 알려준 반 이름" />
            <label for="cl-student">내 이름</label>
            <input id="cl-student" name="student" maxlength="16" autocomplete="off" required placeholder="예: 민지" />
          </div>
          <p class="class-error" data-id="error"></p>
          <button class="mode-btn" type="submit"><span class="mode-text"><b>다음</b><small>어느 선생님 반인지 확인해요</small></span></button>
          <button class="desk-link mode-back" type="button">&larr; 뒤로</button>
        </form>
        <div class="mode-step class-form-step" data-step="confirm" hidden>
          <h1>이 반이 맞나요?</h1>
          <div class="class-confirm" data-id="confirm-card"></div>
          <p class="class-error" data-id="error"></p>
          <button class="mode-btn" type="button" data-id="confirm-yes"><span class="mode-text"><b>네, 들어갈래요</b><small>같은 반 친구들과 함께 만들어요</small></span></button>
          <button class="desk-link" type="button" data-id="confirm-no">&larr; 아니에요, 다시 입력할게요</button>
        </div>
      </div>`;
    parent.appendChild(screen);

    const steps = screen.querySelectorAll<HTMLElement>(".mode-step");
    const show = (step: string) => {
      steps.forEach((s) => (s.hidden = s.dataset.step !== step));
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
      error.textContent = "연결하는 중…";
      button.disabled = true;
      const client = new ClassClient(join);
      try {
        const session = await client.connect();
        remember(join);
        done({ client, session });
      } catch (code) {
        error.textContent = CLASS_ERROR_TEXT[code as keyof typeof CLASS_ERROR_TEXT] ?? "연결하지 못했어요.";
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
      error.textContent = "반을 찾는 중…";
      button.disabled = true;
      void peekClass(join.room)
        .then((info) => {
          button.disabled = false;
          if (!info.exists) {
            error.textContent = `'${join.room}' 반을 찾을 수 없어요. 반 이름을 다시 확인해주세요.`;
            return;
          }
          if (!info.open) {
            error.textContent = `${info.teacher ?? ""} 선생님의 '${info.room}' 반이 아직 열리지 않았어요. 선생님이 반을 열면 들어갈 수 있어요.`;
            return;
          }
          error.textContent = "";
          pending = { ...join, room: info.room };
          confirmStep.querySelector<HTMLElement>('[data-id="confirm-card"]')!.innerHTML = `
            <div class="class-confirm-room">🏫 ${escapeHtml(info.room)}</div>
            <div class="class-confirm-teacher">👩‍🏫 <b>${escapeHtml(info.teacher ?? "")}</b> 선생님 반</div>
            <div class="class-confirm-me">🧒 나는 <b>${escapeHtml(join.student)}</b> (으)로 들어가요</div>`;
          confirmStep.querySelector<HTMLElement>('[data-id="error"]')!.textContent = "";
          show("confirm");
        })
        .catch((code: unknown) => {
          button.disabled = false;
          error.textContent = CLASS_ERROR_TEXT[code as keyof typeof CLASS_ERROR_TEXT] ?? "연결하지 못했어요.";
        });
    });
    confirmStep.querySelector<HTMLButtonElement>('[data-id="confirm-yes"]')!.addEventListener("click", () => {
      if (pending) void connect(confirmStep, pending);
    });
    confirmStep.querySelector<HTMLButtonElement>('[data-id="confirm-no"]')!.addEventListener("click", () => show("student"));
  });
}
