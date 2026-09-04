import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeypair } from "../src/keys.js";
import { Ledger } from "../src/ledger.js";
import { loadPolicy } from "../src/policy.js";
import { Gate } from "../src/sdk.js";
import { newActor } from "../src/record.js";
import { replayLedger, verifyCoverage, verifyLedger } from "../src/verify.js";
import { unlinkSync, writeFileSync as writeFileSyncFs } from "node:fs";
import { readdirSync } from "node:fs";
import {
  createBundle,
  verifyBundle,
  _buildTarForTest,
  _readTarForTest,
  _gzipBufferForTest,
  _gunzipBufferForTest,
} from "../src/bundle.js";
import { mkdirSync } from "node:fs";

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
    // 1 startup attestation (Gate init) + 1 allow + 1 deny + 5 allows.
    expect(v.records).toBe(8);
  });

  it("policy.hash is recorded on every record and chain still verifies", async () => {
    const { dir, gate } = setup();
    const expected = gate.policy.hash;
    expect(expected).toMatch(/^sha256:[0-9a-f]{64}$/);

    await gate.call("read", { path: "/tmp/a" }, () => "ok");
    await gate.call("write", { path: "/tmp/b" }, () => null); // denied

    const lines = readFileSync(join(dir, "ledger.jsonl"), "utf8").split("\n").filter(Boolean);
    const decisions = lines
      .map((l) => JSON.parse(l))
      .filter((rec) => rec.type !== "attestation");
    expect(decisions.length).toBe(2);
    for (const rec of decisions) {
      expect(rec.policy.hash).toBe(expected);
    }
    const v = verifyLedger(join(dir, "ledger.jsonl"), join(dir, "ledger.pub"));
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("verifyCoverage reports gaps between attestations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custos-cov-"));
    const kp = generateKeypair();
    kp.save(dir);
    const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
    ledger.appendAttestation({ reason: "startup", custosVersion: "test" });
    await new Promise((r) => setTimeout(r, 20));
    ledger.appendAttestation({ reason: "periodic", custosVersion: "test" });
    await new Promise((r) => setTimeout(r, 500));  // gap
    ledger.appendAttestation({ reason: "periodic", custosVersion: "test" });
    await new Promise((r) => setTimeout(r, 20));
    ledger.appendAttestation({ reason: "shutdown", custosVersion: "test" });

    const r = verifyCoverage(join(dir, "ledger.jsonl"), 0.1, 2.0);
    expect(r.attestations).toBe(4);
    expect(r.byReason).toEqual({ startup: 1, periodic: 2, shutdown: 1 });
    expect(r.ok).toBe(false);
    expect(r.gaps.length).toBe(1);
    expect(r.gaps[0]!.durationS).toBeGreaterThanOrEqual(0.4);
  });

  it("verifyCoverage OK when cadence is within tolerance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custos-covok-"));
    const kp = generateKeypair();
    kp.save(dir);
    const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
    for (let i = 0; i < 5; i++) {
      ledger.appendAttestation({ reason: "periodic", custosVersion: "test" });
      await new Promise((r) => setTimeout(r, 30));
    }
    const r = verifyCoverage(join(dir, "ledger.jsonl"), 0.1, 2.0);
    expect(r.ok).toBe(true);
    expect(r.attestations).toBe(5);
    expect(r.gaps).toEqual([]);
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
    // 1 startup attestation + 3 gate.call decisions.
    expect(r.records).toBe(4);
  });

  it("multiple sequential appends chain correctly (concurrency-safety doc)", async () => {
    // append() is intentionally synchronous; multiple back-to-back calls from
    // the same Ledger instance must produce a strictly-increasing seq chain
    // with matching prev_hash links. Cross-instance / cross-process writes
    // to the same file are unsupported (see ledger.ts doc-comment).
    const { dir, gate } = setup();
    for (let i = 0; i < 20; i++) await gate.call("read", { i }, () => i);
    const v = verifyLedger(join(dir, "ledger.jsonl"), join(dir, "ledger.pub"));
    expect(v.ok).toBe(true);
    // 1 startup attestation + 20 gate.call decisions.
    expect(v.records).toBe(21);
  });

  it("Gate snapshots policy and bundle auto-picks it up", async () => {
    // Reviewer's ask: reconstruct a decision six months later, using only
    // the bundle. Gate() must snapshot the exact policy source under
    // <ledger>/../policies/<hex>.<ext> on construction, and create_bundle
    // must auto-discover that directory when no explicit dir is passed.
    const { dir, kp, gate } = setup();
    const hex = gate.policy.hash.slice("sha256:".length);
    const snapshot = join(dir, "policies", `${hex}.json`);
    expect(readFileSync(snapshot).length).toBeGreaterThan(0);

    await gate.call("read", { i: 0 }, () => "ok");
    const out = join(dir, "bundle.tar.gz");
    await createBundle(join(dir, "ledger.jsonl"), join(dir, "ledger.pub"), out, kp);

    const gz = readFileSync(out);
    const tarBuf = await _gunzipBufferForTest(gz);
    const entries = _readTarForTest(tarBuf);
    const names = entries.map((e) => e.name);
    expect(names).toContain(`bundle/policies/${hex}.json`);

    const r = await verifyBundle(out);
    expect(r.ok).toBe(true);
    expect((r.manifest as any)?.policies_hash).toMatch(/^sha256:/);
  });

  it("startup attestation is emitted and verifies", async () => {
    // Reviewer's ask #2: silence should not be ambiguous. Gate init
    // MUST record "the control was operational at time T" as a signed
    // attestation participating in the same hash chain as decisions.
    const dir = mkdtempSync(join(tmpdir(), "custos-att-"));
    const kp = generateKeypair();
    kp.save(dir);
    const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
    const policy = loadPolicy({ version: 1, id: "t", default: "allow", rules: [] });
    new Gate(policy, ledger, newActor("agent-x"), { id: "s" });

    const lines = readFileSync(join(dir, "ledger.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec.type).toBe("attestation");
    expect(rec.attestation.reason).toBe("startup");
    expect(rec.attestation.policy_hash).toBe(policy.hash);
    expect(rec.attestation.active_actors).toEqual(["agent-x"]);
    const v = verifyLedger(join(dir, "ledger.jsonl"), join(dir, "ledger.pub"));
    expect(v.ok).toBe(true);
  });

  it("Gate warns when startup attestation fails", async () => {
    // A third-party Ledger without appendAttestation MUST cause a
    // console.warn — silent failure here reproduces the "you stopped
    // observing" gap Custos is trying to make detectable.
    const dir = mkdtempSync(join(tmpdir(), "custos-brokenl-"));
    const policy = loadPolicy({ version: 1, id: "t", default: "allow", rules: [] });

    class BrokenLedger {
      public readonly path: string;
      constructor(p: string) {
        this.path = p;
        const { mkdirSync } = require("node:fs");
        mkdirSync(join(p, ".."), { recursive: true });
      }
      // Note: no appendAttestation method.
    }
    const brokenLedger = new BrokenLedger(join(dir, "ledger.jsonl")) as unknown as Ledger;

    const seen: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: any) => { seen.push(String(msg)); };
    try {
      new Gate(policy, brokenLedger, newActor("a"), { id: "s" });
    } finally {
      console.warn = origWarn;
    }
    const matches = seen.filter((m) => m.includes("startup attestation failed"));
    expect(matches.length).toBeGreaterThan(0);
    // Warning must name the specific Ledger class so operators can find it.
    expect(matches[0]).toContain("BrokenLedger");
  });

  it("attest: false suppresses startup attestation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custos-noatt-"));
    const kp = generateKeypair();
    kp.save(dir);
    const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
    const policy = loadPolicy({ version: 1, id: "t", default: "allow", rules: [] });
    new Gate(policy, ledger, newActor("a"), { id: "s" }, { attest: false });
    // Ledger file may not exist yet; if it does, it must be empty.
    const p = join(dir, "ledger.jsonl");
    let text = "";
    try { text = readFileSync(p, "utf8"); } catch { /* not created — OK */ }
    expect(text).toBe("");
  });

  it("enforcement label defaults to sdk/blocked", async () => {
    const { dir, gate } = setup();
    await gate.call("read", { path: "/tmp/x" }, () => "ok");
    await gate.call("write", { path: "/tmp/x" }, () => null); // denied

    const lines = readFileSync(join(dir, "ledger.jsonl"), "utf8").split("\n").filter(Boolean);
    const decisions = lines
      .map((l) => JSON.parse(l))
      .filter((rec) => rec.type !== "attestation");
    expect(decisions.length).toBe(2);
    for (const rec of decisions) {
      expect(rec.enforcement).toEqual({ point: "sdk", effect: "blocked" });
    }
  });

  it("Gate rejects invalid enforcement at construction", () => {
    // Author-time validation: a typo in point/effect must blow up on
    // construction rather than silently landing in the ledger.
    const dir = mkdtempSync(join(tmpdir(), "custos-enf-"));
    const kp = generateKeypair();
    kp.save(dir);
    const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
    const policy = loadPolicy({ version: 1, id: "t", default: "allow", rules: [] });

    expect(() => new Gate(policy, ledger, newActor("a"), { id: "s" }, {
      enforcement: { point: "sdkk" as any, effect: "blocked" }, attest: false,
    })).toThrow(/point/);
    expect(() => new Gate(policy, ledger, newActor("a"), { id: "s" }, {
      enforcement: { point: "sdk", effect: "advisor" as any }, attest: false,
    })).toThrow(/effect/);
    // Valid enforcement must construct cleanly.
    new Gate(policy, ledger, newActor("a"), { id: "s" }, {
      enforcement: { point: "attest-only", effect: "advisory" }, attest: false,
    });
  });

  it("advisory mode marks deny as advisory and runs fn", async () => {
    // Staged rollout: log what the stricter policy would deny, but keep
    // executing so ops sees the impact before flipping to blocked.
    const dir = mkdtempSync(join(tmpdir(), "custos-adv-"));
    const kp = generateKeypair();
    kp.save(dir);
    const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
    const policy = loadPolicy({
      version: 1, default: "deny",
      rules: [{ id: "allow-read", when: { tool: "read" }, decision: "allow" }],
    });
    const gate = new Gate(policy, ledger, newActor("a"), { id: "s" }, { advisory: true });
    const ran: number[] = [];
    const r = await gate.call("write", { i: 0 }, ({ i }: any) => { ran.push(i); return "done"; });
    expect(ran).toEqual([0]);
    expect(r.decision).toBe("deny");
    expect(r.record.enforcement).toEqual({ point: "sdk", effect: "advisory" });

    const lines = readFileSync(join(dir, "ledger.jsonl"), "utf8").split("\n").filter(Boolean);
    const decisions = lines
      .map((l) => JSON.parse(l))
      .filter((rec) => rec.type !== "attestation");
    expect(decisions.length).toBe(1);
    expect(decisions[0].enforcement).toEqual({ point: "sdk", effect: "advisory" });
    expect(decisions[0].decision).toBe("deny");
  });

  it("replay reconstructs decisions from content-addressed snapshots", async () => {
    // Reviewer's core ask: given the ledger + snapshots, prove which
    // policy fired for each record — six months after the fact.
    const dir = mkdtempSync(join(tmpdir(), "custos-replay-"));
    const kp = generateKeypair();
    kp.save(dir);
    const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);

    const p1 = loadPolicy({
      version: 1, id: "t", default: "deny",
      rules: [{ id: "allow-read", when: { tool: "read" }, decision: "allow" }],
    });
    const g1 = new Gate(p1, ledger, newActor("a"), { id: "s" });
    await g1.call("read", { i: 0 }, () => 0);
    await g1.call("write", { i: 0 }, () => 0); // denied via default

    const p2 = loadPolicy({ version: 1, id: "t", default: "allow", rules: [] });
    const g2 = new Gate(p2, ledger, newActor("a"), { id: "s" });
    await g2.call("anything", {}, () => 1);

    const r = replayLedger(join(dir, "ledger.jsonl"));
    expect(r.ok).toBe(true);
    // 2 startup attestations + 3 decision records.
    expect(r.records).toBe(5);
    expect(r.replayed).toBe(3);
    expect(r.missingPolicies).toEqual([]);
    expect(r.mismatches).toEqual([]);
  });

  it("replay flags missing snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custos-miss-"));
    const kp = generateKeypair();
    kp.save(dir);
    const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
    const policy = loadPolicy({ version: 1, id: "t", default: "allow", rules: [] });
    const gate = new Gate(policy, ledger, newActor("a"), { id: "s" });
    await gate.call("t", {}, () => 1);

    // Nuke the snapshot to simulate lost source.
    for (const f of readdirSync(join(dir, "policies"))) {
      unlinkSync(join(dir, "policies", f));
    }
    const r = replayLedger(join(dir, "ledger.jsonl"));
    expect(r.ok).toBe(false);
    expect(r.missingPolicies.length).toBe(1);
    expect(r.missingPolicies[0]).toContain(policy.hash);
  });

  it("replay detects swapped policy (backdated policy attack)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custos-swap-"));
    const kp = generateKeypair();
    kp.save(dir);
    const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
    const policy = loadPolicy({
      version: 1, id: "t", default: "deny",
      rules: [{ id: "allow-read", when: { tool: "read" }, decision: "allow" }],
    });
    const gate = new Gate(policy, ledger, newActor("a"), { id: "s" });
    await gate.call("read", { i: 0 }, () => 0);

    // Overwrite the snapshot bytes but keep the filename that claims to
    // hash to policy.hash. The load-time hash check catches this.
    const hex = policy.hash.slice("sha256:".length);
    writeFileSyncFs(
      join(dir, "policies", `${hex}.json`),
      '{"version":1,"id":"t","default":"deny","rules":[]}',
    );

    const r = replayLedger(join(dir, "ledger.jsonl"));
    expect(r.ok).toBe(false);
    expect(r.mismatches.length).toBeGreaterThan(0);
  });

  it("multiple policy versions all preserved in bundle", async () => {
    // Rotate policy mid-ledger; the bundle MUST snapshot both versions so
    // every record's policy.hash is resolvable, not just the latest.
    const dir = mkdtempSync(join(tmpdir(), "custos-rot-"));
    const kp = generateKeypair();
    kp.save(dir);
    const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);

    const p1 = loadPolicy({ version: 1, id: "t", default: "allow", rules: [] });
    const g1 = new Gate(p1, ledger, newActor("a"), { id: "s" });
    await g1.call("t", { i: 0 }, () => 0);

    const p2 = loadPolicy({ version: 1, id: "t", default: "deny", rules: [] });
    expect(p1.hash).not.toBe(p2.hash);
    const g2 = new Gate(p2, ledger, newActor("a"), { id: "s" });
    await g2.call("t", { i: 1 }, () => 1);  // denied

    const hex1 = p1.hash.slice("sha256:".length);
    const hex2 = p2.hash.slice("sha256:".length);

    const out = join(dir, "bundle.tar.gz");
    await createBundle(join(dir, "ledger.jsonl"), join(dir, "ledger.pub"), out, kp);

    const gz = readFileSync(out);
    const tarBuf = await _gunzipBufferForTest(gz);
    const entries = _readTarForTest(tarBuf);
    const names = entries.map((e) => e.name);
    expect(names).toContain(`bundle/policies/${hex1}.json`);
    expect(names).toContain(`bundle/policies/${hex2}.json`);

    const r = await verifyBundle(out);
    expect(r.ok).toBe(true);
    // 2 startup attestations + 2 decision records.
    expect(r.records).toBe(4);
  });

  it("bundle policy tamper is caught via policies_hash", async () => {
    const { dir, kp, gate } = setup();
    await gate.call("read", { i: 0 }, () => 0);

    const policiesDir = join(dir, "policies");
    mkdirSync(policiesDir, { recursive: true });
    writeFileSync(join(policiesDir, "policy.yaml"), "version: 1\ndefault: allow\nrules: []\n");

    const out = join(dir, "bundle.tar.gz");
    await createBundle(join(dir, "ledger.jsonl"), join(dir, "ledger.pub"), out, kp, policiesDir);

    // Sanity: fresh bundle verifies + has policies_hash.
    const fresh = await verifyBundle(out);
    expect(fresh.ok).toBe(true);
    expect((fresh.manifest as any)?.policies_hash).toMatch(/^sha256:/);

    // Mutate the policy file inside the tarball, keep manifest+sig intact.
    const gz = readFileSync(out);
    const tarBuf = await _gunzipBufferForTest(gz);
    const entries = _readTarForTest(tarBuf);
    for (const e of entries) {
      if (e.name === "bundle/policies/policy.yaml") {
        e.data = Buffer.from("version: 1\ndefault: deny\nrules: []\n");
      }
    }
    const rebuilt = _buildTarForTest(entries);
    const rgz = await _gzipBufferForTest(rebuilt);
    const tamperedPath = join(dir, "tampered.tar.gz");
    writeFileSync(tamperedPath, rgz);

    const r = await verifyBundle(tamperedPath);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("policies_hash"))).toBe(true);
  });
});
