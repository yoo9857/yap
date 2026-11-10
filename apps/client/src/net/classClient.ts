import {
  CLASS_PROTOCOL_VERSION,
  classKey,
  decodeClassServer,
  type ClassClientMessage,
  type ClassEdit,
  type ClassWet,
  type ClassFurniture,
  type ClassErrorCode,
  type ClassMember,
  type ClassRole,
  type ClassServerMessage,
  type ClassSettings,
} from "@robo/shared";
import { t } from "../ui/i18n.js";

export type ClassJoin =
  | { role: "teacher"; room: string; teacher: string; password?: string }
  | { role: "student"; room: string; student: string };

/** What `peekClass` learns about a class name before joining it. */
export interface ClassPeek {
  room: string;
  exists: boolean;
  open: boolean;
  teacher?: string;
}

/** Everything the game needs at the moment it enters the class. */
export interface ClassSession {
  you: string;
  role: ClassRole;
  room: string;
  teacher: string;
  members: ClassMember[];
  settings: ClassSettings;
  /** The shared field as it stands, absolute coordinates. */
  edits: ClassEdit[];
  furniture: ClassFurniture[];
}

/** Getters, so each message is in the player's language when it is shown (not when this module loads). */
export const CLASS_ERROR_TEXT: Record<ClassErrorCode | "offline", string> = {
  get "bad-version"() { return t("새 버전이 있어요. 페이지를 새로고침 해주세요.", "A new version is out. Please refresh the page."); },
  get "no-class"() { return t("그 이름의 반이 지금 열려 있지 않아요. 반 이름을 확인하거나, 선생님이 반을 열 때까지 기다려 주세요.", "No class is open under that name. Check the class name, or wait for the teacher to open it."); },
  get "bad-password"() { return t("비밀번호가 맞지 않아요. 여러 번 틀리면 잠시 동안 막혀요. (새 반을 만들 때는 4자 이상)", "Wrong password. Too many wrong tries lock the class for a while. (New classes need 4+ characters.)"); },
  get "teacher-taken"() { return t("이 반의 선생님이 이미 다른 곳에서 접속해 있어요.", "This class's teacher is already connected somewhere else."); },
  get "room-taken"() { return t("이 반 이름은 다른 선생님이 쓰고 있어요. 다른 반 이름을 정해주세요.", "Another teacher uses this class name. Please pick a different one."); },
  get "name-taken"() { return t("이 반에 같은 이름의 학생이 이미 접속해 있어요.", "A student with that name is already in this class."); },
  get "class-full"() { return t("반 정원이 가득 찼어요.", "The class is full."); },
  get banned() { return t("선생님이 내보내서 잠시 동안 들어갈 수 없어요.", "The teacher removed you, so you can't rejoin for a little while."); },
  get "bad-name"() { return t("반 이름은 1~20자, 이름은 1~16자로 입력해주세요.", "Class names are 1–20 characters, your name 1–16."); },
  get internal() { return t("서버 오류가 났어요. 잠시 후 다시 시도해주세요.", "Something went wrong on the server. Please try again in a moment."); },
  get offline() { return t("서버에 연결할 수 없어요. 인터넷 연결을 확인해주세요.", "Can't reach the server. Please check your internet connection."); },
};

/** The one-shot password a version reload carries (sessionStorage, read once, then gone). */
const RELOAD_PASS = "craftyap-class-reload-pass";
export function takeReloadPassword(): string | undefined {
  try {
    const pass = sessionStorage.getItem(RELOAD_PASS) ?? undefined;
    sessionStorage.removeItem(RELOAD_PASS);
    return pass;
  } catch {
    return undefined;
  }
}

/**
 * A deploy that changes CLASS_PROTOCOL_VERSION restarts the server; every open
 * classroom tab reconnects with the old page and is refused "bad-version".
 * Reload straight back into the same class instead of showing an error: the
 * seat / host key is in localStorage, so the class name and your name are all
 * the link needs (never the password). Once per minute, so a mismatched cache
 * cannot loop.
 */
export function reloadIntoClass(join: ClassJoin): boolean {
  const GUARD = "craftyap-class-version-reload";
  try {
    const last = Number(sessionStorage.getItem(GUARD) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(GUARD, String(Date.now()));
  } catch {
    return false;
  }
  const p = new URLSearchParams({ mode: "field", room: join.room });
  // A teacher without a stored host key (a new class, another PC) gets in only by password:
  // carry it across this one reload in sessionStorage — never in the URL.
  if (join.role === "teacher" && join.password) {
    try { sessionStorage.setItem(RELOAD_PASS, join.password); } catch { /* the teacher types it again */ }
  }
  if (join.role === "teacher") p.set("host", join.teacher);
  else p.set("student", join.student);
  const lang = new URLSearchParams(location.search).get("lang");
  if (lang) p.set("lang", lang);
  location.replace(`${location.pathname}?${p.toString()}`);
  return true;
}

const RECONNECT_MAX_MS = 8000;
/** After a server restart the class is back only once its teacher reconnects: students keep
 *  trying ("no-class") this many times (~3 minutes at the 8 s cap) instead of ending. */
const WAIT_FOR_TEACHER_TRIES = 25;
/** A link silent for this many keepalive periods is dead (Wi-Fi switch, laptop lid): drop and reconnect. */
const KEEPALIVE_MISSES = 5;
const LOAD_IDLE_MS = 10_000;
const LOAD_TOTAL_MS = 120_000;

/** Remembers seat/host keys per class so a refresh keeps your place.
 *  Keyed by class NAME; classes from before named classes were keyed by the
 *  teacher's name, which is now their class name, so old keys still match. */
function keyStoreName(join: ClassJoin): string {
  const who = join.role === "teacher" ? "teacher" : `student:${classKey(join.student)}`;
  return `craftyap-class:${classKey(join.room)}:${who}`;
}

/** The class name rides in the URL too: a sharded server routes the socket to the one process
 *  that holds this class before reading a single message (server cluster/directory.ts). */
function classSocketUrl(room: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws?mode=class&room=${encodeURIComponent(room)}`;
}

/** A first connection refused 1013 "busy" (a full server, or the few seconds of a zero-downtime
 *  deploy's hand-over) is tried again this many times, this far apart, before it counts as offline. */
const BUSY_RETRIES = 20;
const BUSY_WAIT_MS = 1200; // 20 × 1.2 s ≈ 24 s: longer than a deploy's hand-over (old container's stop ≤ ~20 s)

/**
 * Ask the server whose class a class name is, without joining: a student sees
 * "김선생 선생님의 햇살반" and confirms before walking in. Rejects with
 * "offline" or "bad-version".
 */
export function peekClass(room: string, busyLeft = BUSY_RETRIES): Promise<ClassPeek> {
  return new Promise((resolve, rejectWith) => {
    // rejects with a code, like connect() — the lobby maps codes to messages
    const reject: (code: ClassErrorCode | "offline") => void = rejectWith;
    const ws = new WebSocket(classSocketUrl(room));
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      ws.close();
    };
    const timer = setTimeout(() => finish(() => reject("offline")), 6000);
    ws.onopen = () => ws.send(JSON.stringify({ t: "k-peek", v: CLASS_PROTOCOL_VERSION, room } satisfies ClassClientMessage));
    ws.onmessage = (e) => {
      const msg = decodeClassServer(e.data);
      if (msg?.t === "s-k-room") finish(() => resolve({ room: msg.room, exists: msg.exists, open: msg.open, teacher: msg.teacher }));
      else if (msg?.t === "s-k-error") finish(() => reject(msg.code));
    };
    ws.onclose = (e) => {
      // 1013 "busy": the server is full for a moment or a deploy is handing over — ask again shortly
      if (!settled && e.reason === "busy" && busyLeft > 0) {
        settled = true;
        clearTimeout(timer);
        setTimeout(() => void peekClass(room, busyLeft - 1).then(resolve, rejectWith), BUSY_WAIT_MS);
        return;
      }
      finish(() => reject("offline"));
    };
  });
}
function loadKey(join: ClassJoin): string | undefined {
  try {
    return localStorage.getItem(keyStoreName(join)) ?? undefined;
  } catch {
    return undefined;
  }
}
function storeKey(join: ClassJoin, key: string | null): void {
  try {
    if (key) localStorage.setItem(keyStoreName(join), key);
    else localStorage.removeItem(keyStoreName(join));
  } catch {
    /* unavailable — a refresh just asks again */
  }
}

/**
 * The classroom link. `connect()` resolves once the welcome AND the whole
 * shared field have arrived (or rejects with an error code). After that the
 * socket reconnects by itself with the stored key; each re-welcome is handed
 * to `onResync` so the game can replace its field with the server's.
 */
/** The lesson's state as the game uses it (F2 → 모두 멈춰 / 타이머). */
export interface ClassLesson {
  frozen: boolean;
  /** `performance.now()` ms when the countdown ends, or null (no timer). */
  timerEnd: number | null;
  /** The countdown's whole length (ms), for its progress ring. */
  timerTotal: number;
}

export class ClassClient {
  onMembers: ((members: ClassMember[]) => void) | null = null;
  /** `ts`: the server's stamp (ms) for interpolation; undefined from older servers. */
  onSnap: ((players: Extract<ClassServerMessage, { t: "s-k-snap" }>["players"], ts?: number) => void) | null = null;
  onEdit: ((edits: ClassEdit[], by: string) => void) | null = null;
  /** Water inside shaped blocks changed (server flow, a join's whole layer, a refused edit's cells). */
  onWet: ((cells: ClassWet[]) => void) | null = null;
  onFurniture: ((items: ClassFurniture[], rejected: boolean) => void) | null = null;
  onReject: ((edits: ClassEdit[], authoritative: boolean) => void) | null = null;
  onChat: ((msg: Extract<ClassServerMessage, { t: "s-k-chat" }>) => void) | null = null;
  /** The teacher called us: fan out around `pos`, or with `yaw`, stand exactly there facing that way (a seat). */
  onGather: ((pos: [number, number, number], yaw?: number, nudge?: boolean) => void) | null = null;
  /** The class seating changed (or arrived on join): every seat's student, spot and heading. */
  onSeats: ((seats: { name: string; pos: [number, number, number]; yaw: number }[], roam: boolean) => void) | null = null;
  onBonk: ((msg: Extract<ClassServerMessage, { t: "s-k-bonk" }>) => void) | null = null;
  /** The lesson's state (F2): students frozen, and the timer as a deadline on OUR clock
   *  (`performance.now()` ms, measured from when the message arrived — a replay after loading
   *  does not restart it), or null. */
  onLesson: ((lesson: ClassLesson) => void) | null = null;
  /** The teacher's announcement (big, mid-screen). */
  onAnnounce: ((text: string) => void) | null = null;
  /** When each s-k-lesson arrived (it may be replayed seconds later, after the field loaded). */
  private readonly arrivedAt = new WeakMap<object, number>();
  onSettings: ((settings: ClassSettings) => void) | null = null;
  onResync: ((session: ClassSession) => void) | null = null;
  onWorldReset: (() => void) | null = null;
  onWaterDrained: (() => void) | null = null;
  /** Kicked, class ended, seat lost for good, or this seat opened in another tab — the session is over. */
  onEnded: ((reason: "kicked" | "closed" | "replaced" | ClassErrorCode) => void) | null = null;
  onConnection: ((online: boolean) => void) | null = null;

  private ws: WebSocket | null = null;
  private ended = false;
  private attempts = 0;
  /** First connection only: "busy" refusals still allowed before giving up (BUSY_RETRIES). */
  private busyLeft = BUSY_RETRIES;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private loadStarted = 0;
  private started = false;
  private active = false;
  private early: ClassServerMessage[] = [];
  private earlyEdits = 0;
  private replacedWhileLoading = false;
  private terminal: Extract<ClassServerMessage, { t: "s-k-error" | "s-k-kicked" | "s-k-closed" }> | null = null;
  private pending: { session: ClassSession; expected: number } | null = null;
  /** A reconnect that finished before the game called `activate()`: handed to onResync then. */
  private resynced: ClassSession | null = null;
  /** The server's keepalive promise (s) and when we last heard anything; null = no watchdog. */
  private keepalive: number | null = null;
  private heardAt = 0;
  private aliveTimer: ReturnType<typeof setInterval> | null = null;
  private first: { resolve: (s: ClassSession) => void; reject: (code: ClassErrorCode | "offline") => void } | null =
    null;

  constructor(readonly join: ClassJoin) {}

  private get url(): string {
    return classSocketUrl(this.join.room);
  }

  connect(): Promise<ClassSession> {
    if (this.started || this.ended) return Promise.reject(new Error("ClassClient is already started or closed"));
    this.started = true;
    return new Promise((resolve, reject) => {
      this.first = { resolve, reject };
      this.open();
    });
  }

  get connected(): boolean { return !this.ended && this.ws?.readyState === WebSocket.OPEN && !this.pending && !this.first; }

  send(msg: ClassClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    if (this.ws.bufferedAmount > 256 * 1024) { this.ws.close(1000, "backpressure"); return false; }
    this.ws.send(JSON.stringify(msg)); return true;
  }

  /** The game has installed its handlers and initial field. Reliable messages
   *  received during streaming/module/graphics setup now replay in order. */
  activate(): void {
    this.active = true;
    if (this.replacedWhileLoading) { this.replacedWhileLoading = false; this.onEnded?.("replaced"); return; }
    if (this.terminal) { const msg = this.terminal; this.terminal = null; this.receive(msg); return; }
    // the link dropped and came back while the game was still loading: its field, not the first one, is current
    const fresh = this.resynced;
    this.resynced = null;
    if (fresh) { this.onConnection?.(true); this.onResync?.(fresh); }
    if (!this.pending) this.drainEarly();
  }

  private drainEarly(): void {
    const messages = this.early; this.early = []; this.earlyEdits = 0;
    for (const msg of messages) this.receive(msg);
  }

  private clearLoadTimer(): void {
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = null;
  }

  private armLoadTimer(ws: WebSocket): void {
    this.clearLoadTimer();
    this.loadTimer = setTimeout(() => {
      if (this.ws === ws && !this.ended) ws.close(1000, "world load timeout");
    }, Math.max(1, Math.min(LOAD_IDLE_MS, this.loadStarted + LOAD_TOTAL_MS - Date.now())));
  }

  /** Leave for good (teacher's "end class" goes through send first). */
  close(): void {
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.clearLoadTimer(); this.stopWatchdog(); this.pending = null; this.resynced = null; this.early = []; this.earlyEdits = 0; this.terminal = null; this.replacedWhileLoading = false;
    this.first?.reject("offline"); this.first = null;
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(1000, "left"); }
    this.onMembers = this.onSnap = this.onEdit = this.onWet = this.onFurniture = this.onReject = this.onChat = null;
    this.onLesson = this.onAnnounce = null;
    this.onGather = this.onSeats = this.onBonk = this.onSettings = this.onResync = this.onWorldReset = this.onWaterDrained = this.onEnded = this.onConnection = null;
  }

  /** Any message proves the link alive; silence past the server's promise means it is not. */
  private startWatchdog(ws: WebSocket): void {
    this.stopWatchdog();
    if (!this.keepalive) return;
    const limit = this.keepalive * KEEPALIVE_MISSES * 1000;
    this.aliveTimer = setInterval(() => {
      if (this.ws !== ws || this.ended) { this.stopWatchdog(); return; }
      if (Date.now() - this.heardAt <= limit) return;
      // A half-open link (Wi-Fi switch, lid closed) never answers the close handshake, so its
      // onclose can be minutes away: cut it loose and reconnect now.
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
      try { ws.close(1000, "keepalive timeout"); } catch { /* already closing */ }
      this.lost(ws, "keepalive timeout");
    }, 1000);
  }

  private stopWatchdog(): void {
    if (this.aliveTimer) clearInterval(this.aliveTimer);
    this.aliveTimer = null;
  }

  private open(): void {
    if (this.ended) return;
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); }
    catch { this.first?.reject("offline"); this.first = null; this.ended = true; return; }
    this.ws = ws;
    this.loadStarted = Date.now(); this.armLoadTimer(ws);
    ws.onopen = () => {
      if (this.ws !== ws || this.ended) return;
      const key = loadKey(this.join);
      this.send(
        this.join.role === "teacher"
          ? { t: "k-host", v: CLASS_PROTOCOL_VERSION, room: this.join.room, teacher: this.join.teacher, password: this.join.password, hostKey: key }
          : { t: "k-join", v: CLASS_PROTOCOL_VERSION, room: this.join.room, student: this.join.student, seatKey: key },
      );
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || this.ended) return;
      this.heardAt = Date.now();
      const msg = decodeClassServer(e.data);
      if (msg) {
        this.receive(msg);
        if (msg.t === "s-k-welcome") this.startWatchdog(ws);
      }
    };
    ws.onclose = (event) => this.lost(ws, event.reason);
  }

  /** The socket is gone (closed, or declared dead by the watchdog): end, or reconnect. */
  private lost(ws: WebSocket, reason: string): void {
    if (this.ws !== ws) return;
    this.ws = null; this.clearLoadTimer(); this.stopWatchdog(); this.pending = null; this.early = []; this.earlyEdits = 0;
    // Our seat was taken over by our own key (the same class opened in another tab). Reconnecting
    // with that key would take it back, and the other tab would do the same, forever.
    if (reason === "replaced" && !this.first) {
      this.ended = true;
      this.resynced = null;
      if (this.active) this.onEnded?.("replaced");
      else this.replacedWhileLoading = true; // told at activate(), with the right card
      return;
    }
    if (this.first && reason === "busy" && this.busyLeft > 0) {
      // refused "try again later" (a deploy handing over, a full server): not offline — ask again
      this.busyLeft--;
      this.timer = setTimeout(() => { this.timer = null; this.open(); }, BUSY_WAIT_MS * (0.75 + Math.random() * 0.5));
      return;
    }
    if (this.first) {
      // never got in: report instead of retrying blindly
      this.first.reject("offline");
      this.first = null;
      this.ended = true;
      return;
    }
    if (this.ended) return;
    this.onConnection?.(false);
    const delay = Math.min(RECONNECT_MAX_MS, 500 * 2 ** this.attempts++) * (0.75 + Math.random() * 0.5);
    this.timer = setTimeout(() => { this.timer = null; this.open(); }, delay);
  }

  private receive(msg: ClassServerMessage): void {
    switch (msg.t) {
      case "s-k-welcome":
        storeKey(this.join, msg.key);
        this.attempts = 0;
        this.keepalive = msg.keepalive ?? null;
        this.pending = {
          session: {
            you: msg.you,
            role: msg.role,
            room: msg.room,
            teacher: msg.teacher,
            members: msg.members,
            settings: msg.settings,
            edits: [],
            furniture: msg.furniture,
          },
          expected: msg.editCount,
        };
        this.maybeReady();
        return;
      case "s-k-world":
        this.pending?.session.edits.push(...msg.edits);
        if (this.ws && this.pending) this.armLoadTimer(this.ws);
        this.maybeReady();
        return;
      case "s-k-error": {
        if (msg.code === "bad-version" && reloadIntoClass(this.join)) {
          this.ended = true;
          return;
        }
        // A lost teacher transport can outlive the browser's socket briefly.
        // Fresh duplicate tabs still fail immediately; an existing session
        // retries while the heartbeat retires its old transport.
        // A student's "no-class" after a server restart lasts until the teacher's tab reconnects
        // and re-opens the class: wait for it (the HUD says "reconnecting") rather than ending.
        const transientSeat = this.join.role === "teacher" && msg.code === "teacher-taken" && this.attempts < 8 ||
          this.join.role === "student" && msg.code === "no-class" && this.attempts < WAIT_FOR_TEACHER_TRIES;
        if (!this.first && transientSeat) {
          this.ws?.close(1000, "retry seat"); return;
        }
        if (!this.active) this.terminal = msg;
        const fatal = this.first;
        this.ended = true;
        this.clearLoadTimer(); this.pending = null; this.early = []; this.earlyEdits = 0;
        // a stale key (seat gone, password changed) should not stick around
        if (msg.code === "bad-password" || msg.code === "name-taken") storeKey(this.join, null);
        if (fatal) {
          fatal.reject(msg.code);
          this.first = null;
        } else this.onEnded?.(msg.code);
        return;
      }
      case "s-k-kicked":
      case "s-k-closed":
        if (!this.active) this.terminal = msg;
        this.ended = true;
        this.clearLoadTimer(); this.pending = null; this.early = []; this.earlyEdits = 0;
        // the class is saved: keep the key so the next lesson re-opens /
        // re-joins in one step. A kicked seat is gone, so forget it.
        if (msg.t === "s-k-kicked") storeKey(this.join, null);
        if (this.first) { this.first.reject(msg.t === "s-k-kicked" ? "banned" : "no-class"); this.first = null; }
        else this.onEnded?.(msg.t === "s-k-kicked" ? "kicked" : "closed");
        return;
    }
    if (msg.t === "s-k-lesson") this.arrivedAt.set(msg, performance.now());
    if (this.pending || !this.active) {
      if (msg.t === "s-k-snap" || msg.t === "s-k-bonk") return;
      this.earlyEdits += msg.t === "s-k-edit" || msg.t === "s-k-reject" ? msg.edits.length
        : msg.t === "s-k-wet" ? msg.cells.length : msg.t === "s-k-furniture" ? msg.furniture.length : 0;
      this.early.push(msg);
      if (this.early.length >= 1024 || this.earlyEdits > 65_536) {
        // A class with running water sends edits all the time, so a slow first load used to
        // overflow here, reconnect, load again and overflow again forever. Water rewrites the
        // same cells, so keeping only the latest value per cell usually fits; only a backlog
        // that is still too big after that is worth a fresh resync.
        this.compactEarly();
        if (this.early.length >= 1024 || this.earlyEdits > 65_536) this.ws?.close(1000, "resync backlog");
      }
      return;
    }
    switch (msg.t) {
      case "s-k-members":
        this.onMembers?.(msg.members);
        return;
      case "s-k-snap":
        this.onSnap?.(msg.players, msg.ts);
        return;
      case "s-k-furniture":
        this.onFurniture?.(msg.furniture, msg.rejected ?? false);
        return;
      case "s-k-edit":
        this.onEdit?.(msg.edits, msg.by);
        return;
      case "s-k-wet":
        this.onWet?.(msg.cells);
        return;
      case "s-k-reject":
        this.onReject?.(msg.edits, msg.authoritative === true);
        return;
      case "s-k-chat":
        this.onChat?.(msg);
        return;
      case "s-k-gather":
        this.onGather?.(msg.pos, msg.yaw, msg.nudge === true);
        break;
      case "s-k-seats":
        this.onSeats?.(msg.seats, msg.roam === true);
        return;
      case "s-k-lesson": {
        const at = this.arrivedAt.get(msg) ?? performance.now();
        this.onLesson?.({
          frozen: msg.frozen === true,
          timerEnd: msg.timerLeft !== undefined ? at + msg.timerLeft : null,
          timerTotal: msg.timerTotal ?? 0,
        });
        return;
      }
      case "s-k-announce":
        this.onAnnounce?.(msg.text);
        return;
      case "s-k-bonk":
        this.onBonk?.(msg);
        return;
      case "s-k-settings":
        this.onSettings?.(msg.settings);
        return;
      case "s-k-water-drained":
        this.onWaterDrained?.();
        return;
      case "s-k-world-reset":
        this.onWorldReset?.();
        return;
    }
  }

  /** Merge each run of consecutive s-k-edit messages from one author into one, last value per cell. Order across
   *  any other message (reset, reject, furniture) is kept, so replaying gives the same field. */
  private compactEarly(): void {
    const out: ClassServerMessage[] = [];
    let run: Map<string, ClassEdit> | null = null;
    let runBy = "";
    let edits = 0;
    const flush = () => {
      if (run) out.push({ t: "s-k-edit", by: runBy, edits: [...run.values()] });
      run = null;
    };
    for (const msg of this.early) {
      if (msg.t === "s-k-edit") {
        // one run per author: a classmate's bricks keep their name (and their sound), not water's ""
        if (run && runBy !== msg.by) flush();
        runBy = msg.by;
        run ??= new Map();
        for (const e of msg.edits) {
          const key = `${e[0]},${e[1]},${e[2]}`;
          run.delete(key); // re-insert so the map keeps the latest write's order
          run.set(key, e);
        }
        continue;
      }
      flush();
      out.push(msg);
    }
    flush();
    for (const msg of out) {
      edits += msg.t === "s-k-edit" || msg.t === "s-k-reject" ? msg.edits.length
        : msg.t === "s-k-wet" ? msg.cells.length : msg.t === "s-k-furniture" ? msg.furniture.length : 0;
    }
    this.early = out;
    this.earlyEdits = edits;
  }

  private maybeReady(): void {
    const p = this.pending;
    if (!p || p.session.edits.length < p.expected) return;
    this.pending = null;
    this.clearLoadTimer();
    if (this.first) {
      this.first.resolve(p.session);
      this.first = null;
    } else if (!this.active) {
      // nobody is listening yet (the game is still loading): keep it for activate()
      this.resynced = p.session;
    } else {
      this.onConnection?.(true);
      this.onResync?.(p.session);
    }
    if (this.active) this.drainEarly();
  }
}
