import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeypair } from "../src/keys.js";
import { Ledger } from "../src/ledger.js";
import { loadPolicy } from "../src/policy.js";
import { Gate } from "../src/sdk.js";
import { newActor } from "../src/record.js";
import { verifyLedger } from "../src/verify.js";
import { createBundle, verifyBundle } from "../src/bundle.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "custos-js-"));
  const kp = generateKeypair();
  kp.save(dir);
  const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
  const policy = loadPolicy({ version: 1, default: "deny", rules: [{ id: "allow-read", when: { tool: "read" }, decision: "allow" }] });
  const gate = new Gate(policy, ledger, newActor("agent-1"), { id: "srv" });
  return { dir, kp, ledger, gate };
}

describe("ledger + verify", () => {
  it("allows, denies, and verifies chain", async () => {
    const { dir, gate } = setup();
    const r = await gate.call("read", { path: "/tmp/x" }, (a: any) => `contents of ${a.path}`);
    expect(r.allowed).toBe(true);
    expect(r.result).toBe("contents of /tmp/x");

    const r2 = await gate.call("write", { path: "/tmp/x" }, () => null);
    expect(r2.allowed).toBe(false);

    for (let i = 0; i < 5; i++) await gate.call("read", { i }, () => "ok");

    const v = verifyLedger(join(dir, "ledger.jsonl"), join(dir, "ledger.pub"));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.records).toBe(7);
  });

  it("detects tamper", async () => {
    const { dir, gate } = setup();
    for (let i = 0; i < 3; i++) await gate.call("read", { i }, () => i);
    const p = join(dir, "ledger.jsonl");
    let data = readFileSync(p, "utf8");
    data = data.replace('"allow"', '"deny "');
    writeFileSync(p, data);
    const v = verifyLedger(p);
    expect(v.ok).toBe(false);
  });

  it("bundle roundtrip", async () => {
    const { dir, kp, gate } = setup();
    for (let i = 0; i < 3; i++) await gate.call("read", { i }, () => i);
    const out = join(dir, "bundle.tar.gz");
    await createBundle(join(dir, "ledger.jsonl"), join(dir, "ledger.pub"), out, kp);
    const r = await verifyBundle(out);
    expect(r.ok).toBe(true);
    expect(r.records).toBe(3);
  });
});
