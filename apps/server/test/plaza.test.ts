import { describe, expect, it } from "vitest";
import { PLAZA_CHANNEL_SIZE, PLAZA_PROTOCOL_VERSION, decodePlazaClient, type PlazaServerMessage } from "@robo/shared";
import { PlazaManager, type PlazaTransport } from "../src/plaza/plazaManager.js";
import { PLAZA_ROUTE, routeOf } from "../src/cluster/directory.js";
class Transport implements PlazaTransport {
  readyState = 1; bufferedAmount = 0; closed = false;
  got: PlazaServerMessage[] = [];
  send(data: string): void { this.got.push(JSON.parse(data) as PlazaServerMessage); }
  close(): void { this.closed = true; }
}
const hello = (name: string, channel?: number) => ({ t: "z-hello", v: PLAZA_PROTOCOL_VERSION, name, character: "mascot", ...(channel ? { channel } : {}) } as const);
describe("public plaza", () => {
  it("routes to the shared plaza and sends the whole roster to a late joiner", () => {
    expect(routeOf("/ws?mode=plaza")).toBe(PLAZA_ROUTE);
    const hub = new PlazaManager(false), a = new Transport(), b = new Transport();
    const first = hub.join(a, hello("민지"), 1000)!; hub.join(b, hello("준호"), 1000); hub.flush();
    const welcome = b.got.find(m => m.t === "s-z-welcome");
    expect(welcome?.t === "s-z-welcome" && welcome.players.map(p => p.name)).toEqual(["민지", "준호"]);
    hub.handle(first, { t: "z-move", seq: 1, pos: [-1, .16, 9.5], yaw: 0, anim: "run" }, 1100); hub.flush();
    const snapshot = b.got.at(-1);
    expect(snapshot?.t === "s-z-snapshot" && snapshot.players.find(p => p.id === first.player.id)?.pos).toEqual([-1, .16, 9.5]);
    hub.leave(first); hub.flush(); expect(hub.playerCount).toBe(1); hub.shutdown();
  });
  it("does not relay teleport reports or stale movement sequences", () => {
    const hub = new PlazaManager(false), transport = new Transport(), peer = hub.join(transport, hello("민지"), 1000)!;
    hub.handle(peer, { t: "z-move", seq: 1, pos: [100, .16, 100], yaw: 0, anim: "run" }, 1100);
    expect(transport.got.at(-1)?.t).toBe("s-z-correct");
    const position = [...peer.player.pos];
    hub.handle(peer, { t: "z-move", seq: 1, pos: [0, .16, 9], yaw: 0, anim: "idle" }, 1200);
    expect(peer.player.pos).toEqual(position);
    hub.handle(peer, { t: "z-reset" }, 1400); expect(peer.player.pos).toEqual([0, .16, 10]); hub.shutdown();
  });
  it("keeps channels separate and only refuses an explicitly full channel", () => {
    const hub = new PlazaManager(false);
    for (let i = 0; i < PLAZA_CHANNEL_SIZE; i++) hub.join(new Transport(), hello("친구" + i, 1));
    const full = new Transport(); expect(hub.join(full, hello("늦은친구", 1))).toBeNull(); expect(full.closed).toBe(true);
    const next = hub.join(new Transport(), hello("새친구"))!; expect(next.channel).toBe(2);
    const isolated = new Transport(); hub.join(isolated, hello("다른채널", 3));
    hub.handle(next, { t: "z-chat", text: "안녕" }, 2000);
    expect(isolated.got.some(m => m.t === "s-z-chat")).toBe(false); hub.shutdown();
  });
  it("rate limits chat and refuses incompatible clients and non-finite poses", () => {
    const hub = new PlazaManager(false), a = new Transport(), peer = hub.join(a, hello("친구"))!;
    hub.handle(peer, { t: "z-chat", text: "첫 인사" }, 2000); hub.handle(peer, { t: "z-chat", text: "도배" }, 2010);
    expect(a.got.filter(m => m.t === "s-z-chat")).toHaveLength(1);
    const incompatible = new Transport(); expect(hub.join(incompatible, { ...hello("오래된친구"), v: 0 })).toBeNull();
    expect(decodePlazaClient('{"t":"z-move","seq":1,"pos":[1e999,0,0],"yaw":0,"anim":"idle"}')).toBeNull(); hub.shutdown();
  });
});
