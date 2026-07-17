import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "@robo/shared";
import { log } from "../log.js";
import type { RoomManager } from "../game/roomManager.js";
import { Session } from "./session.js";

const HEARTBEAT_INTERVAL_MS = 10_000;
const HELLO_TIMEOUT_MS = 10_000;

/**
 * Upgrades /ws connections into Sessions, gates them behind c-hello (name +
 * protocol version), then hands them to the RoomManager. Dead sockets are
 * reaped by ws-level ping/pong.
 */
export function attachWsServer(httpServer: HttpServer, rooms: RoomManager): () => void {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: 8 * 1024, // largest legit frame is well under 1 KB
  });
  const sessions = new Set<Session>();

  wss.on("connection", (ws, req) => {
    const session = new Session(randomUUID().slice(0, 8), ws, req.socket.remoteAddress ?? "?");
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
        rooms.assign(session, msg.name); // replaces session.onMessage
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
