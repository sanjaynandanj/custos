import { describe, it, expect } from "vitest";
import { loadPolicy } from "../src/policy.js";

describe("policy", () => {
  it("default deny", () => {
    const p = loadPolicy({ version: 1, default: "deny", rules: [] });
    expect(p.evaluate({ tool: "x", actor: { id: "a" }, server: { id: "s" }, args: {} }).decision).toBe("deny");
  });

  it("exact match allow", () => {
    const p = loadPolicy({ version: 1, default: "deny", rules: [{ id: "r1", when: { tool: "read_file" }, decision: "allow", reason: "ok" }] });
    const r = p.evaluate({ tool: "read_file", actor: { id: "a" }, server: { id: "s" }, args: {} });
    expect(r.decision).toBe("allow");
    expect(r.ruleId).toBe("r1");
  });

  it("prefix + wildcard", () => {
    const p = loadPolicy({
      version: 1, default: "deny",
      rules: [{ id: "r1", when: { "actor.id": "agent-*", "args.path": { prefix: "/workspace/" } }, decision: "allow" }],
    });
    const ctx = { tool: "read_file", actor: { id: "agent-42" }, server: { id: "s" }, args: { path: "/workspace/x" } };
    expect(p.evaluate(ctx).decision).toBe("allow");
    (ctx.args as any).path = "/etc/passwd";
    expect(p.evaluate(ctx).decision).toBe("deny");
  });

  it("regex + in", () => {
    const p = loadPolicy({
      version: 1, default: "deny",
      rules: [{ id: "http", when: { tool: "http_request", "args.method": { in: ["GET", "HEAD"] }, "args.url": { regex: "^https://" } }, decision: "allow" }],
    });
    const ctx = { tool: "http_request", actor: { id: "a" }, server: { id: "s" }, args: { method: "GET", url: "https://x" } };
    expect(p.evaluate(ctx).decision).toBe("allow");
    (ctx.args as any).method = "POST";
    expect(p.evaluate(ctx).decision).toBe("deny");
  });

  it("policy regex precompiled — 10 rules × 1000 evals < 1s, bad regex rejected at load", () => {
    const rules = Array.from({ length: 10 }).map((_, i) => ({
      id: `r${i}`,
      when: { tool: { regex: `^tool-${i}-.*$` } },
      decision: "allow" as const,
    }));
    const p = loadPolicy({ version: 1, default: "deny", rules });
    const ctx = { tool: "tool-9-x", actor: { id: "a" }, server: { id: "s" }, args: {} };
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) p.evaluate(ctx);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1000);

    expect(() =>
      loadPolicy({
        version: 1, default: "deny",
        rules: [{ id: "bad", when: { tool: { regex: "([unclosed" } }, decision: "allow" }],
      }),
    ).toThrow();
  });

  it("exists false matches missing", () => {
    const p = loadPolicy({
      version: 1, default: "allow",
      rules: [{ id: "req-actor", when: { "actor.token": { exists: false } }, decision: "deny" }],
    });
    const ctx = { tool: "x", actor: { id: "a" }, server: { id: "s" }, args: {} };
    expect(p.evaluate(ctx).decision).toBe("deny");
  });

  it("policy.hash is content-addressed and stable", () => {
    // Same input → same hash; different input → different hash. This is
    // the property audit reconstruction relies on: a record's
    // policy.hash pins the exact source that produced the decision.
    const a = loadPolicy({ version: 1, id: "t", default: "deny", rules: [] });
    const b = loadPolicy({ version: 1, id: "t", default: "deny", rules: [] });
    expect(a.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.hash).toBe(b.hash);
    const c = loadPolicy({ version: 1, id: "t", default: "allow", rules: [] });
    expect(a.hash).not.toBe(c.hash);
  });
});
