import {
  CLASS_PROTOCOL_VERSION,
  classKey,
  decodeClassServer,
  type ClassClientMessage,
  type ClassEdit,
  type ClassErrorCode,
  type ClassMember,
  type ClassRole,
  type ClassServerMessage,
  type ClassSettings,
} from "@robo/shared";

export type ClassJoin =
  | { role: "teacher"; teacher: string; password?: string }
  | { role: "student"; teacher: string; student: string };

/** Everything the game needs at the moment it enters the class. */
export interface ClassSession {
  you: string;
  role: ClassRole;
  teacher: string;
  members: ClassMember[];
  settings: ClassSettings;
  /** The shared field as it stands, absolute coordinates. */
  edits: ClassEdit[];
}

export const CLASS_ERROR_TEXT: Record<ClassErrorCode | "offline", string> = {
  "bad-version": "새 버전이 있어요. 페이지를 새로고침 해주세요.",
  "no-class": "그 이름으로 열린 반이 없어요. 선생님 이름을 확인하거나, 선생님이 반을 열 때까지 기다려 주세요.",
  "bad-password": "비밀번호가 맞지 않아요. (새 반을 만들 때는 4자 이상)",
  "teacher-taken": "이미 같은 이름으로 수업 중인 선생님이 있어요.",
  "name-taken": "이 반에 같은 이름의 학생이 이미 접속해 있어요.",
  "class-full": "반 정원이 가득 찼어요.",
  banned: "선생님이 내보내서 잠시 동안 들어갈 수 없어요.",
  "bad-name": "이름은 1~16자로 입력해주세요.",
  internal: "서버 오류가 났어요. 잠시 후 다시 시도해주세요.",
  offline: "서버에 연결할 수 없어요. 인터넷 연결을 확인해주세요.",
};

const RECONNECT_MAX_MS = 8000;

/** Remembers seat/host keys per class so a refresh keeps your place. */
function keyStoreName(join: ClassJoin): string {
  const who = join.role === "teacher" ? "teacher" : `student:${classKey(join.student)}`;
  return `craftyap-class:${classKey(join.teacher)}:${who}`;
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
  onReject: ((edits: ClassEdit[]) => void) | null = null;
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
  private pending: { session: ClassSession; expected: number } | null = null;
  private first: { resolve: (s: ClassSession) => void; reject: (code: ClassErrorCode | "offline") => void } | null =
    null;

  constructor(readonly join: ClassJoin) {}

  private get url(): string {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws?mode=class`;
  }

  connect(): Promise<ClassSession> {
    return new Promise((resolve, reject) => {
      this.first = { resolve, reject };
      this.open();
    });
  }

  send(msg: ClassClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Leave for good (teacher's "end class" goes through send first). */
  close(): void {
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close(1000, "left");
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      const key = loadKey(this.join);
      this.send(
        this.join.role === "teacher"
          ? { t: "k-host", v: CLASS_PROTOCOL_VERSION, teacher: this.join.teacher, password: this.join.password, hostKey: key }
          : { t: "k-join", v: CLASS_PROTOCOL_VERSION, teacher: this.join.teacher, student: this.join.student, seatKey: key },
      );
    };
    ws.onmessage = (e) => {
      const msg = decodeClassServer(e.data);
      if (msg) this.receive(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
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
      this.timer = setTimeout(() => this.open(), delay);
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
            teacher: msg.teacher,
            members: msg.members,
            settings: msg.settings,
            edits: [],
          },
          expected: msg.editCount,
        };
        this.maybeReady();
        return;
      case "s-k-world":
        this.pending?.session.edits.push(...msg.edits);
        this.maybeReady();
        return;
      case "s-k-error": {
        const fatal = this.first;
        this.ended = true;
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
        this.ended = true;
        // the class is saved: keep the key so the next lesson re-opens /
        // re-joins in one step. A kicked seat is gone, so forget it.
        if (msg.t === "s-k-kicked") storeKey(this.join, null);
        this.onEnded?.(msg.t === "s-k-kicked" ? "kicked" : "closed");
        return;
    }
    if (this.pending) return; // still loading the world
    switch (msg.t) {
      case "s-k-members":
        this.onMembers?.(msg.members);
        return;
      case "s-k-snap":
        this.onSnap?.(msg.players);
        return;
      case "s-k-edit":
        this.onEdit?.(msg.edits, msg.by);
        return;
      case "s-k-reject":
        this.onReject?.(msg.edits);
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
    if (this.first) {
      this.first.resolve(p.session);
      this.first = null;
    } else {
      this.onConnection?.(true);
      this.onResync?.(p.session);
    }
  }
}
