import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
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

/**
 * Upgrades /ws connections into Sessions, gates them behind c-hello (name +
 * protocol version), then hands them to the RoomManager. Dead sockets are
 * reaped by ws-level ping/pong.
 */
export function attachWsServer(
  httpServer: HttpServer,
  rooms: RoomManager,
  classes: ClassManager,
  parties: PartyManager,
  limits: ConnectionLimits = { perAddress: 200, total: 4000 },
): () => void {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: 8 * 1024, // largest legit frame is well under 1 KB
  });
  const sessions = new Set<Session>();
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
    // the education classroom shares the endpoint, selected by query
    const mode = new URL(req.url ?? "/", "http://x").searchParams.get("mode");
    if (mode === "class") {
      classes.accept(ws, address);
      return;
    }
    // the hub's rooms too
    if (mode === "party") {
      parties.accept(ws, address);
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
      if (msg.v !== PROTOCOL_VERSION) {
        session.send({ t: "s-error", code: "bad-version", msg: "please refresh the page" });
        session.close(1002, "bad protocol version");
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
  });

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

  return () => {
    clearInterval(heartbeat);
    for (const s of sessions) s.close(1001, "server shutting down");
    wss.close();
  };
}
