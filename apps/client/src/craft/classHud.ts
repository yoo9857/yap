import type { ClassMember, ClassRole, ClassSettings } from "@robo/shared";
import "./classroom.css";
import { t } from "../ui/i18n.js";
import { ClassTools } from "./classTools.js";
import type { ClassLesson } from "../net/classClient.js";
import { isTouchPlay } from "../input/touchPlay.js";

export interface ClassHudActions {
  chat(text: string): void;
  kick(member: ClassMember): void;
  gather(): void;
  /** Give every online student a 15 × 20 plot of their own in front of the teacher. */
  arrange(): void;
  /** Take the seating (dividers and name signs) away. */
  unarrange(): void;
  /** Let the students walk off their plots (true), or send them back and keep them in (false). */
  roam(on: boolean): void;
  /** 모두 멈춰 on/off: students can't move, build, chat or tap. */
  freeze(on: boolean): void;
  /** A countdown for the whole class, in seconds (0 stops it). */
  timer(sec: number): void;
  /** A big mid-screen message for everyone. */
  announce(text: string): void;
  /** The teacher goes and stands beside a student. */
  visit(member: ClassMember): void;
  /** The F2 class-tools panel opened / closed. `resume`: closed by a click or F2 (a user gesture,
   *  so the mouse can be captured again); Esc leaves the game paused instead. */
  toolsOpen(open: boolean, resume?: boolean): void;
  /** Another panel owns the screen (bag, furniture, machine lab…): F2 waits. */
  busy?(): boolean;
  settings(next: ClassSettings): void;
  end(): void;
  resetWorld(): void;
  drainWater(): void;
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
  private readonly log = el("div", "class-chat-log");
  private readonly input = el("input", "class-chat-input");
  private settings: ClassSettings = { chatLocked: false, buildLocked: false };
  private members: ClassMember[] = [];
  /** The class is over (showEnded): Enter no longer opens the chat. */
  private ended = false;
  /** The teacher's F2 class tools (null for students). */
  private tools: ClassTools | null = null;
  /** The teacher froze the class (모두 멈춰): a student's chat waits too. */
  private frozen = false;
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
      // every teacher action lives in the F2 console now (the panel's buttons duplicated it)
      this.tools = new ClassTools(party ? `${t("방", "Room")} ${party}` : room, {
        arrange: () => this.actions.arrange(),
        gather: () => this.actions.gather(),
        unarrange: () => this.actions.unarrange(),
        roam: (on) => this.actions.roam(on),
        freeze: (on) => this.actions.freeze(on),
        timer: (sec) => this.actions.timer(sec),
        announce: (text) => this.actions.announce(text),
        visit: (m) => this.actions.visit(m),
        settings: (next) => this.actions.settings(next),
        kick: (m) => this.actions.kick(m),
        resetWorld: () => this.actions.resetWorld(),
        drainWater: () => this.actions.drainWater(),
        end: () => this.actions.end(),
        toolsOpen: (open, resume) => {
          if (open) this.closeInput();
          this.actions.toolsOpen(open, resume);
        },
        busy: () => this.ended || (this.actions.busy?.() ?? false),
      });
    }
    this.panel.append(el("div", "class-tip", role === "teacher"
      ? t("F2 수업 도구 · Enter 채팅", "F2 class tools · Enter to chat")
      : isTouchPlay() ? t("💬 버튼으로 채팅", "Chat with 💬") : t("Enter 채팅", "Enter to chat")));

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
    this.tools?.setMembers(members, this.you);
    const students = members.filter((m) => m.role === "student");
    this.count.textContent = t(` · 학생 ${students.filter((m) => m.online).length}/${students.length}명 접속 중`, ` · ${students.filter((m) => m.online).length}/${students.length} students online`);
    this.list.classList.toggle("many", members.length > 8);
    // teacher, then whoever is online: the names worth seeing sit at the top of a long list
    const shown = [...members].sort((a, b) => Number(b.role === "teacher") - Number(a.role === "teacher") || Number(b.online) - Number(a.online));
    this.list.replaceChildren(
      ...shown.map((m) => {
        const li = el("li", m.online ? "online" : "offline");
        li.append(el("span", "dot"), el("span", "name", `${m.role === "teacher" ? "👩‍🏫 " : ""}${m.name}${m.id === this.you ? t(" (나)", " (you)") : ""}`));
        return li;
      }),
    );
  }

  setSettings(settings: ClassSettings): void {
    this.settings = settings;
    this.tools?.setSettings(settings);
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

  /** A seating stands (or not), whether the students may roam, and whose plots: the tools follow. */
  setSeated(seated: boolean, roam = false, plots: string[] = []): void {
    this.tools?.setSeated(seated, roam, plots);
  }

  /** The lesson's state (freeze, timer): the tools show it; a frozen student's chat waits. */
  setLesson(lesson: ClassLesson): void {
    this.frozen = lesson.frozen;
    this.tools?.setLesson(lesson);
    if (this.role === "student" && lesson.frozen) this.closeInput();
  }

  get toolsOpen(): boolean {
    return this.tools?.open ?? false;
  }

  get memberList(): ClassMember[] {
    return this.members;
  }

  private handleKey(e: KeyboardEvent): void {
    // the teacher's class tools: F2 toggles; while open, every key is theirs (numbers, Esc, typing)
    if (this.tools && e.key === "F2") {
      e.preventDefault();
      e.stopPropagation();
      if (!this.ended) this.tools.toggle();
      return;
    }
    if (this.tools?.handleKey(e)) return;
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
    e.preventDefault();
    this.openChat();
  }

  /** The teacher's class tools (F2, or the touch button); false when this seat has none. */
  toggleTools(): boolean {
    if (!this.tools || this.ended) return false;
    this.tools.toggle();
    return true;
  }

  get hasTools(): boolean {
    return this.tools !== null;
  }

  /** Open the chat box (Enter, or the 💬 touch button) — unless the class is over, locked or frozen. */
  openChat(): void {
    if (!this.input.hidden || this.ended) return;
    if (this.role === "student" && this.settings.chatLocked) {
      this.chat("", "teacher", t("선생님이 채팅을 잠갔어요", "The teacher locked the chat"), true);
      return;
    }
    if (this.role === "student" && this.frozen) {
      this.chat("", "teacher", t("✋ 지금은 선생님을 봐요 — 채팅은 잠시 후에", "✋ Eyes on the teacher — chat in a moment"), true);
      return;
    }
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
    this.tools?.dispose();
    this.panel.remove();
    this.log.parentElement?.remove();
  }
}
