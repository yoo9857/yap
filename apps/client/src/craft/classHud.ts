import type { ClassMember, ClassRole, ClassSettings } from "@robo/shared";
import "./classroom.css";
import { t } from "../ui/i18n.js";

export interface ClassHudActions {
  chat(text: string): void;
  kick(member: ClassMember): void;
  gather(): void;
  /** Give every online student a 15 × 20 plot of their own in front of the teacher. */
  arrange(): void;
  /** Take the seating (dividers and name signs) away. */
  unarrange(): void;
  /** The F2 class-tools panel opened / closed. `resume`: closed by a click or F2 (a user gesture,
   *  so the mouse can be captured again); Esc leaves the game paused instead. */
  toolsOpen(open: boolean, resume?: boolean): void;
  /** Another panel owns the screen (bag, furniture, machine lab…): F2 waits. */
  busy?(): boolean;
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
  private readonly tapsLock = el("button", "class-btn");
  private readonly log = el("div", "class-chat-log");
  private readonly input = el("input", "class-chat-input");
  private settings: ClassSettings = { chatLocked: false, buildLocked: false };
  private members: ClassMember[] = [];
  /** The class is over (showEnded): Enter no longer opens the chat. */
  private ended = false;
  /** The teacher's F2 class tools (null for students). */
  private tools: HTMLDivElement | null = null;
  /** "자리 치우기" — only offered while a seating stands. */
  private unseat: HTMLButtonElement | null = null;
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);

  constructor(
    private readonly role: ClassRole,
    private you: string,
    room: string,
    teacher: string,
    private readonly actions: ClassHudActions,
  ) {
    const head = el("div", "class-head");
    // a hub room's field (party:CODE) has no teacher: it is "room CODE"
    const party = room.startsWith("party:") ? room.slice(6) : "";
    const title = el("b", "class-title", party
      ? t(`🎮 방 ${party} · 함께 짓기`, `🎮 Room ${party} · Build together`)
      : t(`🏫 ${room} · ${teacher} 선생님`, `🏫 ${room} · ${teacher}'s class`));
    head.append(title, this.status);
    const sub = el("div", "class-sub");
    sub.append(el("span", "", party
      ? t("🧱 같은 들판에서 함께 짓는 중", "🧱 Building on one shared field")
      : role === "teacher" ? t("👩‍🏫 내가 선생님", "👩‍🏫 You are the teacher") : t("🧒 내가 학생", "🧒 You are a student")), this.count);
    head.addEventListener("click", () => this.panel.classList.toggle("collapsed"));
    this.panel.append(head, sub, this.list);

    if (role === "teacher") {
      const gather = el("button", "class-btn", t("📣 모두 모이기", "📣 Gather everyone"));
      gather.addEventListener("click", () => this.actions.gather());
      this.chatLock.addEventListener("click", () =>
        this.actions.settings({ ...this.settings, chatLocked: !this.settings.chatLocked }),
      );
      this.buildLock.addEventListener("click", () =>
        this.actions.settings({ ...this.settings, buildLocked: !this.settings.buildLocked }),
      );
      this.tapsLock.addEventListener("click", () =>
        this.actions.settings({ ...this.settings, tapsLocked: !this.settings.tapsLocked }),
      );
      const end = el("button", "class-btn danger", t("수업 종료", "End class"));
      end.addEventListener("click", () => {
        if (confirm(t("수업을 끝낼까요? 모든 학생의 연결이 끊어져요.", "End the class? Every student will be disconnected."))) this.actions.end();
      });
      const reset = el("button", "class-btn", t("🧹 들판 비우기", "🧹 Clear the field"));
      reset.addEventListener("click", () => {
        if (confirm(t("반의 들판을 모두 비울까요? 지금까지 만든 것이 모두 사라져요.", "Clear the whole class field? Everything built so far will be gone."))) this.actions.resetWorld();
      });
      this.controls.append(gather, this.chatLock, this.buildLock, this.tapsLock, reset, end);
      this.panel.append(this.controls);
      this.tools = this.buildTools();
    }
    this.panel.append(el("div", "class-tip", role === "teacher"
      ? t("F2 수업 도구 · Esc로 마우스를 풀면 버튼을 누를 수 있어요 · Enter 채팅", "F2 class tools · Press Esc to free the mouse and use the buttons · Enter to chat")
      : t("Esc로 마우스를 풀면 버튼을 누를 수 있어요 · Enter 채팅", "Press Esc to free the mouse and use the buttons · Enter to chat")));

    this.input.maxLength = 120;
    this.input.placeholder = t("메시지 입력 후 Enter (Esc 취소)", "Type a message, Enter to send (Esc to cancel)");
    this.input.hidden = true;
    const chat = el("div", "class-chat");
    chat.append(this.log, this.input);
    document.body.append(this.panel, chat);
    document.addEventListener("keydown", this.onKey, true);
    this.setOnline(true);
    this.setSettings(this.settings);
  }

  setOnline(online: boolean): void {
    this.status.textContent = online ? t("● 연결됨", "● Connected") : t("● 재연결 중…", "● Reconnecting…");
    this.status.classList.toggle("off", !online);
  }

  setMembers(members: ClassMember[]): void {
    this.members = members;
    const students = members.filter((m) => m.role === "student");
    this.count.textContent = t(` · 학생 ${students.filter((m) => m.online).length}/${students.length}명 접속 중`, ` · ${students.filter((m) => m.online).length}/${students.length} students online`);
    this.list.replaceChildren(
      ...members.map((m) => {
        const li = el("li", m.online ? "online" : "offline");
        li.append(el("span", "dot"), el("span", "name", `${m.role === "teacher" ? "👩‍🏫 " : ""}${m.name}${m.id === this.you ? t(" (나)", " (you)") : ""}`));
        if (this.role === "teacher" && m.role === "student") {
          const kick = el("button", "class-kick", "✕");
          kick.title = t("내보내기", "Remove from class");
          kick.addEventListener("click", () => {
            if (confirm(t(`${m.name} 학생을 내보낼까요?`, `Remove ${m.name} from the class?`))) this.actions.kick(m);
          });
          li.append(kick);
        }
        return li;
      }),
    );
  }

  setSettings(settings: ClassSettings): void {
    this.settings = settings;
    this.chatLock.textContent = settings.chatLocked ? t("💬 채팅 잠금 해제", "💬 Unlock chat") : t("💬 채팅 잠그기", "💬 Lock chat");
    this.buildLock.textContent = settings.buildLocked ? t("🧱 건축 잠금 해제", "🧱 Unlock building") : t("🧱 건축 잠그기", "🧱 Lock building");
    this.chatLock.classList.toggle("on", settings.chatLocked);
    this.buildLock.classList.toggle("on", settings.buildLocked);
    this.tapsLock.textContent = settings.tapsLocked ? t("👋 친구 밀기 다시 허용", "👋 Allow friend taps") : t("👋 친구 밀기 끄기", "👋 Turn friend taps off");
    this.tapsLock.classList.toggle("on", settings.tapsLocked === true);
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
    this.closeInput(); // the chat is gone with the class: Enter must not open a box that sends nowhere
    this.ended = true;
    const screen = el("div", "screen class-ended");
    const card = el("div", "screen-card");
    const button = el("button", "mode-btn", t("처음 화면으로", "Back to the start"));
    button.addEventListener("click", () => (location.href = "/"));
    card.append(el("h1", "", t("수업이 끝났어요", "Class is over")), el("p", "", text), button);
    screen.append(card);
    document.body.append(screen);
    document.exitPointerLock();
  }

  /** A seating stands (or not): the tools offer to put it away. */
  setSeated(seated: boolean): void {
    if (this.unseat) this.unseat.hidden = !seated;
  }

  get toolsOpen(): boolean {
    return this.tools !== null && !this.tools.hidden;
  }

  /** The F2 panel: what the teacher can do with the whole class, one click each. */
  private buildTools(): HTMLDivElement {
    const wrap = el("div", "class-tools");
    wrap.hidden = true;
    const card = el("div", "class-tools-card");
    const head = el("div", "class-tools-head");
    const close = el("button", "class-tools-x", "✕");
    close.title = t("닫기 (F2 / Esc)", "Close (F2 / Esc)");
    close.addEventListener("click", () => this.closeTools());
    head.append(el("h2", "", t("수업 도구", "Class tools")), el("span", "class-tools-key", "F2"), close);
    const option = (n: number, icon: string, title: string, desc: string, run: () => void) => {
      const b = el("button", "class-tools-opt");
      b.dataset.opt = String(n);
      const text = el("span", "class-tools-text");
      text.append(el("b", "", title), el("small", "", desc));
      b.append(el("span", "class-tools-num", String(n)), el("span", "class-tools-icon", icon), text);
      b.addEventListener("click", () => {
        run();
        this.closeTools();
      });
      return b;
    };
    const list = el("div", "class-tools-list");
    list.append(
      option(1, "🪑", t("자리 배치", "Seat the class"),
        t("학생마다 가로 15 × 세로 20칸 땅을 나눠 주고, 칸막이와 이름 팻말을 세워요 (내 앞에 이름순)", "Give every student a 15 × 20 plot of their own, with fences and a name sign (in front of you, name order)"),
        () => this.actions.arrange()),
      option(2, "📣", t("모두 모이기", "Gather everyone"), t("학생들을 내 주변으로 불러요", "Call everyone over to you"), () => this.actions.gather()),
    );
    this.unseat = option(3, "🧹", t("자리 치우기", "Put the seating away"), t("칸막이와 이름 팻말을 걷어요", "Take the fences and name signs away"), () => this.actions.unarrange());
    this.unseat.hidden = true;
    list.append(this.unseat);
    card.append(head, list, el("p", "class-tools-tip", t("숫자 키로 바로 골라요 · F2 / Esc 닫기", "Pick with a number key · F2 / Esc to close")));
    wrap.append(card);
    wrap.addEventListener("pointerdown", (e) => {
      if (e.target === wrap) this.closeTools();
    });
    document.body.append(wrap);
    return wrap;
  }

  private openTools(): void {
    if (!this.tools || !this.tools.hidden || this.ended || this.actions.busy?.()) return;
    this.closeInput();
    this.tools.hidden = false;
    this.actions.toolsOpen(true);
  }

  private closeTools(resume = true): void {
    if (!this.tools || this.tools.hidden) return;
    this.tools.hidden = true;
    this.actions.toolsOpen(false, resume);
  }

  get memberList(): ClassMember[] {
    return this.members;
  }

  private handleKey(e: KeyboardEvent): void {
    // the teacher's class tools: F2 toggles, Esc closes, a number picks
    if (this.tools && e.key === "F2") {
      e.preventDefault();
      e.stopPropagation();
      if (this.toolsOpen) this.closeTools();
      else this.openTools();
      return;
    }
    if (this.toolsOpen) {
      e.stopPropagation();
      if (e.key === "Escape") {
        // Esc is no user activation for pointer lock: close to the pause card, not to play
        e.preventDefault();
        this.closeTools(false);
        return;
      }
      const pick = this.tools!.querySelector<HTMLButtonElement>(`[data-opt="${e.key}"]:not([hidden])`);
      if (pick) {
        e.preventDefault();
        pick.click();
      }
      return;
    }
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
    if (e.key !== "Enter" || !this.input.hidden || this.ended) return;
    if (e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (this.role === "student" && this.settings.chatLocked) {
      this.chat("", "teacher", t("선생님이 채팅을 잠갔어요", "The teacher locked the chat"), true);
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

  setYou(you: string): void { this.you = you; }

  dispose(): void {
    document.removeEventListener("keydown", this.onKey, true);
    this.tools?.remove();
    this.panel.remove();
    this.log.parentElement?.remove();
  }
}
