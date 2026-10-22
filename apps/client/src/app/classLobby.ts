import { CLASS_ERROR_TEXT, ClassClient, type ClassJoin, type ClassSession } from "../net/classClient.js";
import "../craft/classroom.css";

export interface ClassEntry {
  client: ClassClient;
  session: ClassSession;
}

const LAST_KEY = "craftyap-class-last";

function remembered(): { teacher?: string; student?: string } {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as { teacher?: string; student?: string };
  } catch {
    return {};
  }
}

function remember(join: ClassJoin): void {
  try {
    localStorage.setItem(
      LAST_KEY,
      JSON.stringify({ teacher: join.teacher, student: join.role === "student" ? join.student : remembered().student }),
    );
  } catch {
    /* fine */
  }
}

/** Connect straight away (deep links / E2E: `?mode=field&host=Kim`,
 *  `?mode=field&teacher=Kim&student=Minji`). Null when no class is asked for. */
export async function classFromUrl(): Promise<ClassEntry | null> {
  const p = new URLSearchParams(location.search);
  const host = p.get("host");
  const teacher = p.get("teacher");
  const student = p.get("student");
  const join: ClassJoin | null = host
    ? { role: "teacher", teacher: host, password: p.get("pass") ?? undefined }
    : teacher && student
      ? { role: "student", teacher, student }
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

/**
 * Education mode's front door: a teacher opens a class under their name,
 * students join with that name plus their own — or play alone. Resolves with
 * the live class, or null for solo play.
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
            <span class="mode-text"><b>선생님 · 반 만들기</b><small>내 이름으로 반을 열면 학생들이 들어와요</small></span>
          </button>
          <button class="mode-btn" data-go="student">
            <span class="mode-emoji">🧒</span>
            <span class="mode-text"><b>학생 · 반 참여하기</b><small>선생님 이름과 내 이름을 입력해요</small></span>
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
            <label for="cl-host">선생님 이름</label>
            <input id="cl-host" name="teacher" maxlength="16" autocomplete="off" required placeholder="예: 김선생" />
            <label for="cl-pass">반 비밀번호</label>
            <input id="cl-pass" name="password" type="password" minlength="4" maxlength="32" autocomplete="off" placeholder="4자 이상 · 다른 컴퓨터에서 반을 다시 열 때 필요해요" />
          </div>
          <p class="class-note">반에서 만든 것은 서버에 저장돼요. 다음 수업에 같은 이름으로 열면 이어서 할 수 있어요.</p>
          <p class="class-error" data-id="error"></p>
          <button class="mode-btn" type="submit"><span class="mode-text"><b>반 열기</b><small>학생들에게 이 이름을 알려주세요</small></span></button>
          <button class="desk-link mode-back" type="button">&larr; 뒤로</button>
        </form>
        <form class="mode-step class-form-step" data-step="student" hidden>
          <h1>반 참여하기</h1>
          <div class="class-form">
            <label for="cl-teacher">선생님 이름</label>
            <input id="cl-teacher" name="teacher" maxlength="16" autocomplete="off" required placeholder="선생님이 알려준 이름" />
            <label for="cl-student">내 이름</label>
            <input id="cl-student" name="student" maxlength="16" autocomplete="off" required placeholder="예: 민지" />
          </div>
          <p class="class-error" data-id="error"></p>
          <button class="mode-btn" type="submit"><span class="mode-text"><b>들어가기</b><small>같은 반 친구들과 함께 만들어요</small></span></button>
          <button class="desk-link mode-back" type="button">&larr; 뒤로</button>
        </form>
      </div>`;
    parent.appendChild(screen);

    const steps = screen.querySelectorAll<HTMLElement>(".mode-step");
    const show = (step: string) => {
      steps.forEach((s) => (s.hidden = s.dataset.step !== step));
      screen.querySelector<HTMLInputElement>(`[data-step="${step}"] input`)?.focus();
    };
    const input = (id: string) => screen.querySelector<HTMLInputElement>(`#${id}`)!;
    input("cl-host").value = last.teacher ?? "";
    input("cl-teacher").value = last.teacher ?? "";
    input("cl-student").value = last.student ?? "";

    const done = (entry: ClassEntry | null) => {
      screen.remove();
      resolve(entry);
    };
    screen.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((btn) =>
      btn.addEventListener("click", () => (btn.dataset.go === "solo" ? done(null) : show(btn.dataset.go!))),
    );
    screen.querySelectorAll<HTMLButtonElement>(".mode-back").forEach((btn) => btn.addEventListener("click", () => show("pick")));

    const connect = async (form: HTMLFormElement, join: ClassJoin) => {
      const error = form.querySelector<HTMLElement>('[data-id="error"]')!;
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      const names = join.role === "teacher" ? [join.teacher] : [join.teacher, join.student];
      if (names.some((n) => n.length < 1 || n.length > 16)) {
        error.textContent = CLASS_ERROR_TEXT["bad-name"];
        return;
      }
      error.textContent = "연결하는 중…";
      submit.disabled = true;
      const client = new ClassClient(join);
      try {
        const session = await client.connect();
        remember(join);
        done({ client, session });
      } catch (code) {
        error.textContent = CLASS_ERROR_TEXT[code as keyof typeof CLASS_ERROR_TEXT] ?? "연결하지 못했어요.";
        submit.disabled = false;
      }
    };
    screen.querySelector<HTMLFormElement>('[data-step="teacher"]')!.addEventListener("submit", (e) => {
      e.preventDefault();
      void connect(e.target as HTMLFormElement, {
        role: "teacher",
        teacher: input("cl-host").value.trim(),
        password: input("cl-pass").value || undefined,
      });
    });
    screen.querySelector<HTMLFormElement>('[data-step="student"]')!.addEventListener("submit", (e) => {
      e.preventDefault();
      void connect(e.target as HTMLFormElement, {
        role: "student",
        teacher: input("cl-teacher").value.trim(),
        student: input("cl-student").value.trim(),
      });
    });
  });
}
