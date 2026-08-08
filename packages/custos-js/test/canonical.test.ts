import { describe, it, expect } from "vitest";
import { canonicalBytes, canonicalStringify } from "../src/canonical.js";

describe("canonical", () => {
  it("sorts keys deeply", () => {
    expect(canonicalStringify({ b: 1, a: { z: 2, y: 3 } })).toBe('{"a":{"y":3,"z":2},"b":1}');
  });
  it("no whitespace", () => {
    expect(canonicalStringify([1, 2, 3])).toBe("[1,2,3]");
  });
  it("utf8 preserved raw", () => {
    const s = canonicalStringify({ k: "é" });
    expect(s).toBe('{"k":"é"}');
    expect(canonicalBytes({ k: "é" })).toEqual(new TextEncoder().encode('{"k":"é"}'));
  });
  it("rejects NaN", () => {
    expect(() => canonicalStringify(NaN)).toThrow();
  });
});
