import type { ClassMember, ClassSettings } from "@robo/shared";
import { CLASS_ANNOUNCE_MAX } from "@robo/shared";
import type { ClassLesson } from "../net/classClient.js";
import "./classTools.css";
import { t } from "../ui/i18n.js";

/** What the teacher's F2 panel can ask for; ClassSync turns each into a message. */
export interface ClassToolsActions {
  arrange(): void;
  gather(): void;
  unarrange(): void;
  roam(on: boolean): void;
  freeze(on: boolean): void;
  /** Start a countdown of `sec` seconds for the whole class (0 stops it). */
  timer(sec: number): void;
  announce(text: string): void;
  /** Go and stand beside this student (the teacher's own teleport). */
  visit(member: ClassMember): void;
  settings(next: ClassSettings): void;
  /** Take a student out of the class (asked first). */
  kick(member: ClassMember): void;
  /** Wipe the class field (asked first). */
  resetWorld(): void;
  /** Remove water throughout the class field, keeping buildings and furniture. */
  drainWater(): void;
  /** One student's plot: take its water out, or put the whole plot back to empty grass (asked first). */
  plot(member: ClassMember, op: "drain" | "reset"): void;
  /** Bring the teacher back up to the ground (dug in and stuck). */
  rescue(): void;
  /** End the lesson for everyone (asked first). */
  end(): void;
  /** The panel opened / closed. `resume`: closed by a click or F2 (a user gesture → back to play). */
  toolsOpen(open: boolean, resume?: boolean): void;
  /** Another panel owns the screen: F2 waits. */
  busy?(): boolean;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text; // names are user input: never innerHTML
  return node;
};

const ICON = (name: string) => `/ui/game/tool-${name}.webp`;
/** Timer presets (s) — the choices a lesson actually uses. */
export const TIMER_PRESETS = [60, 180, 300, 600, 900] as const;
/** Ready-made announcements: one press, read from across the room. */
const ANNOUNCE_PRESETS = [
  t("👀 선생님을 봐 주세요", "👀 Eyes on me, please"),
  t("🧹 정리할 시간이에요", "🧹 Time to tidy up"),
  t("👏 모두 정말 잘했어요!", "👏 Great work, everyone!"),
  t("🏁 이제 마무리해요", "🏁 Let's finish up"),
];

/** mm:ss for a countdown. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface Tile {
  root: HTMLButtonElement;
  title: HTMLElement;
  desc: HTMLElement;
  icon: HTMLImageElement;
  state: HTMLElement;
}

type View = "main" | "timer" | "announce";

/**
 * The teacher's F2 class tools: a two-pane console over the dimmed field. Left, the tools as
 * compact icon rows in three groups (자리 · 수업 진행 · 잠금), each with its number key and a live
 * state, with water cleanup and class controls at the foot; right, the class —
 * a dense, searchable list built for 30-40 students (online first; visit and remove per row).
 * The timer and the announcement open a second step in the same card (Esc / ← goes back).
 * Pure DOM: every decision goes back through `actions`.
 */
export class ClassTools {
  readonly root = el("div", "ct");
  private readonly card = el("div", "ct-card");
  private readonly chips = el("div", "ct-chips");
  private readonly roster = el("ul", "ct-roster");
  private readonly rosterCount = el("span", "ct-count");
  private readonly search = el("input", "ct-search");
  private readonly main = el("div", "ct-main");
  private readonly timerView = el("div", "ct-sub");
  private readonly announceView = el("div", "ct-sub");
  private readonly announceInput = el("input", "ct-input");
  private readonly tiles = new Map<string, Tile>();
  private view: View = "main";

  private members: ClassMember[] = [];
  private you = "";
  private settings: ClassSettings = { chatLocked: false, buildLocked: false };
  private seated = false;
  private roaming = false;
  private plots: string[] = [];
  private lesson: ClassLesson = { frozen: false, timerEnd: null, timerTotal: 0 };
  private clockTimer = 0;

  constructor(private readonly room: string, private readonly actions: ClassToolsActions) {
    this.root.hidden = true;
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });

    // ---- header: who and what is going on
    const head = el("div", "ct-head");
    const badge = el("img", "ct-head-icon");
    badge.src = ICON("teacher");
    badge.alt = "";
    const titles = el("div", "ct-titles");
    titles.append(el("h2", "", t("수업 도구", "Class tools")), el("span", "ct-room", room));
    const key = el("kbd", "ct-key", "F2");
    const x = el("button", "ct-x", "✕");
    x.title = t("닫기 (F2 / Esc)", "Close (F2 / Esc)");
    x.addEventListener("click", () => this.close());
    head.append(badge, titles, key, x);

    // ---- left: the tools
    const group = (label: string, ...tiles: Tile[]) => {
      const g = el("section", "ct-group");
      const grid = el("div", tiles.every((x) => x.root.classList.contains("ct-switch")) ? "ct-grid ct-grid-switch" : "ct-grid");
      grid.append(...tiles.map((x) => x.root));
      g.append(el("h3", "", label), grid);
      return g;
    };
    this.main.append(
      group(t("자리", "Seating"),
        this.tile("seat", 1, "seat", () => this.run(() => this.actions.arrange())),
        this.tile("gather", 2, "gather", () => this.run(() => this.actions.gather())),
        this.tile("clear", 3, "clear", () => this.run(() => this.actions.unarrange())),
        this.tile("roam", 4, "roam", () => this.run(() => this.actions.roam(!this.roaming)))),
      group(t("수업 진행", "Lesson"),
        this.tile("freeze", 5, "freeze", () => this.run(() => this.actions.freeze(!this.lesson.frozen))),
        this.tile("timer", 6, "timer", () => this.show("timer")),
        this.tile("announce", 7, "announce", () => this.show("announce"))),
      group(t("잠금", "Locks"),
        this.tile("build", 8, "lock-build", () => this.actions.settings({ ...this.settings, buildLocked: !this.settings.buildLocked }), true),
        this.tile("chat", 9, "lock-chat", () => this.actions.settings({ ...this.settings, chatLocked: !this.settings.chatLocked }), true),
        this.tile("taps", 0, "lock-taps", () => this.actions.settings({ ...this.settings, tapsLocked: !this.settings.tapsLocked }), true),
        this.tile("plants", -1, "lock-build", () => this.actions.settings({ ...this.settings, plantsLocked: !this.settings.plantsLocked }), true),
        this.tile("pets", -1, "lock-taps", () => this.actions.settings({ ...this.settings, petsOff: !this.settings.petsOff }), true)),
    );
    this.buildTimerView();
    this.buildAnnounceView();
    const left = el("div", "ct-left");
    left.append(this.chips, this.main, this.timerView, this.announceView);

    // ---- right: the class
    const right = el("aside", "ct-right");
    const rhead = el("div", "ct-right-head");
    rhead.append(el("h3", "", t("우리 반", "Our class")), this.rosterCount);
    this.search.type = "search";
    this.search.placeholder = t("🔍 이름 찾기", "🔍 Find a name");
    this.search.addEventListener("input", () => this.renderRoster());
    right.append(rhead, this.search, this.roster);

    const body = el("div", "ct-body");
    body.append(left, right);
    const foot = el("div", "ct-foot");
    const keys = el("p", "ct-keys");
    keys.append(
      el("kbd", "", "0–9"), document.createTextNode(t(" 바로 고르기 · ", " pick · ")),
      el("kbd", "", "Esc"), document.createTextNode(t(" 뒤로 / 닫기", " back / close")),
    );
    // dug in and stuck: the teacher comes straight back up (no number key; it is rarely needed)
    const rescue = el("button", "ct-manage ct-rescue", t("↑ 땅 위로 올라오기", "↑ Back to the surface"));
    rescue.title = t("땅속에 갇혔을 때 지상으로 올라와요.", "Stuck underground? Come straight back up.");
    rescue.addEventListener("click", () => this.run(() => this.actions.rescue()));
    const drain = el("button", "ct-manage ct-drain", t("💧 빠르게 물 빼기", "💧 Drain all water"));
    drain.title = t("반 전체의 물을 한 번에 없애요. 건물과 가구는 그대로예요.", "Remove water throughout the class field. Buildings and furniture stay.");
    drain.addEventListener("click", () => this.run(() => this.actions.drainWater()));
    // Destructive class actions have no number key and ask before they act.
    const reset = el("button", "ct-manage", t("🧹 들판 비우기", "🧹 Clear the field"));
    reset.addEventListener("click", () => {
      if (confirm(t("반의 들판을 모두 비울까요? 지금까지 만든 것이 모두 사라져요.", "Clear the whole class field? Everything built so far will be gone."))) this.run(() => this.actions.resetWorld());
    });
    const end = el("button", "ct-manage danger", t("수업 종료", "End class"));
    end.addEventListener("click", () => {
      if (confirm(t("수업을 끝낼까요? 모든 학생의 연결이 끊어져요.", "End the class? Every student will be disconnected."))) this.run(() => this.actions.end());
    });
    foot.append(rescue, drain, reset, end, keys);
    this.card.append(head, body, foot);
    this.root.append(this.card);
    document.body.append(this.root);
    // the art is small: fetch it now, so the first F2 shows a finished panel, not icons popping in
    for (const name of ["teacher", "seat", "gather", "clear", "roam", "home", "freeze", "timer", "announce", "lock-build", "lock-chat", "lock-taps", "visit"]) {
      const img = new Image();
      img.src = ICON(name);
    }
    this.refresh();
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  setMembers(members: ClassMember[], you: string): void {
    this.members = members;
    this.you = you;
    this.renderRoster();
  }

  setSettings(settings: ClassSettings): void {
    this.settings = settings;
    this.refresh();
  }

  setSeated(seated: boolean, roam: boolean, plots: string[]): void {
    this.seated = seated;
    this.roaming = roam;
    this.plots = plots;
    this.refresh();
    this.renderRoster();
  }

  setLesson(lesson: ClassLesson): void {
    this.lesson = lesson;
    this.refresh();
  }

  toggle(): void {
    if (this.open) this.close();
    else this.openPanel();
  }

  openPanel(): boolean {
    if (this.open || this.actions.busy?.()) return false;
    this.show("main");
    this.root.hidden = false;
    this.actions.toolsOpen(true);
    this.refresh();
    this.renderRoster();
    this.clockTimer = window.setInterval(() => this.refreshClock(), 250);
    return true;
  }

  close(resume = true): void {
    if (!this.open) return;
    this.root.hidden = true;
    this.announceInput.blur();
    window.clearInterval(this.clockTimer);
    this.actions.toolsOpen(false, resume);
  }

  /** A key while the panel is up (the hud routes them here); true = used. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (e.target === this.search && this.search.value) {
        this.search.value = "";
        this.renderRoster();
        return true;
      }
      // a step back first; Esc is no user activation for pointer lock, so close to the pause card
      if (this.view !== "main") this.show("main");
      else this.close(false);
      return true;
    }
    if (e.target === this.search) {
      if (e.key === "Enter") this.search.blur();
      return true; // typing a name: digits are letters here
    }
    if (e.target === this.announceInput) {
      if (e.key === "Enter") {
        e.preventDefault();
        this.sendAnnounce(this.announceInput.value);
      }
      return true; // typing: digits are letters here, not picks
    }
    if (e.key === "Backspace" && this.view !== "main") {
      e.preventDefault();
      this.show("main");
      return true;
    }
    const scope = this.view === "main" ? this.main : this.view === "timer" ? this.timerView : this.announceView;
    const pick = scope.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(e.key)}"]:not(:disabled)`);
    if (pick) {
      e.preventDefault();
      pick.click();
    }
    return true;
  }

  dispose(): void {
    window.clearInterval(this.clockTimer);
    this.root.remove();
  }

  // ------------------------------------------------------------------ building

  /** A tool tile; `toggle`: a lock — drawn as a wide on/off switch, and the panel stays open. */
  private tile(id: string, n: number, icon: string, run: () => void, toggle = false): Tile {
    const root = el("button", `ct-tile ct-${id}${toggle ? " ct-switch" : ""}`);
    if (toggle) root.setAttribute("role", "switch");
    if (n >= 0) root.dataset.key = String(n); // tools past the ten number keys are click-only
    const art = el("span", "ct-art");
    const img = el("img");
    img.src = ICON(icon);
    img.alt = "";
    img.draggable = false;
    art.append(img);
    const title = el("b", "ct-title");
    const desc = el("small", "ct-desc");
    const state = el("span", "ct-state");
    const num = el("kbd", "ct-num", n >= 0 ? String(n) : "");
    if (n < 0) num.style.visibility = "hidden"; // keeps the row's columns in line
    root.append(num, art, title, desc, state);
    root.addEventListener("click", () => {
      if (!root.disabled) run();
    });
    const tile = { root, title, desc, icon: img, state };
    this.tiles.set(id, tile);
    return tile;
  }

  /** An action that is done once picked: the panel closes back to play. */
  private run(fn: () => void): void {
    fn();
    this.close();
  }

  private subHead(view: HTMLElement, icon: string, title: string, desc: string): void {
    const head = el("div", "ct-sub-head");
    const back = el("button", "ct-back", "←");
    back.title = t("뒤로 (Esc)", "Back (Esc)");
    back.addEventListener("click", () => this.show("main"));
    const img = el("img", "ct-sub-icon");
    img.src = ICON(icon);
    img.alt = "";
    const text = el("div", "ct-sub-text");
    text.append(el("b", "", title), el("small", "", desc));
    head.append(back, img, text);
    view.append(head);
  }

  private buildTimerView(): void {
    const v = this.timerView;
    v.hidden = true;
    this.subHead(v, "timer", t("타이머", "Timer"), t("모든 학생 화면 위쪽에 남은 시간이 보여요. 끝나면 알려 줘요.", "Everyone sees the time left at the top of their screen, and hears when it ends."));
    const grid = el("div", "ct-presets");
    TIMER_PRESETS.forEach((sec, i) => {
      const b = el("button", "ct-preset");
      b.dataset.key = String(i + 1);
      b.append(el("kbd", "ct-num", String(i + 1)), el("b", "", t(`${sec / 60}분`, `${sec / 60} min`)));
      b.addEventListener("click", () => this.run(() => this.actions.timer(sec)));
      grid.append(b);
    });
    const stop = el("button", "ct-preset ct-stop");
    stop.dataset.key = "0";
    stop.append(el("kbd", "ct-num", "0"), el("b", "", t("타이머 끄기", "Stop timer")));
    stop.addEventListener("click", () => this.run(() => this.actions.timer(0)));
    grid.append(stop);
    v.append(grid);
  }

  private buildAnnounceView(): void {
    const v = this.announceView;
    v.hidden = true;
    this.subHead(v, "announce", t("큰 글씨 공지", "Announcement"), t("모든 학생 화면 가운데에 크게 몇 초 동안 보여요.", "Shown big in the middle of every screen for a few seconds."));
    const list = el("div", "ct-presets ct-presets-wide");
    ANNOUNCE_PRESETS.forEach((text, i) => {
      const b = el("button", "ct-preset");
      b.dataset.key = String(i + 1);
      b.append(el("kbd", "ct-num", String(i + 1)), el("b", "", text));
      b.addEventListener("click", () => this.sendAnnounce(text));
      list.append(b);
    });
    const row = el("div", "ct-write");
    this.announceInput.maxLength = CLASS_ANNOUNCE_MAX;
    // not focused on open: the number keys pick a ready-made line; a click (or Tab) starts writing
    this.announceInput.placeholder = t("직접 쓰기 (눌러서 입력) — Enter로 보내요", "Write your own (click to type) — Enter to send");
    const send = el("button", "ct-send", t("보내기", "Send"));
    send.addEventListener("click", () => this.sendAnnounce(this.announceInput.value));
    row.append(this.announceInput, send);
    v.append(list, row);
  }

  private sendAnnounce(raw: string): void {
    const text = raw.trim().slice(0, CLASS_ANNOUNCE_MAX);
    if (!text) {
      this.announceInput.focus();
      return;
    }
    this.announceInput.value = "";
    this.run(() => this.actions.announce(text));
  }

  private show(view: View): void {
    this.view = view;
    this.main.hidden = view !== "main";
    this.chips.hidden = view !== "main";
    this.timerView.hidden = view !== "timer";
    this.announceView.hidden = view !== "announce";
    this.card.dataset.view = view;
  }

  // ------------------------------------------------------------------ state

  private setTile(id: string, title: string, desc: string, opts: { on?: boolean; off?: string; icon?: string; state?: string } = {}): void {
    const tile = this.tiles.get(id);
    if (!tile) return;
    tile.title.textContent = title;
    tile.desc.textContent = opts.off ?? desc;
    tile.root.disabled = opts.off !== undefined;
    tile.root.title = opts.off ?? desc; // the reason shows on hover even where the line is hidden
    if (tile.root.getAttribute("role") === "switch") tile.root.setAttribute("aria-checked", String(opts.on === true));
    tile.root.classList.toggle("on", opts.on === true);
    tile.state.textContent = opts.state ?? "";
    tile.state.hidden = !opts.state;
    if (opts.icon) {
      const src = ICON(opts.icon);
      if (!tile.icon.src.endsWith(src)) tile.icon.src = src;
    }
  }

  private refresh(): void {
    const needSeats = t("자리 배치를 하면 쓸 수 있어요", "After seating the class");
    this.setTile("seat", this.seated ? t("자리 다시 배치", "Seat again") : t("자리 배치", "Seat the class"),
      t("학생마다 15×20칸 땅 · 칸막이와 이름 팻말", "A 15×20 plot each · fences and name signs"),
      { on: this.seated, state: this.seated ? t(`${this.plots.length}자리`, `${this.plots.length} plots`) : undefined });
    this.setTile("gather", t("모두 모이기", "Gather everyone"), t("학생들을 내 주변으로 불러요", "Call everyone over to you"));
    this.setTile("clear", t("자리 치우기", "Put seating away"), t("칸막이와 팻말을 걷어요", "Take the fences and signs away"),
      { off: this.seated ? undefined : needSeats });
    this.setTile("roam", this.roaming ? t("자기 자리로", "Back to plots") : t("자유롭게 돌아다니기", "Free to roam"),
      this.roaming ? t("모두 자기 땅으로 돌아가요", "Everyone back onto their plot") : t("울타리 밖으로 나갈 수 있어요", "Let them walk off their plots"),
      { off: this.seated ? undefined : needSeats, icon: this.roaming ? "home" : "roam", on: this.seated && this.roaming, state: this.seated && this.roaming ? t("돌아다니는 중", "Roaming") : undefined });
    const frozen = this.lesson.frozen;
    this.setTile("freeze", frozen ? t("다시 움직이기", "Let them move") : t("모두 멈춰!", "Freeze!"),
      frozen ? t("학생들이 다시 움직이고 만들 수 있어요", "The students can move and build again") : t("움직이기·짓기·채팅을 잠깐 멈춰요", "Stop moving, building and chat for a moment"),
      { on: frozen, state: frozen ? t("멈춤", "Frozen") : undefined });
    this.setTile("timer", t("타이머", "Timer"), t("모두에게 남은 시간을 보여 줘요", "A countdown everyone sees"),
      { on: this.lesson.timerEnd !== null });
    this.setTile("announce", t("큰 글씨 공지", "Announcement"), t("화면 가운데에 크게 띄워요", "Big, in the middle of every screen"));
    this.setTile("build", t("건축 잠금", "Lock building"),
      this.settings.buildLocked ? t("지금 잠겨 있어요 — 학생은 블록·가구를 못 바꿔요", "Locked — students can't change blocks or furniture") : t("켜면 학생이 블록·가구를 못 바꿔요", "On: students can't change blocks or furniture"),
      { on: this.settings.buildLocked });
    this.setTile("chat", t("채팅 잠금", "Lock chat"),
      this.settings.chatLocked ? t("지금 잠겨 있어요 — 학생은 채팅을 못 해요", "Locked — students can't chat") : t("켜면 학생이 채팅을 못 해요", "On: students can't chat"),
      { on: this.settings.chatLocked });
    this.setTile("taps", t("친구 밀기 끄기", "Taps off"),
      this.settings.tapsLocked ? t("지금 꺼져 있어요 — 친구를 밀 수 없어요", "Off — nobody can tap a classmate") : t("켜면 친구를 살짝 미는 장난을 못 해요", "On: nobody can tap a classmate"),
      { on: this.settings.tapsLocked === true });
    this.setTile("plants", t("발전소 잠금", "Lock power plants"),
      this.settings.plantsLocked ? t("지금 잠겨 있어요 — 학생은 발전소를 못 지어요", "Locked — students can't build power plants") : t("켜면 학생이 발전소를 못 지어요", "On: students can't build power plants"),
      { on: this.settings.plantsLocked === true });
    this.setTile("pets", t("펫 끄기", "Pets off"),
      this.settings.petsOff ? t("지금 꺼져 있어요 — 반에 펫이 없어요", "Off — no pets in this class") : t("켜면 모두의 펫이 사라져요", "On: everyone's pet goes away"),
      { on: this.settings.petsOff === true });
    this.renderChips();
    this.refreshClock();
  }

  /** The class at a glance, over the tools: only what is ON (nothing on = one calm line). */
  private renderChips(): void {
    const chips: [string, string][] = [];
    if (this.seated) chips.push(["seat", this.roaming ? t("🚶 자리 배치 · 돌아다니는 중", "🚶 Seated · roaming") : t("🪑 자리 배치 중", "🪑 Seated")]);
    if (this.lesson.frozen) chips.push(["freeze", t("✋ 모두 멈춤", "✋ Frozen")]);
    if (this.lesson.timerEnd !== null) chips.push(["timer", "⏱️ "]);
    if (this.settings.buildLocked) chips.push(["lock", t("🧱 건축 잠김", "🧱 Building locked")]);
    if (this.settings.chatLocked) chips.push(["lock", t("💬 채팅 잠김", "💬 Chat locked")]);
    if (this.settings.tapsLocked) chips.push(["lock", t("👋 밀기 꺼짐", "👋 Taps off")]);
    if (this.settings.plantsLocked) chips.push(["lock", t("⚡ 발전소 잠김", "⚡ Plants locked")]);
    if (this.settings.petsOff) chips.push(["lock", t("🐾 펫 꺼짐", "🐾 Pets off")]);
    if (chips.length === 0) chips.push(["calm", t("지금은 자유롭게 짓는 중이에요", "Free building right now")]);
    this.chips.replaceChildren(...chips.map(([kind, text]) => {
      const c = el("span", `ct-chip ct-chip-${kind}`, text);
      if (kind === "timer") c.append(el("b", "ct-clock"));
      return c;
    }));
  }

  private refreshClock(): void {
    const end = this.lesson.timerEnd;
    const left = end === null ? 0 : end - performance.now();
    const clock = this.chips.querySelector(".ct-clock");
    if (clock) clock.textContent = formatClock(left);
    const tile = this.tiles.get("timer");
    if (tile) {
      tile.state.hidden = end === null;
      tile.state.textContent = end === null ? "" : formatClock(left);
    }
  }

  private renderRoster(): void {
    const students = this.members.filter((m) => m.role === "student");
    const online = students.filter((m) => m.online);
    this.rosterCount.textContent = t(`접속 ${online.length} / ${students.length}명`, `${online.length} / ${students.length} online`);
    // a search box only once the list is long enough to need one
    this.search.hidden = students.length <= 8;
    if (students.length === 0) {
      const empty = el("li", "ct-empty");
      empty.append(el("b", "", t("아직 학생이 없어요", "No students yet")),
        el("small", "", t(`학생은 반 이름 "${this.room}"으로 들어와요`, `Students join with the class name "${this.room}"`)));
      this.roster.replaceChildren(empty);
      return;
    }
    const query = this.search.hidden ? "" : this.search.value.trim().toLowerCase();
    const seated = new Set(this.plots.map((n) => n.trim().toLowerCase()));
    // online first, then by name — the order the teacher scans for a face
    const sorted = students
      .filter((m) => !query || m.name.toLowerCase().includes(query))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, "ko"));
    if (sorted.length === 0) {
      this.roster.replaceChildren(el("li", "ct-empty", t("그런 이름이 없어요", "No one by that name")));
      return;
    }
    this.roster.replaceChildren(...sorted.map((m) => {
      const li = el("li", m.online ? "on" : "off");
      const avatar = el("span", "ct-avatar", [...m.name][0] ?? "?");
      avatar.style.setProperty("--hue", String(hue(m.name)));
      const name = el("b", "ct-who", m.name);
      const tag = !m.online ? t("오프라인", "Offline") : seated.has(m.name.trim().toLowerCase()) ? "🪑" : "";
      li.append(avatar, name);
      if (tag) li.append(el("small", "ct-tag", tag));
      if (m.online && m.id !== this.you) {
        const go = el("button", "ct-icon-btn ct-visit");
        const img = el("img");
        img.src = ICON("visit");
        img.alt = t("찾아가기", "Visit");
        go.append(img);
        go.title = t(`${m.name} 옆으로 가기`, `Go to ${m.name}`);
        go.addEventListener("click", () => this.run(() => this.actions.visit(m)));
        li.append(go);
      }
      // a student with a plot: its water out, or the whole plot back to grass (both need 자리 배치)
      if (seated.has(m.name.trim().toLowerCase())) {
        const drain = el("button", "ct-icon-btn ct-plot-drain", "💧");
        drain.title = t(`${m.name}의 자리에서 물 빼기`, `Drain ${m.name}'s plot`);
        drain.addEventListener("click", () => this.actions.plot(m, "drain"));
        const reset = el("button", "ct-icon-btn ct-plot-reset", "🧹");
        reset.title = t(`${m.name}의 자리 초기화`, `Reset ${m.name}'s plot`);
        reset.addEventListener("click", () => {
          if (confirm(t(`${m.name}의 자리를 초기화할까요? 그 자리에 만든 것이 모두 사라져요.`, `Reset ${m.name}'s plot? Everything built on it will be gone.`))) this.actions.plot(m, "reset");
        });
        li.append(drain, reset);
      }
      const kick = el("button", "ct-icon-btn ct-kick", "✕");
      kick.title = t(`${m.name} 내보내기`, `Remove ${m.name}`);
      kick.addEventListener("click", () => {
        if (confirm(t(`${m.name} 학생을 내보낼까요?`, `Remove ${m.name} from the class?`))) this.actions.kick(m);
      });
      li.append(kick);
      return li;
    }));
  }
}

/** A stable soft colour per name for the roster's avatar circles. */
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}
