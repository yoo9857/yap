import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { ConnectionGate, clientAddress } from "../src/net/wsServer.js";

const req = (peer: string, realIp?: string) =>
  ({ socket: { remoteAddress: peer }, headers: realIp === undefined ? {} : { "x-real-ip": realIp } }) as unknown as IncomingMessage;

describe("connection gate", () => {
  it("caps sockets per address and in total, and frees them on release", () => {
    const gate = new ConnectionGate({ perAddress: 2, total: 3 });
    expect(gate.admit("a")).toBe(true);
    expect(gate.admit("a")).toBe(true);
    expect(gate.admit("a")).toBe(false); // per address
    expect(gate.admit("b")).toBe(true);
    expect(gate.admit("c")).toBe(false); // total
    gate.release("a");
    expect(gate.admit("c")).toBe(true);
    gate.release("zzz"); // unknown: no underflow
    expect(gate.total).toBe(3);
  });

  it("believes X-Real-IP only from the local proxy", () => {
    expect(clientAddress(req("127.0.0.1", "203.0.113.9"))).toBe("203.0.113.9");
    expect(clientAddress(req("::ffff:172.18.0.1", "203.0.113.9"))).toBe("203.0.113.9");
    expect(clientAddress(req("198.51.100.4", "203.0.113.9"))).toBe("198.51.100.4"); // spoofed from outside
    expect(clientAddress(req("127.0.0.1"))).toBe("127.0.0.1");
  });
});
