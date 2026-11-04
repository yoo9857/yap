import { describe, expect, it } from "vitest";
import {
  HUB_ROUTE,
  LiveDirectory,
  PUBLIC_TOWER,
  RouteLedger,
  UNROUTED_CLASS,
  classRoute,
  partyFieldRoute,
  routeOf,
  towerPartyRoute,
} from "../src/cluster/directory.js";

describe("routeOf", () => {
  it("routes a class by its class key, so case and spacing reach the same shard", () => {
    expect(routeOf("/ws?mode=class&room=%ED%96%87%EC%82%B4%EB%B0%98")).toBe("class:햇살반");
    expect(routeOf("/ws?mode=class&room=Sunny%20%20Class")).toBe(routeOf("/ws?mode=class&room=sunny%20class"));
    expect(routeOf("/ws?mode=class&room=%20Sunny%20Class%20")).toBe(classRoute("sunny class"));
  });

  it("sends a party's build field where the class manager will look for it", () => {
    // the client joins room "party:ABCDEF"; classKey lowercases it
    expect(routeOf("/ws?mode=class&room=party%3AABCDEF")).toBe(partyFieldRoute("ABCDEF"));
  });

  it("marks class sockets from pages older than routing", () => {
    expect(routeOf("/ws?mode=class")).toBe(UNROUTED_CLASS);
    expect(routeOf("/ws?mode=class&room=%20%20")).toBe(UNROUTED_CLASS);
  });

  it("keeps the hub in one place and the public tower together", () => {
    expect(routeOf("/ws?mode=party")).toBe(HUB_ROUTE);
    expect(routeOf("/ws")).toBe(PUBLIC_TOWER);
    expect(routeOf("/ws?party=abcdef")).toBe(towerPartyRoute("ABCDEF"));
    // a malformed code is not a party: the public tower, where c-hello's own check decides
    expect(routeOf("/ws?party=nope")).toBe(PUBLIC_TOWER);
  });
});

describe("LiveDirectory", () => {
  it("keeps a live route on its shard: a whole class meets in one process", () => {
    const d = new LiveDirectory(4);
    const first = d.placeNow("class:a");
    for (let i = 0; i < 30; i++) expect(d.placeNow("class:a")).toBe(first);
  });

  it("places new routes on the least loaded shard, counting hand-offs between reports", () => {
    const d = new LiveDirectory(3);
    d.report(0, 100);
    d.report(1, 10);
    d.report(2, 40);
    expect(d.placeNow("class:new")).toBe(1);
    // 25 students follow their teacher: shard 1 is now 36 against shard 2's 40
    for (let i = 0; i < 25; i++) d.placeNow("class:new");
    expect(d.placeNow("class:next")).toBe(1);
    for (let i = 0; i < 10; i++) d.placeNow("class:next");
    expect(d.placeNow("class:third")).toBe(2);
  });

  it("evens out a mix of big and small classes that hashing would pile up", () => {
    const d = new LiveDirectory(4);
    const load = [0, 0, 0, 0];
    for (let c = 0; c < 40; c++) {
      const size = c % 5 === 0 ? 40 : 8; // a few big classes among small ones
      for (let s = 0; s < size; s++) load[d.placeNow(`class:${c}`)]!++;
    }
    expect(Math.max(...load) - Math.min(...load)).toBeLessThanOrEqual(40);
  });

  it("releases only when the shard has seen every hand-off (no socket in flight)", () => {
    const d = new LiveDirectory(2);
    const shard = d.placeNow("class:a");
    d.placeNow("class:a"); // handed: 2
    expect(d.releaseNow("class:a", shard, 1)).toBe(false); // one socket still on its way
    expect(d.releaseNow("class:a", 1 - shard, 2)).toBe(false); // not that shard's route
    expect(d.releaseNow("class:a", shard, 2)).toBe(true);
    expect(d.where("class:a")).toBeUndefined();
  });

  it("takes back a hand-off that never happened", () => {
    const d = new LiveDirectory(2);
    const shard = d.placeNow("class:a");
    d.cancelNow("class:a", shard);
    expect(d.size).toBe(0); // nobody ever reached it: forgotten
    d.placeNow("class:b");
    const s2 = d.placeNow("class:b");
    d.cancelNow("class:b", s2);
    expect(d.releaseNow("class:b", s2, 1)).toBe(true); // counters agree again
  });

  it("gives no new routes to a down shard, and forgets the routes of one that died", () => {
    const d = new LiveDirectory(2);
    d.setUp(0, false);
    expect(d.placeNow("class:a")).toBe(1);
    d.setUp(0, true);
    d.report(1, 50);
    expect(d.placeNow("class:b")).toBe(0);
    d.setUp(0, false);
    expect(d.where("class:b")).toBeUndefined();
    expect(d.where("class:a")).toBe(1);
  });

  it("never places sockets from pages older than routing", () => {
    const d = new LiveDirectory(3);
    expect(d.placeNow(UNROUTED_CLASS)).toBe(0);
    expect(d.size).toBe(0);
  });
});

describe("RouteLedger + LiveDirectory hand-off protocol", () => {
  it("cannot open a class on a second shard while a socket is still in flight to the first", () => {
    const d = new LiveDirectory(2);
    const ledger = new RouteLedger();
    const route = "class:a";
    const shard = d.placeNow(route);
    ledger.arrive(route, true);
    ledger.leave(route); // the only socket closed; the class has unloaded
    const offered = ledger.idle(() => false);
    expect(offered).toEqual([[route, 1]]);
    // meanwhile the primary hands over another socket (still in the IPC pipe)
    expect(d.placeNow(route)).toBe(shard);
    // the stale offer is refused: the mapping stays, so every newcomer still goes to `shard`
    expect(d.releaseNow(route, shard, offered[0]![1])).toBe(false);
    ledger.arrive(route, true); // the in-flight socket lands
    expect(ledger.has(route)).toBe(true);
    ledger.leave(route);
    const again = ledger.idle(() => false);
    expect(d.releaseNow(route, shard, again[0]![1])).toBe(true);
    ledger.released(route, again[0]![1]);
    expect(ledger.has(route)).toBe(false);
  });

  it("keeps routes that still have an open socket or a live game", () => {
    const ledger = new RouteLedger();
    ledger.arrive("class:a", true);
    ledger.arrive("class:b", true);
    ledger.leave("class:b");
    ledger.arrive("class:c", false); // party-open: no socket
    expect(ledger.idle((r) => r === "class:c")).toEqual([["class:b", 1]]);
  });

  it("an ack for an older offer does not drop a route that has since been reached again", () => {
    const ledger = new RouteLedger();
    ledger.arrive("class:a", true);
    ledger.leave("class:a");
    ledger.arrive("class:a", true);
    ledger.released("class:a", 1);
    expect(ledger.has("class:a")).toBe(true);
  });
});
