import { describe, expect, it } from "vitest";
import { formatDisplay, makeEvent, toKrw } from "../src/normalize.js";

describe("toKrw", () => {
  it("passes KRW through untouched", () => {
    expect(toKrw(5000, "KRW")).toBe(5000);
  });
  it("converts foreign currency with the fixed rate table", () => {
    expect(toKrw(5, "USD")).toBe(6750);
    expect(toKrw(1000, "JPY")).toBe(9000);
  });
  it("falls back to the USD rate for unknown currency", () => {
    expect(toKrw(1, "XYZ")).toBe(toKrw(1, "USD"));
  });
  it("treats non-positive / non-finite amounts as zero", () => {
    expect(toKrw(0, "USD")).toBe(0);
    expect(toKrw(-5, "USD")).toBe(0);
    expect(toKrw(Number.NaN, "USD")).toBe(0);
  });
});

describe("formatDisplay", () => {
  it("formats KRW with a won sign", () => {
    expect(formatDisplay(5000, "KRW")).toBe("₩5,000");
  });
  it("formats a known foreign currency", () => {
    expect(formatDisplay(5, "USD")).toContain("5");
  });
});

describe("makeEvent", () => {
  it("clamps oversized strings to the schema limits", () => {
    const e = makeEvent({
      source: "webhook",
      kind: "chat",
      name: "x".repeat(200),
      message: "y".repeat(999),
    });
    expect(e.name.length).toBe(80);
    expect(e.message.length).toBe(500);
    expect(e.amountKrw).toBe(0);
  });
  it("keeps donation fields", () => {
    const e = makeEvent({
      source: "toonation",
      kind: "donation",
      name: "Kim",
      amountKrw: 10000,
      display: "₩10,000",
      id: "abc",
    });
    expect(e).toMatchObject({ name: "Kim", amountKrw: 10000, id: "abc", kind: "donation" });
  });
});
