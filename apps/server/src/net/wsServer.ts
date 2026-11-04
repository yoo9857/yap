import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@robo/shared";
import { log } from "../log.js";
import type { RoomManager } from "../game/roomManager.js";
import type { ClassManager } from "../classroom/classManager.js";
import type { PartyManager } from "../party/partyManager.js";
import { Session } from "./session.js";

const HEARTBEAT_INTERVAL_MS = 10_000;
const HELLO_TIMEOUT_MS = 10_000;

/** Trust nginx's X-Real-IP only from a proxy on this machine / the docker bridge. */
const PRIVATE_PEER = /^(::1|127\.|::ffff:127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:10\.|::ffff:172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::ffff:192\.168\.)/;

/** The client's address: the socket peer, or nginx's X-Real-IP when the peer is the proxy. */
export function clientAddress(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "?";
  const forwarded = req.headers["x-real-ip"];
  return typeof forwarded === "string" && forwarded.length > 0 && forwarded.length <= 64 && PRIVATE_PEER.test(peer)
    ? forwarded
    : peer;
}

export interface ConnectionLimits {
  /** Open sockets per client address. A school shares ONE public IP, so this is per building, not per pupil. */
  perAddress: number;
  /** Open sockets for the whole process. */
  total: number;
}

/** Counts open sockets per address; `admit` refuses past either cap. Pure, so it is unit-tested. */
export class ConnectionGate {
  private readonly open = new Map<string, number>();
  private count = 0;
  constructor(private readonly limits: ConnectionLimits) {}
  admit(address: string): boolean {
    const mine = this.open.get(address) ?? 0;
    if (mine >= this.limits.perAddress || this.count >= this.limits.total) return false;
    this.open.set(address, mine + 1);
    this.count++;
    return true;
  }
  release(address: string): void {
    const mine = this.open.get(address) ?? 0;
    if (mine <= 0) return;
    if (mine === 1) this.open.delete(address); else this.open.set(address, mine - 1);
    this.count--;
  }
  get total(): number { return this.count; }
}

/** Hands an accepted socket to its game. One per process: the single server, or one per shard. */
export interface SocketHub {
  /** `url` is the request URL (mode/room/party live in its query). */
  accept(ws: WebSocket, url: string, address: string): void;
  close(): void;
}

export interface HubOptions {
  /** The hub's rooms, when they live in this process (single mode). Null on a cluster shard. */
  parties: PartyManager | null;
  /** Cluster shard: does this process own the tower room for this party code (undefined = public)? */
  ownsTower?: (party: string | undefined) => boolean;
}

/**
 * Gates tower sockets behind c-hello (name + protocol version) and hands them
 * to the RoomManager; class and party sockets go to their managers. Dead
 * sockets are reaped by ws-level ping/pong.
 */
export function createSocketHub(rooms: RoomManager, classes: ClassManager, options: HubOptions): SocketHub {
  const sessions = new Set<Session>();

  function accept(ws: WebSocket, url: string, address: string): void {
    // the education classroom shares the endpoint, selected by query
    const mode = new URL(url, "http://x").searchParams.get("mode");
    if (mode === "class") {
      classes.accept(ws, address);
      return;
    }
    // the hub's rooms too
    if (mode === "party") {
      if (options.parties) options.parties.accept(ws, address);
      else ws.close(1011, "no hub here");
      return;
    }
    const session = new Session(randomUUID().slice(0, 8), ws, address);
    sessions.add(session);
    log.info({ session: session.id, from: session.remoteAddress }, "connected");

    // must say hello within the timeout or go away
    const helloTimer = setTimeout(() => {
      session.close(1002, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    session.onMessage = (msg) => {
      if (msg.t !== "c-hello") return; // ignore anything sent before hello
      clearTimeout(helloTimer);
      // a page from before routing can reach the wrong shard: "refresh" brings a routed one
      const misrouted = options.ownsTower !== undefined && !options.ownsTower(msg.party);
      if (msg.v !== PROTOCOL_VERSION || misrouted) {
        session.send({ t: "s-error", code: "bad-version", msg: "please refresh the page" });
        session.close(1002, misrouted ? "wrong shard" : "bad protocol version");
        return;
      }
      try {
        rooms.assign(session, msg.name, msg.party); // replaces session.onMessage
      } catch (err) {
        log.error({ session: session.id, err }, "room assignment failed");
        session.send({ t: "s-error", code: "internal", msg: "join failed" });
        session.close(1011, "join failed");
      }
    };
    session.addCloseListener(() => {
      clearTimeout(helloTimer);
      sessions.delete(session);
    });
  }

  const heartbeat = setInterval(() => {
    for (const s of sessions) {
      if (!s.alive) {
        log.warn({ session: s.id }, "heartbeat missed twice — terminating");
        s.terminate();
        sessions.delete(s);
        continue;
      }
      s.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  return {
    accept,
    close() {
      clearInterval(heartbeat);
      for (const s of sessions) s.close(1001, "server shutting down");
    },
  };
}

/** `ws` options shared by every process that terminates game sockets. */
export const WS_OPTIONS = { maxPayload: 8 * 1024 } as const; // largest legit frame is well under 1 KB

/** Single-process mode: upgrade /ws on the HTTP server, gate it, hand it to the hub. */
export function attachWsServer(
  httpServer: HttpServer,
  hub: SocketHub,
  limits: ConnectionLimits = { perAddress: 200, total: 4000 },
): () => void {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws", ...WS_OPTIONS });
  const gate = new ConnectionGate(limits);

  wss.on("connection", (ws, req) => {
    const address = clientAddress(req);
    if (!gate.admit(address)) {
      // 1013 "try again later": both clients reconnect with backoff
      log.warn({ from: address, open: gate.total }, "connection refused: too many sockets");
      ws.close(1013, "busy");
      return;
    }
    ws.once("close", () => gate.release(address));
    hub.accept(ws, req.url ?? "/", address);
  });

  return () => {
    hub.close();
    wss.close();
  };
}
