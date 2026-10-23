import type { ClassMember, ClassRole, ClassSettings } from "@robo/shared";
import "./classroom.css";

export interface ClassHudActions {
  chat(text: string): void;
  kick(member: ClassMember): void;
  gather(): void;
  settings(next: ClassSettings): void;
  end(): void;
  resetWorld(): void;
  /** Typing started/stopped — the game drops held movement keys. */
  typing(active: boolean): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text; // names are user input: never innerHTML
  return node;
};

/**
 * Classroom overlay: who's here (top-left), the teacher's controls, and chat
 * (Enter to talk). Pure DOM; every decision goes back through `actions`.
 */
export class ClassHud {
  private readonly panel = el("div", "class-panel");
  private readonly status = el("span", "class-status");
  private readonly count = el("span", "class-count");
  private readonly list = el("ul", "class-members");
  private readonly controls = el("div", "class-controls");
  private readonly chatLock = el("button", "class-btn");
  private readonly buildLock = el("button", "class-btn");
  private readonly log = el("div", "class-chat-log");
  private readonly input = el("input", "class-chat-input");
  private settings: ClassSettings = { chatLocked: false, buildLocked: false };
  private members: ClassMember[] = [];
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);

  constructor(
    private readonly role: ClassRole,
    private readonly you: string,
    room: string,
    teacher: string,
    private readonly actions: ClassHudActions,
  ) {
    const head = el("div", "class-head");
    const title = el("b", "class-title", `🏫 ${room} · ${teacher} 선생님`);
    head.append(title, this.status);
    const sub = el("div", "class-sub");
    sub.append(el("span", "", role === "teacher" ? "👩‍🏫 내가 선생님" : "🧒 내가 학생"), this.count);
    head.addEventListener("click", () => this.panel.classList.toggle("collapsed"));
    this.panel.append(head, sub, this.list);

    if (role === "teacher") {
      const gather = el("button", "class-btn", "📣 모두 모이기");
      gather.addEventListener("click", () => this.actions.gather());
      this.chatLock.addEventListener("click", () =>
        this.actions.settings({ ...this.settings, chatLocked: !this.settings.chatLocked }),
      );
      this.buildLock.addEventListener("click", () =>
        this.actions.settings({ ...this.settings, buildLocked: !this.settings.buildLocked }),
      );
      const end = el("button", "class-btn danger", "수업 종료");
      end.addEventListener("click", () => {
        if (confirm("수업을 끝낼까요? 모든 학생의 연결이 끊어져요.")) this.actions.end();
      });
      const reset = el("button", "class-btn", "🧹 들판 비우기");
      reset.addEventListener("click", () => {
        if (confirm("반의 들판을 모두 비울까요? 지금까지 만든 것이 모두 사라져요.")) this.actions.resetWorld();
      });
      this.controls.append(gather, this.chatLock, this.buildLock, reset, end);
      this.panel.append(this.controls);
    }
    this.panel.append(el("div", "class-tip", "Esc로 마우스를 풀면 버튼을 누를 수 있어요 · Enter 채팅"));

    this.input.maxLength = 120;
    this.input.placeholder = "메시지 입력 후 Enter (Esc 취소)";
    this.input.hidden = true;
    const chat = el("div", "class-chat");
    chat.append(this.log, this.input);
    document.body.append(this.panel, chat);
    document.addEventListener("keydown", this.onKey, true);
    this.setOnline(true);
    this.setSettings(this.settings);
  }

  setOnline(online: boolean): void {
    this.status.textContent = online ? "● 연결됨" : "● 재연결 중…";
    this.status.classList.toggle("off", !online);
  }

  setMembers(members: ClassMember[]): void {
    this.members = members;
    const students = members.filter((m) => m.role === "student");
    this.count.textContent = ` · 학생 ${students.filter((m) => m.online).length}/${students.length}명 접속 중`;
    this.list.replaceChildren(
      ...members.map((m) => {
        const li = el("li", m.online ? "online" : "offline");
        li.append(el("span", "dot"), el("span", "name", `${m.role === "teacher" ? "👩‍🏫 " : ""}${m.name}${m.id === this.you ? " (나)" : ""}`));
        if (this.role === "teacher" && m.role === "student") {
          const kick = el("button", "class-kick", "✕");
          kick.title = "내보내기";
          kick.addEventListener("click", () => {
            if (confirm(`${m.name} 학생을 내보낼까요?`)) this.actions.kick(m);
          });
          li.append(kick);
        }
        return li;
      }),
    );
  }

  setSettings(settings: ClassSettings): void {
    this.settings = settings;
    this.chatLock.textContent = settings.chatLocked ? "💬 채팅 잠금 해제" : "💬 채팅 잠그기";
    this.buildLock.textContent = settings.buildLocked ? "🧱 건축 잠금 해제" : "🧱 건축 잠그기";
    this.chatLock.classList.toggle("on", settings.chatLocked);
    this.buildLock.classList.toggle("on", settings.buildLocked);
    if (this.role === "student" && settings.chatLocked) this.closeInput();
  }

  chat(name: string, role: ClassRole, text: string, system = false): void {
    const line = el("div", system ? "line system" : role === "teacher" ? "line teacher" : "line");
    if (system) line.textContent = text;
    else line.append(el("b", "", `${role === "teacher" ? "👩‍🏫 " : ""}${name}: `), document.createTextNode(text));
    this.log.append(line);
    while (this.log.childElementCount > 8) this.log.firstElementChild?.remove();
    setTimeout(() => line.classList.add("old"), 12_000);
  }

  /** Full-screen card when the session is over (kicked / class ended). */
  showEnded(text: string): void {
    const screen = el("div", "screen class-ended");
    const card = el("div", "screen-card");
    const button = el("button", "mode-btn", "처음 화면으로");
    button.addEventListener("click", () => (location.href = "/"));
    card.append(el("h1", "", "수업이 끝났어요"), el("p", "", text), button);
    screen.append(card);
    document.body.append(screen);
    document.exitPointerLock();
  }

  get memberList(): ClassMember[] {
    return this.members;
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.target === this.input) {
      if (e.key === "Enter") {
        const text = this.input.value.trim();
        if (text) this.actions.chat(text);
        this.closeInput();
        e.preventDefault();
      } else if (e.key === "Escape") {
        this.closeInput();
      }
      e.stopPropagation();
      return;
    }
    if (e.key !== "Enter" || !this.input.hidden) return;
    if (e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (this.role === "student" && this.settings.chatLocked) {
      this.chat("", "teacher", "선생님이 채팅을 잠갔어요", true);
      return;
    }
    e.preventDefault();
    this.input.hidden = false;
    this.input.value = "";
    this.input.focus();
    this.log.classList.add("open");
    this.actions.typing(true);
  }

  private closeInput(): void {
    if (this.input.hidden) return;
    this.input.hidden = true;
    this.input.blur();
    this.log.classList.remove("open");
    this.actions.typing(false);
  }

  dispose(): void {
    document.removeEventListener("keydown", this.onKey, true);
    this.panel.remove();
    this.log.parentElement?.remove();
  }
}
