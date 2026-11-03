import {
  PARTY_PROTOCOL_VERSION,
  decodePartyServer,
  type PartyClientMessage,
  type PartyGame,
  type PartyServerMessage,
} from "@robo/shared";

/** The seat to re-take after a page change (into a game and back): per tab, not per browser. */
const SEAT_KEY = "craftyap-party-seat";

export interface PartySeat {
  code: string;
  key: string;
}

export function savedSeat(): PartySeat | null {
  try {
    const raw = sessionStorage.getItem(SEAT_KEY);
    if (!raw) return null;
    const seat = JSON.parse(raw) as Partial<PartySeat>;
    return typeof seat.code === "string" && typeof seat.key === "string" ? { code: seat.code, key: seat.key } : null;
  } catch {
    return null;
  }
}

function storeSeat(seat: PartySeat | null): void {
  try {
    if (seat) sessionStorage.setItem(SEAT_KEY, JSON.stringify(seat));
    else sessionStorage.removeItem(SEAT_KEY);
  } catch {
    /* storage is optional: without it, coming back from a game shows the list */
  }
}

export type PartyStatus = "connecting" | "online" | "offline";

/**
 * The hub's connection to the rooms. Keeps the seat key in sessionStorage so
 * the page that comes back from a game re-takes its seat, and reconnects with
 * a backoff while the hub is open.
 */
export class PartyClient {
  onMessage: (msg: PartyServerMessage) => void = () => {};
  onStatus: (status: PartyStatus) => void = () => {};
  private ws: WebSocket | null = null;
  private retry = 0;
  private retryTimer = 0;
  private closed = false;
  private listing = false;
  /** Sent once the server has said hello: a click right after connecting (or a rename) is never lost. */
  private queue: PartyClientMessage[] = [];
  private ready = false;

  constructor(private name: string) {}

  connect(): void {
    this.closed = false;
    clearTimeout(this.retryTimer);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?mode=party`);
    this.ws = ws;
    this.ready = false;
    this.onStatus("connecting");
    ws.onopen = () => {
      this.retry = 0;
      const seat = savedSeat();
      ws.send(JSON.stringify({ t: "p-hello", v: PARTY_PROTOCOL_VERSION, name: this.name, ...(seat ? { seat } : {}) }));
    };
    ws.onmessage = (ev) => {
      const msg = decodePartyServer(ev.data);
      if (!msg) return;
      if (msg.t === "s-p-welcome") {
        this.ready = true;
        this.onStatus("online");
        const queued = this.queue;
        this.queue = [];
        for (const m of queued) ws.send(JSON.stringify(m));
        if (this.listing) ws.send(JSON.stringify({ t: "p-list" }));
      }
      if (msg.t === "s-p-room") storeSeat({ code: msg.room.code, key: msg.key });
      if (msg.t === "s-p-left") storeSeat(null);
      if (msg.t === "s-p-error" && msg.code === "bad-version") {
        this.closed = true; // a newer server: reload into it rather than retry forever
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onStatus("offline");
      if (this.closed) return;
      const wait = Math.min(8000, 500 * 2 ** this.retry++);
      this.retryTimer = window.setTimeout(() => this.connect(), wait);
    };
  }

  /** Change the nickname: reconnects so the server hears the new name (keeps the seat). */
  rename(name: string): void {
    if (name === this.name) return;
    this.name = name;
    const old = this.ws;
    this.ws = null;
    old?.close();
    // reconnect now (not after the backoff): anything sent meanwhile waits in the queue
    if (!this.closed) this.connect();
  }

  get playerName(): string {
    return this.name;
  }

  list(): void {
    this.listing = true;
    this.send({ t: "p-list" });
  }

  create(title: string, game: PartyGame, max: number, isPublic: boolean): void {
    this.send({ t: "p-create", title, game, max, public: isPublic });
  }

  send(msg: PartyClientMessage): void {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else if (msg.t !== "p-list") this.queue.push(msg); // p-list is re-sent on every hello anyway
  }

  /** Leave the room for good (the seat is given up). */
  leave(): void {
    storeSeat(null);
    this.send({ t: "p-leave" });
  }

  /** Close the link (moving into a game). The seat stays, for the way back. */
  close(): void {
    this.closed = true;
    this.queue = [];
    clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
  }
}
