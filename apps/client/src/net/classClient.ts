import {
  CLASS_PROTOCOL_VERSION,
  classKey,
  decodeClassServer,
  type ClassClientMessage,
  type ClassEdit,
  type ClassFurniture,
  type ClassErrorCode,
  type ClassMember,
  type ClassRole,
  type ClassServerMessage,
  type ClassSettings,
} from "@robo/shared";

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

export const CLASS_ERROR_TEXT: Record<ClassErrorCode | "offline", string> = {
  "bad-version": "새 버전이 있어요. 페이지를 새로고침 해주세요.",
  "no-class": "그 이름의 반이 지금 열려 있지 않아요. 반 이름을 확인하거나, 선생님이 반을 열 때까지 기다려 주세요.",
  "bad-password": "비밀번호가 맞지 않아요. (새 반을 만들 때는 4자 이상)",
  "teacher-taken": "이 반의 선생님이 이미 다른 곳에서 접속해 있어요.",
  "room-taken": "이 반 이름은 다른 선생님이 쓰고 있어요. 다른 반 이름을 정해주세요.",
  "name-taken": "이 반에 같은 이름의 학생이 이미 접속해 있어요.",
  "class-full": "반 정원이 가득 찼어요.",
  banned: "선생님이 내보내서 잠시 동안 들어갈 수 없어요.",
  "bad-name": "반 이름은 1~20자, 이름은 1~16자로 입력해주세요.",
  internal: "서버 오류가 났어요. 잠시 후 다시 시도해주세요.",
  offline: "서버에 연결할 수 없어요. 인터넷 연결을 확인해주세요.",
};

const RECONNECT_MAX_MS = 8000;
const LOAD_IDLE_MS = 10_000;
const LOAD_TOTAL_MS = 120_000;

/** Remembers seat/host keys per class so a refresh keeps your place.
 *  Keyed by class NAME; classes from before named classes were keyed by the
 *  teacher's name, which is now their class name, so old keys still match. */
function keyStoreName(join: ClassJoin): string {
  const who = join.role === "teacher" ? "teacher" : `student:${classKey(join.student)}`;
  return `craftyap-class:${classKey(join.room)}:${who}`;
}

function classSocketUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws?mode=class`;
}

/**
 * Ask the server whose class a class name is, without joining: a student sees
 * "김선생 선생님의 햇살반" and confirms before walking in. Rejects with
 * "offline" or "bad-version".
 */
export function peekClass(room: string): Promise<ClassPeek> {
  return new Promise((resolve, rejectWith) => {
    // rejects with a code, like connect() — the lobby maps codes to messages
    const reject: (code: ClassErrorCode | "offline") => void = rejectWith;
    const ws = new WebSocket(classSocketUrl());
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
    ws.onclose = () => finish(() => reject("offline"));
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
export class ClassClient {
  onMembers: ((members: ClassMember[]) => void) | null = null;
  onSnap: ((players: Extract<ClassServerMessage, { t: "s-k-snap" }>["players"]) => void) | null = null;
  onEdit: ((edits: ClassEdit[], by: string) => void) | null = null;
  onFurniture: ((items: ClassFurniture[], rejected: boolean) => void) | null = null;
  onReject: ((edits: ClassEdit[], authoritative: boolean) => void) | null = null;
  onChat: ((msg: Extract<ClassServerMessage, { t: "s-k-chat" }>) => void) | null = null;
  onGather: ((pos: [number, number, number]) => void) | null = null;
  onSettings: ((settings: ClassSettings) => void) | null = null;
  onResync: ((session: ClassSession) => void) | null = null;
  onWorldReset: (() => void) | null = null;
  /** Kicked, class ended, or seat lost for good — the session is over. */
  onEnded: ((reason: "kicked" | "closed" | ClassErrorCode) => void) | null = null;
  onConnection: ((online: boolean) => void) | null = null;

  private ws: WebSocket | null = null;
  private ended = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private loadStarted = 0;
  private started = false;
  private active = false;
  private early: ClassServerMessage[] = [];
  private earlyEdits = 0;
  private terminal: Extract<ClassServerMessage, { t: "s-k-error" | "s-k-kicked" | "s-k-closed" }> | null = null;
  private pending: { session: ClassSession; expected: number } | null = null;
  private first: { resolve: (s: ClassSession) => void; reject: (code: ClassErrorCode | "offline") => void } | null =
    null;

  constructor(readonly join: ClassJoin) {}

  private get url(): string {
    return classSocketUrl();
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
    if (this.terminal) { const msg = this.terminal; this.terminal = null; this.receive(msg); }
    else if (!this.pending) this.drainEarly();
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
    this.timer = null; this.clearLoadTimer(); this.pending = null; this.early = []; this.earlyEdits = 0; this.terminal = null;
    this.first?.reject("offline"); this.first = null;
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(1000, "left"); }
    this.onMembers = this.onSnap = this.onEdit = this.onFurniture = this.onReject = this.onChat = null;
    this.onGather = this.onSettings = this.onResync = this.onWorldReset = this.onEnded = this.onConnection = null;
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
      const msg = decodeClassServer(e.data);
      if (msg) this.receive(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null; this.clearLoadTimer(); this.pending = null; this.early = []; this.earlyEdits = 0;
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
    };
  }

  private receive(msg: ClassServerMessage): void {
    switch (msg.t) {
      case "s-k-welcome":
        storeKey(this.join, msg.key);
        this.attempts = 0;
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
        // A lost teacher transport can outlive the browser's socket briefly.
        // Fresh duplicate tabs still fail immediately; an existing session
        // retries while the heartbeat retires its old transport.
        const transientSeat = this.join.role === "teacher" && msg.code === "teacher-taken" ||
          this.join.role === "student" && msg.code === "no-class";
        if (!this.first && transientSeat && this.attempts < 8) {
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
    if (this.pending || !this.active) {
      if (msg.t === "s-k-snap") return;
      this.earlyEdits += msg.t === "s-k-edit" || msg.t === "s-k-reject" ? msg.edits.length
        : msg.t === "s-k-furniture" ? msg.furniture.length : 0;
      if (this.early.length >= 1024 || this.earlyEdits > 65_536) {
        this.ws?.close(1000, "resync backlog"); return;
      }
      this.early.push(msg); return;
    }
    switch (msg.t) {
      case "s-k-members":
        this.onMembers?.(msg.members);
        return;
      case "s-k-snap":
        this.onSnap?.(msg.players);
        return;
      case "s-k-furniture":
        this.onFurniture?.(msg.furniture, msg.rejected ?? false);
        return;
      case "s-k-edit":
        this.onEdit?.(msg.edits, msg.by);
        return;
      case "s-k-reject":
        this.onReject?.(msg.edits, msg.authoritative === true);
        return;
      case "s-k-chat":
        this.onChat?.(msg);
        return;
      case "s-k-gather":
        this.onGather?.(msg.pos);
        return;
      case "s-k-settings":
        this.onSettings?.(msg.settings);
        return;
      case "s-k-world-reset":
        this.onWorldReset?.();
        return;
    }
  }

  private maybeReady(): void {
    const p = this.pending;
    if (!p || p.session.edits.length < p.expected) return;
    this.pending = null;
    this.clearLoadTimer();
    if (this.first) {
      this.first.resolve(p.session);
      this.first = null;
    } else {
      this.onConnection?.(true);
      this.onResync?.(p.session);
    }
    if (this.active) this.drainEarly();
  }
}
