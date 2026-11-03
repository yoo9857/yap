import {
  PARTY_GAME_MAX,
  PARTY_GAME_NAMES,
  partyFieldName,
  type PartyErrorCode,
  type PartyGame,
  type PartyRoomInfo,
  type PartyServerMessage,
  type PartySummary,
} from "@robo/shared";
import { PartyClient, savedSeat } from "../net/partyClient.js";
import "./partyLobby.css";

const NAME_KEY = "robo-name"; // the same nickname the tower uses

const ERRORS: Record<PartyErrorCode, string> = {
  "bad-version": "새 버전이 나왔어요. 페이지를 새로고침해 주세요.",
  "bad-name": "이름을 1~16자로 써 주세요.",
  "not-found": "그 코드의 방을 찾지 못했어요. 코드를 다시 확인해 주세요.",
  full: "방이 꽉 찼어요.",
  "name-taken": "그 방에 같은 이름이 이미 있어요. 이름을 바꿔 주세요.",
  kicked: "방장이 내보낸 방이에요. 잠시 뒤에 다시 들어올 수 있어요.",
  "not-host": "방장만 할 수 있어요.",
  "not-ready": "모두 준비해야 시작할 수 있어요.",
  "too-many-rooms": "지금은 방을 더 만들 수 없어요. 열린 방에 들어가 보세요.",
  "game-limit": "지금 인원으로는 그 게임을 할 수 없어요. Daily Tower는 8명까지예요.",
  rate: "너무 빨라요. 잠시 뒤에 다시 해 주세요.",
  internal: "문제가 생겼어요. 다시 해 주세요.",
};

/** Games a room can pick, with the ones that cannot run in a room yet shown as coming soon. */
const GAME_CARDS: { game: PartyGame | null; img: string; name: string; soon?: string; note: string }[] = [
  { game: "build", img: "/home/craft.webp", name: PARTY_GAME_NAMES.build[0], note: "같은 들판에서 함께 블록을 쌓아요" },
  { game: "tower", img: "/home/tower.webp", name: PARTY_GAME_NAMES.tower[0], note: "오늘의 타워를 같이 올라요" },
  { game: null, img: "/home/battle.webp", name: "Blast Royale", soon: "준비 중", note: "친구와 대전은 곧 열려요" },
  { game: null, img: "/home/builder.webp", name: "Robo Builder", soon: "준비 중", note: "같이 짓기는 곧 열려요" },
];

/** Choices for "최대 인원": common sizes up to the game's cap, the cap itself pre-picked (or `keep`). */
function maxOptions(game: PartyGame, keep?: number): string {
  const cap = PARTY_GAME_MAX[game];
  const sizes = [2, 4, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50].filter((n) => n <= cap);
  if (!sizes.includes(cap)) sizes.push(cap);
  const pick = keep && keep <= cap ? (sizes.includes(keep) ? keep : cap) : cap;
  return sizes.map((n) => `<option value="${n}" ${n === pick ? "selected" : ""}>${n}명</option>`).join("");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const gameName = (g: PartyGame) => PARTY_GAME_NAMES[g][0];

function savedName(): string {
  try { return (localStorage.getItem(NAME_KEY) ?? "").trim().slice(0, 16); } catch { return ""; }
}
function rememberName(name: string): void {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* optional */ }
}

/** Where a started room's game lives. The room code rides along so the game finds its room. */
export function gameUrl(game: PartyGame, code: string, name: string): string {
  const q = new URLSearchParams({ party: code });
  if (game === "build") {
    q.set("mode", "field");
    q.set("room", partyFieldName(code));
    q.set("student", name);
  } else {
    q.set("mode", "tower");
  }
  return `/?${q.toString()}`;
}

/**
 * The online hub's rooms: the list in the centre, quick join on the big
 * button, create / code dialogs, and the waiting room. When the host starts
 * (or you join a room already playing) the page moves into the game, keeping
 * the seat so "처음으로" from the game lands back in this room.
 */
export class PartyLobby {
  private client: PartyClient | null = null;
  private room: PartyRoomInfo | null = null;
  private me = "";
  private readonly rows: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly status: HTMLElement;
  private waiting: HTMLElement | null = null;
  private dialog: HTMLElement | null = null;
  private pending: (() => void) | null = null;
  private toastTimer = 0;

  constructor(private readonly root: HTMLElement) {
    this.rows = root.querySelector<HTMLElement>('[data-id="party-rows"]')!;
    this.empty = root.querySelector<HTMLElement>('[data-id="party-empty"]')!;
    this.status = root.querySelector<HTMLElement>('[data-id="party-status"]')!;
    root.querySelector('[data-id="party-create"]')?.addEventListener("click", () => this.openCreate());
    root.querySelector('[data-id="party-code"]')?.addEventListener("click", () => this.openCode());
    root.querySelector('[data-id="party-browse"]')?.addEventListener("click", () => this.setDrawer(!this.drawerOpen));
    root.querySelector('[data-id="party-drawer-close"]')?.addEventListener("click", () => this.setDrawer(false));
    const codeInput = root.querySelector<HTMLInputElement>('[data-id="party-codebar-input"]');
    codeInput?.addEventListener("input", () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
    root.querySelector<HTMLFormElement>('[data-id="party-codebar"]')?.addEventListener("submit", (e) => {
      e.preventDefault();
      const code = codeInput?.value ?? "";
      if (code.length !== 6) { codeInput?.focus(); this.toast("방 코드는 6자리예요."); return; }
      this.withName(() => this.connect().send({ t: "p-join", code }));
    });
    root.querySelector('[data-id="hub-start"]')?.addEventListener("click", () => this.withName(() => this.connect().send({ t: "p-quick" })));
    this.rows.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-code]");
      if (row) this.withName(() => this.connect().send({ t: "p-join", code: row.dataset.code! }));
    });
  }

  private drawerOpen = false;

  /** The room list slides in where the right-hand panels were (they slide out to the right). */
  setDrawer(open: boolean): void {
    this.drawerOpen = open;
    this.root.querySelector(".hub-shell")?.classList.toggle("rooms-open", open);
    this.root.querySelector('[data-id="party-drawer"]')?.setAttribute("aria-hidden", String(!open));
    this.root.querySelector('[data-id="party-browse"]')?.setAttribute("aria-expanded", String(open));
    if (open) this.connect().list();
    else this.release();
  }

  /** True while a dialog or the waiting room owns the screen (Esc then closes that, not the hub). */
  get busy(): boolean {
    return !!this.dialog || !!this.waiting;
  }

  /** Esc: close the top dialog. Returns true when it handled the key. */
  escape(): boolean {
    if (this.dialog) { this.closeDialog(); return true; }
    if (this.waiting) return true;
    if (this.drawerOpen) { this.setDrawer(false); return true; }
    return false;
  }

  /** Shown: connect only if there is a seat to go back to. Otherwise the first room action connects. */
  start(): void {
    this.syncProfile(savedName() || "게스트");
    if (savedSeat()) this.connect();
  }

  /**
   * The room connection, opened on first use. An idle hub holds no socket:
   * the deploy waits for live connections to finish, and a page left on the
   * hub must not hold that up.
   */
  private connect(): PartyClient {
    if (this.client) return this.client;
    const name = savedName() || "게스트";
    this.client = new PartyClient(name);
    this.client.onStatus = (s) => {
      this.status.textContent = s === "online" ? "● 연결됨" : s === "connecting" ? "연결하는 중…" : "연결이 끊겼어요 · 다시 연결하는 중";
      this.status.dataset.state = s;
    };
    this.client.onMessage = (m) => this.onMessage(m);
    this.client.connect();
    if (this.drawerOpen) this.client.list();
    return this.client;
  }

  /** Browsing done and not in a room: let the socket go. */
  private release(): void {
    if (this.room || this.dialog || this.drawerOpen || !this.client) return;
    this.client.close();
    this.client = null;
  }

  // ------------------------------------------------------------ server

  private onMessage(msg: PartyServerMessage): void {
    switch (msg.t) {
      case "s-p-rooms":
        this.renderList(msg.rooms);
        break;
      case "s-p-room": {
        this.room = msg.room;
        this.me = msg.you;
        this.closeDialog();
        this.renderWaiting();
        break;
      }
      case "s-p-left":
        if (msg.reason === "kicked") this.toast("방장이 방에서 내보냈어요.");
        else if (msg.reason === "closed" && this.room) this.toast("방이 닫혔어요.");
        this.room = null;
        this.closeWaiting();
        if (this.drawerOpen) this.client?.list();
        else this.release();
        break;
      case "s-p-start":
        this.launch(msg.game, msg.code);
        break;
      case "s-p-chat":
        this.addChat(msg.name, msg.text, msg.system === true);
        break;
      case "s-p-error":
        if (msg.code === "name-taken" || msg.code === "bad-name") this.openName(ERRORS[msg.code]);
        else this.toast(ERRORS[msg.code]);
        break;
    }
  }

  private launch(game: PartyGame, code: string): void {
    const name = this.client!.playerName;
    rememberName(name);
    this.toast(`${gameName(game)}(으)로 들어가요…`);
    this.client!.close(); // the seat stays for the way back
    location.href = gameUrl(game, code, name);
  }

  // ------------------------------------------------------------ list

  private renderList(rooms: PartySummary[]): void {
    this.empty.hidden = rooms.length > 0;
    const html = rooms.map((r) => {
      const full = r.players >= r.max;
      const state = r.state === "playing" ? `<i class="party-state playing">게임 중</i>` : `<i class="party-state">대기 중</i>`;
      return `<li><button type="button" class="party-row" data-code="${esc(r.code)}" ${full ? "disabled" : ""}>
        <span class="party-row-title"><b>${esc(r.title)}</b><small>방장 ${esc(r.host)}</small></span>
        <span class="party-row-meta">${state}<span>${esc(gameName(r.game))}</span><span class="party-row-count">👥 ${r.players}/${r.max}</span></span>
        <span class="party-row-go">${full ? "꽉 참" : r.state === "playing" ? "바로 참여" : "입장"}</span>
      </button></li>`;
    }).join("");
    // redraw only when something changed: a rebuilt row under the pointer loses its hover
    // (and a click landing mid-rebuild hits a detached button)
    if (html !== this.listHtml) this.rows.innerHTML = this.listHtml = html;
  }
  private listHtml = "";

  // ------------------------------------------------------------ name

  /** Run `then` once the player has a nickname (asks for one the first time). */
  private withName(then: () => void): void {
    if (savedName()) return then();
    this.pending = then;
    this.openName();
  }

  private setName(name: string): void {
    rememberName(name);
    this.connect().rename(name);
    this.syncProfile(name);
  }

  private syncProfile(name: string): void {
    const slot = document.querySelector<HTMLElement>('[data-id="hub-name"]');
    if (slot) slot.textContent = name;
  }

  private nameField(): string {
    return `<label class="party-field"><span>내 이름</span><input data-id="pd-name" maxlength="16" autocomplete="nickname" required value="${esc(savedName())}" placeholder="예: 민지" /></label>`;
  }

  /** Read + apply the dialog's name field; false (and a hint) if empty. */
  private takeName(box: HTMLElement): boolean {
    const input = box.querySelector<HTMLInputElement>('[data-id="pd-name"]');
    const name = input?.value.trim() ?? savedName();
    if (!name) { input?.focus(); return false; }
    this.setName(name);
    return true;
  }

  private openName(hint = ""): void {
    const box = this.openDialog("이름을 정해요", `
      ${hint ? `<p class="party-hint warn">${esc(hint)}</p>` : `<p class="party-hint">방에서 친구들에게 보이는 이름이에요.</p>`}
      ${this.nameField()}`, "확인");
    box.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!this.takeName(box)) return;
      const next = this.pending; this.pending = null;
      this.closeDialog();
      next?.(); // the rename reconnects; the client queues this until the new hello
    });
  }

  // ------------------------------------------------------------ dialogs

  private openDialog(title: string, body: string, submit: string): HTMLElement {
    this.closeDialog();
    const box = document.createElement("div");
    box.className = "party-dialog";
    box.innerHTML = `<form class="party-card" role="dialog" aria-label="${esc(title)}">
      <div class="party-card-head"><h3>${esc(title)}</h3><button type="button" class="party-x" aria-label="닫기">✕</button></div>
      ${body}
      <button class="party-go" type="submit">${esc(submit)} <span aria-hidden="true">→</span></button>
    </form>`;
    box.addEventListener("click", (e) => { if (e.target === box) this.closeDialog(); });
    box.querySelector(".party-x")!.addEventListener("click", () => this.closeDialog());
    this.root.appendChild(box);
    this.dialog = box;
    const first = box.querySelector<HTMLInputElement>("input[value='']") ?? box.querySelector<HTMLInputElement>("input:not([type=radio]):not([type=checkbox])");
    first?.focus();
    return box;
  }

  private closeDialog(): void {
    this.dialog?.remove();
    this.dialog = null;
    // a dialog closed without joining anything gives the socket back (after any answer it was waiting for)
    window.setTimeout(() => this.release(), 5000);
  }

  private gamePicker(selected: PartyGame, name = "game"): string {
    return `<div class="party-games" role="radiogroup" aria-label="게임">${GAME_CARDS.map((c) => c.game
      ? `<label class="party-game"><input type="radio" name="${name}" value="${c.game}" ${c.game === selected ? "checked" : ""} /><img src="${c.img}" alt="" /><b>${esc(c.name)}</b><small>${esc(c.note)}</small></label>`
      : `<span class="party-game soon" aria-disabled="true"><img src="${c.img}" alt="" /><b>${esc(c.name)}</b><small>${esc(c.note)}</small><i>${c.soon}</i></span>`).join("")}</div>`;
  }

  private openCreate(): void {
    const name = savedName();
    const box = this.openDialog("방 만들기", `
      ${this.nameField()}
      <label class="party-field"><span>방 이름</span><input data-id="pd-title" maxlength="20" required value="${esc(name ? `${name}의 방` : "")}" placeholder="예: 같이 블록 쌓자" /></label>
      <div class="party-field"><span>게임</span>${this.gamePicker("build")}</div>
      <div class="party-row2">
        <label class="party-field"><span>최대 인원</span><select data-id="pd-max">${maxOptions("build")}</select></label>
        <label class="party-switch"><input type="checkbox" data-id="pd-public" checked /><span>방 목록에 보이기</span><small>끄면 코드로만 들어와요</small></label>
      </div>`, "방 만들기");
    // each game holds its own number (Daily Tower 8, 함께 짓기 50): the choices follow the pick
    box.querySelectorAll<HTMLInputElement>('input[name="game"]').forEach((radio) => radio.addEventListener("change", () => {
      const select = box.querySelector<HTMLSelectElement>('[data-id="pd-max"]')!;
      const keep = Number(select.value);
      select.innerHTML = maxOptions(radio.value as PartyGame, keep);
    }));
    box.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!this.takeName(box)) return;
      const title = box.querySelector<HTMLInputElement>('[data-id="pd-title"]')!.value.trim() || `${this.client!.playerName}의 방`;
      const game = (box.querySelector<HTMLInputElement>('input[name="game"]:checked')?.value ?? "build") as PartyGame;
      const max = Number(box.querySelector<HTMLSelectElement>('[data-id="pd-max"]')!.value);
      const isPublic = box.querySelector<HTMLInputElement>('[data-id="pd-public"]')!.checked;
      this.connect().create(title, game, max, isPublic);
    });
  }

  private openCode(): void {
    const box = this.openDialog("코드로 입장", `
      ${this.nameField()}
      <label class="party-field"><span>방 코드</span><input data-id="pd-code" class="party-code-input" maxlength="6" required autocomplete="off" placeholder="예: K7MXQ2" /></label>
      <p class="party-hint">방장 화면 위쪽에 있는 6자리 코드예요.</p>`, "입장하기");
    const code = box.querySelector<HTMLInputElement>('[data-id="pd-code"]')!;
    code.addEventListener("input", () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
    box.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!this.takeName(box)) return;
      if (code.value.length !== 6) { code.focus(); return; }
      this.connect().send({ t: "p-join", code: code.value });
    });
  }

  // ------------------------------------------------------------ waiting room

  private renderWaiting(): void {
    const room = this.room!;
    const me = room.members.find((m) => m.id === this.me);
    const host = room.host === this.me;
    if (!this.waiting) {
      this.waiting = document.createElement("div");
      this.waiting.className = "party-wait";
      this.waiting.innerHTML = `<div class="party-wait-card" role="dialog" aria-label="대기실">
        <header class="party-wait-head">
          <button type="button" class="hub-back party-leave" data-id="pw-leave"><svg><use href="#hub-i-chevron" /></svg>나가기</button>
          <div class="party-wait-title"><b data-id="pw-title"></b><small data-id="pw-sub"></small></div>
          <button type="button" class="party-code-chip" data-id="pw-code" title="눌러서 복사"></button>
        </header>
        <div class="party-wait-body">
          <section class="party-slots" data-id="pw-slots" aria-label="참가자"></section>
          <aside class="party-wait-side">
            <div class="party-wait-game" data-id="pw-game"></div>
            <div class="party-chat">
              <ul class="party-chat-log" data-id="pw-log" aria-live="polite"></ul>
              <form class="party-chat-form" data-id="pw-chat"><input maxlength="120" placeholder="채팅을 입력해요" autocomplete="off" /><button type="submit">보내기</button></form>
            </div>
          </aside>
        </div>
        <footer class="party-wait-foot" data-id="pw-foot"></footer>
      </div>`;
      this.root.appendChild(this.waiting);
      const w = this.waiting;
      w.querySelector('[data-id="pw-leave"]')!.addEventListener("click", () => this.connect().leave());
      w.querySelector('[data-id="pw-code"]')!.addEventListener("click", () => {
        void navigator.clipboard?.writeText(this.room?.code ?? "").then(() => this.toast("방 코드를 복사했어요."), () => {});
      });
      w.querySelector<HTMLFormElement>('[data-id="pw-chat"]')!.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = (e.target as HTMLFormElement).querySelector("input")!;
        const text = input.value.trim();
        if (text) this.connect().send({ t: "p-chat", text });
        input.value = "";
      });
      w.addEventListener("click", (e) => this.onWaitClick(e));
      w.addEventListener("change", (e) => {
        const input = e.target as HTMLInputElement;
        if (input.name === "pw-game" && this.room?.host === this.me) this.connect().send({ t: "p-set", game: input.value as PartyGame });
        if (input.dataset.id === "pw-public") this.connect().send({ t: "p-set", public: input.checked });
      });
    }
    const w = this.waiting;
    w.querySelector('[data-id="pw-title"]')!.textContent = room.title;
    w.querySelector('[data-id="pw-sub"]')!.textContent = `${room.public ? "공개 방" : "비공개 방"} · ${room.members.length}/${room.max}명`;
    w.querySelector('[data-id="pw-code"]')!.innerHTML = `<small>방 코드</small><b>${esc(room.code)}</b>`;
    const slots = w.querySelector<HTMLElement>('[data-id="pw-slots"]')!;
    if (room.max > 8) {
      // a big room (up to 50): one compact row per player, connected first, host on top
      slots.classList.add("big");
      const order = [...room.members].sort((a, b) => Number(b.id === room.host) - Number(a.id === room.host) || Number(b.online) - Number(a.online));
      const ready = room.members.filter((m) => m.ready || m.id === room.host).length;
      slots.innerHTML = `<div class="party-roster-head"><b>참가자 ${room.members.length}/${room.max}</b><span>준비 ${ready}/${room.members.length}</span></div>
        <ul class="party-roster">${order.map((m) => {
          const isHost = m.id === room.host;
          const badge = isHost ? `<i class="party-badge host">방장</i>` : m.ready ? `<i class="party-badge ready">준비</i>` : `<i class="party-badge">대기</i>`;
          return `<li class="${m.id === this.me ? "me" : ""}${m.online ? "" : " away"}"><b>${esc(m.name)}${m.id === this.me ? " (나)" : ""}</b>${m.online ? "" : `<small>${room.state === "playing" ? "게임 중" : "자리 비움"}</small>`}${badge}${host && !isHost ? `<button type="button" class="party-kick" data-kick="${esc(m.id)}" aria-label="${esc(m.name)} 내보내기">✕</button>` : ""}</li>`;
        }).join("")}</ul>`;
    } else slots.classList.remove("big");
    // up to eight: seat cards, Crazy-Arcade style — seated players, then open seats
    if (room.max <= 8) slots.innerHTML = Array.from({ length: 8 }, (_, i) => {
      const m = room.members[i];
      if (i >= room.max) return `<div class="party-slot closed" aria-hidden="true"><span>닫힌 자리</span></div>`;
      if (!m) return `<div class="party-slot open"><span>빈자리</span></div>`;
      const isHost = m.id === room.host;
      const badge = isHost ? `<i class="party-badge host">방장</i>` : m.ready ? `<i class="party-badge ready">준비 완료</i>` : `<i class="party-badge">대기</i>`;
      return `<div class="party-slot${m.id === this.me ? " me" : ""}${m.ready || isHost ? " ready" : ""}${m.online ? "" : " away"}">
        <img src="/home/solo.webp" alt="" />
        <b>${esc(m.name)}${m.id === this.me ? " (나)" : ""}</b>
        ${badge}${m.online ? "" : `<small>${room.state === "playing" ? "게임 중" : "자리 비움"}</small>`}
        ${host && !isHost ? `<button type="button" class="party-kick" data-kick="${esc(m.id)}" aria-label="${esc(m.name)} 내보내기">✕</button>` : ""}
      </div>`;
    }).join("");
    // game choice: the host picks, everyone sees it
    w.querySelector('[data-id="pw-game"]')!.innerHTML = host && room.state === "waiting"
      ? `<h4>게임 고르기</h4>${this.gamePicker(room.game, "pw-game")}<label class="party-switch small"><input type="checkbox" data-id="pw-public" ${room.public ? "checked" : ""} /><span>방 목록에 보이기</span></label>`
      : `<h4>이번 게임</h4><div class="party-game picked"><img src="${GAME_CARDS.find((c) => c.game === room.game)!.img}" alt="" /><b>${esc(gameName(room.game))}</b><small>${host ? "" : "방장이 골라요"}</small></div>`;
    // the main action
    const foot = w.querySelector<HTMLElement>('[data-id="pw-foot"]')!;
    if (room.state === "playing") {
      foot.innerHTML = `<p class="party-playing">🎮 ${esc(gameName(room.game))} 게임이 진행 중이에요</p>
        ${host ? `<button type="button" class="party-ghost" data-act="stop">게임 끝내기</button>` : ""}
        <button type="button" class="party-big" data-act="enter">▶ 게임으로 들어가기</button>`;
    } else if (host) {
      const others = room.members.filter((m) => m.id !== room.host && m.online);
      const ready = others.every((m) => m.ready);
      foot.innerHTML = `<p class="party-hint">${others.length === 0 ? "혼자서도 시작할 수 있어요. 친구에게 방 코드를 알려 주세요!" : ready ? "모두 준비됐어요!" : `준비한 친구 ${others.filter((m) => m.ready).length}/${others.length}`}</p>
        <button type="button" class="party-big" data-act="start" ${ready ? "" : "disabled"}>▶ 게임 시작</button>`;
    } else {
      foot.innerHTML = `<p class="party-hint">${me?.ready ? "방장이 시작하기를 기다려요" : "준비를 누르면 방장이 시작할 수 있어요"}</p>
        <button type="button" class="party-big${me?.ready ? " on" : ""}" data-act="ready">${me?.ready ? "준비 취소" : "준비"}</button>`;
    }
  }

  private onWaitClick(e: Event): void {
    const t = e.target as HTMLElement;
    const kick = t.closest<HTMLElement>("[data-kick]")?.dataset.kick;
    if (kick) return void this.connect().send({ t: "p-kick", id: kick });
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    const room = this.room;
    if (!act || !room) return;
    if (act === "start") this.connect().send({ t: "p-start" });
    else if (act === "stop") this.connect().send({ t: "p-stop" });
    else if (act === "enter") this.launch(room.game, room.code);
    else if (act === "ready") {
      const me = room.members.find((m) => m.id === this.me);
      this.connect().send({ t: "p-ready", ready: !me?.ready });
    }
  }

  private addChat(name: string, text: string, system: boolean): void {
    const log = this.waiting?.querySelector<HTMLElement>('[data-id="pw-log"]');
    if (!log) return;
    const li = document.createElement("li");
    li.className = system ? "system" : "";
    if (system) li.textContent = text;
    else { const b = document.createElement("b"); b.textContent = `${name}: `; li.append(b, document.createTextNode(text)); }
    log.appendChild(li);
    while (log.children.length > 60) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  }

  private closeWaiting(): void {
    this.waiting?.remove();
    this.waiting = null;
  }

  private toast(text: string): void {
    const el = document.querySelector<HTMLElement>(".hub-toast");
    if (!el) return;
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove("show"), 2600);
  }

  dispose(): void {
    this.client?.close();
    this.closeDialog();
    this.closeWaiting();
  }
}

/** A seat from before (back from a game): the hub should open straight onto the rooms. */
export function hasPartySeat(): boolean {
  return savedSeat() !== null;
}
