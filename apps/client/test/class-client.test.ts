import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClassClient, type ClassSession } from "../src/net/classClient.js";
import type { ClassServerMessage } from "@robo/shared";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor() { Socket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(raw: string) { this.sent.push(raw); }
  close(_code?: number, reason = "") { this.readyState = 3; this.onclose?.({ reason }); }
  receive(msg: ClassServerMessage) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}
const welcome = (you = "old", edits = 0): ClassServerMessage => ({ t: "s-k-welcome", you, role: "teacher", room: "Test", teacher: "Teacher",
  key: "seat-key", members: [{ id: you, name: "Teacher", role: "teacher", online: true }],
  settings: { chatLocked: false, buildLocked: false }, editCount: edits, furniture: [] });
const clients: ClassClient[] = [];
const create = () => { const c = new ClassClient({ role: "teacher", room: "Test", teacher: "Teacher", password: "1234" }); clients.push(c); return c; };
beforeEach(() => {
  vi.useFakeTimers(); Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => { for (const c of clients.splice(0)) c.close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("classroom client lifecycle", () => {
  it("sends gameplay only after resync and skips positions on a backed-up socket", async () => {
    const c = create(), connected = c.connect(), ws = Socket.instances[0]!;
    const edit = { t: "k-edit", edits: [[0, 4, 0, 19, 0]] } as const;
    const sendEdit = () => c.send({ t: edit.t, edits: [[...edit.edits[0]]] });
    ws.open();
    expect((JSON.parse(ws.sent[0]!) as { t: string }).t).toBe("k-host");
    ws.receive(welcome());
    await connected;
    c.activate();
    ws.close();
    await vi.advanceTimersByTimeAsync(2000);
    const retry = Socket.instances[1]!;
    retry.open();
    expect(c.connected).toBe(false);
    expect(sendEdit()).toBe(false);
    retry.receive(welcome("new", 1));
    expect(sendEdit()).toBe(false);
    retry.receive({ t: "s-k-world", edits: [[1, 4, 0, 17, 0]] });
    expect(c.connected).toBe(true);
    const move = { t: "k-move", pos: [0, 4, 0], yaw: 0, anim: "idle" } as const;
    retry.bufferedAmount = 16 * 1024;
    expect(c.send({ ...move, pos: [...move.pos] })).toBe(false);
    expect(sendEdit()).toBe(true);
    retry.bufferedAmount = 0;
    expect(c.send({ ...move, pos: [...move.pos] })).toBe(true);
    expect(retry.sent.map((raw) => (JSON.parse(raw) as { t: string }).t)).toEqual(["k-host", "k-edit", "k-move"]);
  });
  it("replays the water cleanup barrier in order during a streamed join", async () => {
    const c = create(), connected = c.connect(), ws = Socket.instances[0]!; ws.open();
    ws.receive(welcome("old", 2));
    ws.receive({ t: "s-k-world", edits: [[0, 4, 0, 19, 0]] });
    ws.receive({ t: "s-k-edit", by: "", edits: [[1, 4, 0, 20, 0]] });
    ws.receive({ t: "s-k-water-drained" });
    ws.receive({ t: "s-k-world", edits: [[2, 4, 0, 0, 0]] });
    await connected;
    ws.receive({ t: "s-k-edit", by: "other", edits: [[3, 4, 0, 19, 0]] });
    const events: string[] = [];
    c.onEdit = (edits) => events.push(`edit:${edits[0]![3]}`);
    c.onWaterDrained = () => events.push("drain");
    c.activate();
    expect(events).toEqual(["edit:20", "drain", "edit:19"]);
    c.close(); expect(c.onWaterDrained).toBeNull();
  });
  it("replays edits, reset and settings received during streamed world and graphics setup", async () => {
    const c = create(), connected = c.connect(), ws = Socket.instances[0]!; ws.open();
    ws.receive(welcome("old", 2));
    ws.receive({ t: "s-k-world", edits: [[0, 4, 0, 3, 0]] });
    ws.receive({ t: "s-k-edit", by: "other", edits: [[0, 4, 0, 17, 0]] });
    ws.receive({ t: "s-k-world-reset" });
    ws.receive({ t: "s-k-world", edits: [[1, 4, 0, 0, 0]] });
    const session = await connected;
    ws.receive({ t: "s-k-edit", by: "other", edits: [[2, 4, 0, 18, 0]] });
    ws.receive({ t: "s-k-settings", settings: { chatLocked: true, buildLocked: true } });
    expect(session.edits).toHaveLength(2);
    const received: string[] = [];
    c.onEdit = (edits) => received.push(`edit:${edits[0]![3]}`);
    c.onWorldReset = () => received.push("reset");
    c.onSettings = () => received.push("settings");
    c.activate();
    expect(received).toEqual(["edit:17", "reset", "edit:18", "settings"]);
    c.activate(); expect(received).toHaveLength(4);
  });

  it("rejects an abandoned first load and releases handlers/timers", async () => {
    const c = create(), result = expect(c.connect()).rejects.toBe("offline"), ws = Socket.instances[0]!;
    ws.open(); ws.receive(welcome("old", 300000));
    ws.receive({ t: "s-k-world", edits: [[0, 4, 0, 19, 0]] });
    c.onEdit = vi.fn(); c.close(); await result;
    expect(c.onEdit).toBeNull(); expect(ws.onmessage).toBeNull();
    vi.advanceTimersByTime(120000); expect(Socket.instances).toHaveLength(1);
  });

  it("times out a stalled load but extends the idle timer for real progress", async () => {
    const c = create(), result = expect(c.connect()).rejects.toBe("offline"), ws = Socket.instances[0]!;
    ws.open(); ws.receive(welcome("old", 2));
    vi.advanceTimersByTime(9000); ws.receive({ t: "s-k-world", edits: [[0, 4, 0, 3, 0]] });
    vi.advanceTimersByTime(9000); expect(ws.readyState).toBe(1);
    vi.advanceTimersByTime(1001); await result; expect(ws.readyState).toBe(3);
  });

  it("updates identity on reconnect and ignores messages from the retired socket", async () => {
    const c = create(), first = c.connect(), old = Socket.instances[0]!; old.open(); old.receive(welcome()); await first;
    c.activate(); const resync = vi.fn<(s: ClassSession) => void>(); c.onResync = resync;
    const stale = old.onmessage!; old.close(); vi.advanceTimersByTime(500);
    const next = Socket.instances[1]!; next.open(); next.receive(welcome("new"));
    stale({ data: JSON.stringify(welcome("stale")) });
    expect(resync).toHaveBeenCalledTimes(1); expect(resync.mock.calls[0]![0].you).toBe("new");
  });

  it("retries a temporarily occupied teacher seat only for an existing connection", async () => {
    const c = create(), first = c.connect(), old = Socket.instances[0]!; old.open(); old.receive(welcome()); await first; c.activate();
    c.onEnded = vi.fn(); old.close(); vi.advanceTimersByTime(500);
    const next = Socket.instances[1]!; next.open(); next.receive({ t: "s-k-error", code: "teacher-taken" });
    expect(c.onEnded).not.toHaveBeenCalled(); vi.advanceTimersByTime(1000);
    expect(Socket.instances).toHaveLength(3);
    Socket.instances[2]!.open(); Socket.instances[2]!.receive(welcome("new")); expect(c.connected).toBe(true);
  });

  it("reports class termination both during initial load and before the game activates", async () => {
    const c = create(), failed = expect(c.connect()).rejects.toBe("no-class"), ws = Socket.instances[0]!;
    ws.open(); ws.receive(welcome("old", 1)); ws.receive({ t: "s-k-closed" }); await failed;
    const d = create(), ready = d.connect(), second = Socket.instances[1]!;
    second.open(); second.receive(welcome()); await ready; second.receive({ t: "s-k-kicked" });
    const ended = vi.fn(); d.onEnded = ended; d.activate(); expect(ended).toHaveBeenCalledWith("kicked");
  });

  it("lets a returning student wait for the teacher to restore a saved room", async () => {
    const c = new ClassClient({ role: "student", room: "Test", student: "Student" }); clients.push(c);
    const first = c.connect(), old = Socket.instances[0]!; old.open(); old.receive(welcome()); await first; c.activate();
    c.onEnded = vi.fn(); old.close(); vi.advanceTimersByTime(500);
    const next = Socket.instances[1]!; next.open(); next.receive({ t: "s-k-error", code: "no-class" });
    expect(c.onEnded).not.toHaveBeenCalled(); vi.advanceTimersByTime(1000);
    const restored = Socket.instances[2]!; restored.open(); restored.receive(welcome("restored"));
    expect(c.connected).toBe(true);
    const newcomer = new ClassClient({ role: "student", room: "Test", student: "New" }); clients.push(newcomer);
    const failed = expect(newcomer.connect()).rejects.toBe("no-class");
    Socket.instances[3]!.open(); Socket.instances[3]!.receive({ t: "s-k-error", code: "no-class" }); await failed;
  });

  it("stops for good when its seat is taken over by another tab, instead of taking it back", async () => {
    const c = new ClassClient({ role: "student", room: "Test", student: "Student" }); clients.push(c);
    const first = c.connect(), ws = Socket.instances[0]!; ws.open(); ws.receive(welcome()); await first; c.activate();
    const ended = vi.fn(); c.onEnded = ended;
    ws.close(1000, "replaced");
    vi.advanceTimersByTime(30_000);
    expect(ended).toHaveBeenCalledWith("replaced");
    expect(Socket.instances).toHaveLength(1); // no reconnect, so no seat tug-of-war
  });

  it("hands a reconnect that finished during game loading to onResync at activate", async () => {
    const c = create(), first = c.connect(), old = Socket.instances[0]!; old.open(); old.receive(welcome("old")); await first;
    old.close(); vi.advanceTimersByTime(500);
    const next = Socket.instances[1]!; next.open(); next.receive(welcome("new", 1)); next.receive({ t: "s-k-world", edits: [[3, 4, 3, 3, 0]] });
    const resync = vi.fn<(s: ClassSession) => void>(); c.onResync = resync;
    c.activate();
    expect(resync).toHaveBeenCalledTimes(1);
    expect(resync.mock.calls[0]![0].you).toBe("new");
    expect(resync.mock.calls[0]![0].edits).toEqual([[3, 4, 3, 3, 0]]);
  });

  it("drops a silent link once the server's keepalive promise lapses, and reconnects", async () => {
    const c = create(), first = c.connect(), ws = Socket.instances[0]!; ws.open();
    ws.receive({ ...welcome(), keepalive: 2 } as ClassServerMessage); await first; c.activate();
    vi.advanceTimersByTime(9000); expect(ws.readyState).toBe(1);
    ws.receive({ t: "s-k-snap", players: [] }); // heard from: the clock restarts
    vi.advanceTimersByTime(9000); expect(ws.readyState).toBe(1);
    vi.advanceTimersByTime(3000); expect(ws.readyState).toBe(3);
    vi.advanceTimersByTime(1000); expect(Socket.instances).toHaveLength(2);
  });

  it("folds a long run of water edits during loading instead of reconnecting forever", async () => {
    const c = create(), first = c.connect(), ws = Socket.instances[0]!; ws.open(); ws.receive(welcome()); await first;
    for (let i = 0; i < 3000; i++) ws.receive({ t: "s-k-edit", by: "", edits: [[i % 8, 4, 0, i % 2 ? 19 : 0, 0]] });
    expect(ws.readyState).toBe(1); // still connected: 3000 writes to 8 cells fit
    const cells = new Map<number, number>();
    c.onEdit = (edits) => { for (const e of edits) cells.set(e[0], e[3]); };
    c.activate();
    expect(cells.size).toBe(8);
    for (const [x, block] of cells) expect(block).toBe((2992 + x) % 2 ? 19 : 0); // the latest write per cell
  });

  it("reconnects from a dead link without waiting for its close handshake", async () => {
    const c = create(), first = c.connect(), ws = Socket.instances[0]!; ws.open();
    ws.receive({ ...welcome(), keepalive: 2 } as ClassServerMessage); await first; c.activate();
    ws.close = () => {}; // half-open: the close handshake never completes, onclose never fires
    vi.advanceTimersByTime(12_000);
    expect(Socket.instances).toHaveLength(2);
  });

  it("says 'another tab' when the seat is taken over while the game is still loading", async () => {
    const c = new ClassClient({ role: "student", room: "Test", student: "Student" }); clients.push(c);
    const first = c.connect(), ws = Socket.instances[0]!; ws.open(); ws.receive(welcome()); await first;
    ws.close(1000, "replaced");
    const ended = vi.fn(); c.onEnded = ended; c.activate();
    expect(ended).toHaveBeenCalledWith("replaced");
  });

  it("keeps each author's name when it folds buffered edits", async () => {
    const c = create(), first = c.connect(), ws = Socket.instances[0]!; ws.open(); ws.receive(welcome()); await first;
    for (let i = 0; i < 1100; i++) ws.receive({ t: "s-k-edit", by: i < 1000 ? "" : "kid", edits: [[i % 4, 4, 0, 19, 0]] });
    const authors: string[] = [];
    c.onEdit = (_edits, by) => authors.push(by);
    c.activate();
    expect(authors[0]).toBe(""); // the water run folded into one message…
    expect(authors.slice(1).every((by) => by === "kid")).toBe(true); // …and the classmate's bricks keep their name
    expect(authors.length).toBeLessThan(100);
  });

  it("keeps no watchdog for an older server that promises no keepalive", async () => {
    const c = create(), first = c.connect(), ws = Socket.instances[0]!; ws.open(); ws.receive(welcome()); await first; c.activate();
    vi.advanceTimersByTime(120_000); expect(ws.readyState).toBe(1);
  });
});
