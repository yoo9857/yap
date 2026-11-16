import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { PLAZA_CHANNEL_SIZE, PLAZA_PROTOCOL_VERSION, PLAZA_SPAWN, decodePlazaClient, type PlazaClientMessage, type PlazaPlayer, type PlazaServerMessage } from "@robo/shared";

export interface PlazaTransport {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping?(): void;
  terminate?(): void;
}
export interface PlazaPeer {
  ws: PlazaTransport; player: PlazaPlayer; channel: number; seq: number; movedAt: number; chatAt: number;
}
interface Channel { peers: Set<PlazaPeer>; dirty: boolean }

/** Public social presence only. PartyManager still owns game rooms and their permissions. */
export class PlazaManager {
  private readonly channels = new Map<number, Channel>();
  private readonly timers: NodeJS.Timeout[] = [];
  constructor(ticking = true) {
    if (ticking) this.timers.push(setInterval(() => this.flush(), 100));
  }
  get playerCount(): number { let n = 0; for (const c of this.channels.values()) n += c.peers.size; return n; }

  private send(ws: PlazaTransport, msg: PlazaServerMessage): void {
    if (ws.readyState === 1 && (ws.bufferedAmount ?? 0) < 128 * 1024) ws.send(JSON.stringify(msg));
  }
  join(ws: PlazaTransport, msg: Extract<PlazaClientMessage, { t: "z-hello" }>, now = Date.now()): PlazaPeer | null {
    if (msg.v !== PLAZA_PROTOCOL_VERSION) { this.send(ws, { t: "s-z-error", code: "version" }); ws.close(1002, "version"); return null; }
    let number = msg.channel ?? 1;
    if (!msg.channel) while ((this.channels.get(number)?.peers.size ?? 0) >= PLAZA_CHANNEL_SIZE && number < 999) number++;
    if ((this.channels.get(number)?.peers.size ?? 0) >= PLAZA_CHANNEL_SIZE) {
      this.send(ws, { t: "s-z-error", code: msg.channel ? "full" : "capacity" }); ws.close(1013, "full"); return null;
    }
    let channel = this.channels.get(number);
    if (!channel) { channel = { peers: new Set(), dirty: true }; this.channels.set(number, channel); }
    const seat = channel.peers.size;
    const peer: PlazaPeer = {
      ws, channel: number, seq: -1, movedAt: now, chatAt: 0,
      player: { id: randomUUID().slice(0, 16), name: msg.name, character: msg.character,
        pos: [PLAZA_SPAWN[0] + (seat % 4 - 1.5) * .9, PLAZA_SPAWN[1], PLAZA_SPAWN[2] + Math.floor(seat / 4) * .9], yaw: Math.PI, anim: "idle" },
    };
    channel.peers.add(peer); channel.dirty = true;
    this.send(ws, { t: "s-z-welcome", you: peer.player.id, channel: number, players: [...channel.peers].map(p => p.player) });
    return peer;
  }
  handle(peer: PlazaPeer, msg: PlazaClientMessage, now = Date.now()): void {
    const channel = this.channels.get(peer.channel);
    if (!channel?.peers.has(peer)) return;
    if (msg.t === "z-move") {
      if (msg.seq <= peer.seq) return;
      peer.seq = msg.seq;
      const old = peer.player.pos, dt = Math.min(.8, Math.max(.1, (now - peer.movedAt) / 1000));
      const distance = Math.hypot(msg.pos[0] - old[0], msg.pos[2] - old[2]);
      if (Math.hypot(msg.pos[0], msg.pos[2]) > 220 || distance > 2 + dt * 12 || Math.abs(msg.pos[1] - old[1]) > 3 + dt * 35) {
        this.send(peer.ws, { t: "s-z-correct", pos: old }); return;
      }
      peer.player = { ...peer.player, pos: msg.pos, yaw: msg.yaw, anim: msg.anim }; peer.movedAt = now; channel.dirty = true;
    } else if (msg.t === "z-reset") {
      peer.player.pos = [...PLAZA_SPAWN]; peer.player.anim = "idle"; peer.movedAt = now; channel.dirty = true;
      this.send(peer.ws, { t: "s-z-correct", pos: peer.player.pos });
    } else if (msg.t === "z-profile") {
      peer.player.name = msg.name; peer.player.character = msg.character; channel.dirty = true;
    } else if (msg.t === "z-chat" && now - peer.chatAt >= 700) {
      peer.chatAt = now;
      for (const p of channel.peers) this.send(p.ws, { t: "s-z-chat", id: peer.player.id, name: peer.player.name, text: msg.text });
    }
  }
  leave(peer: PlazaPeer): void {
    const channel = this.channels.get(peer.channel);
    if (!channel) return;
    channel.peers.delete(peer); channel.dirty = true;
    if (!channel.peers.size) this.channels.delete(peer.channel);
  }
  flush(): void {
    for (const channel of this.channels.values()) {
      if (!channel.dirty) continue;
      channel.dirty = false;
      const msg: PlazaServerMessage = { t: "s-z-snapshot", players: [...channel.peers].map(p => p.player) };
      for (const peer of channel.peers) this.send(peer.ws, msg);
    }
  }
  accept(ws: WebSocket): void {
    let peer: PlazaPeer | null = null, alive = true, tokens = 40, refilled = Date.now(), strikes = 0;
    const hello = setTimeout(() => { if (!peer) ws.close(1002, "hello timeout"); }, 10_000);
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false; ws.ping();
    }, 15_000);
    ws.on("pong", () => { alive = true; });
    ws.on("message", (raw, binary) => {
      const now = Date.now(); tokens = Math.min(40, tokens + (now - refilled) * .025); refilled = now;
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const msg = binary ? null : decodePlazaClient(raw.toString());
      if (!msg || tokens < 1) { if (++strikes > 30) ws.close(1008, "rate"); return; }
      tokens--;
      if (!peer) { if (msg.t === "z-hello") { clearTimeout(hello); peer = this.join(ws, msg, now); } }
      else this.handle(peer, msg, now);
    });
    ws.on("close", () => { clearTimeout(hello); clearInterval(heartbeat); if (peer) this.leave(peer); });
    ws.on("error", () => {});
  }
  shutdown(): void {
    for (const timer of this.timers) clearInterval(timer);
    for (const channel of this.channels.values()) for (const peer of channel.peers) peer.ws.close(1001, "server restart");
    this.channels.clear();
  }
}
