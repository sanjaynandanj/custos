import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../src/init.js";
import { loadPolicy } from "../src/policy.js";
import { loadKeypair } from "../src/keys.js";

describe("custos init", () => {
  it("scaffolds keypair, policy, and .gitignore", () => {
    const dir = mkdtempSync(join(tmpdir(), "custos-init-"));
    const target = join(dir, ".custos");
    const r = runInit({ dir: target });

    expect(r.created).toContain("ledger.key");
    expect(r.created).toContain("ledger.pub");
    expect(r.created).toContain("policy.yaml");
    expect(r.created).toContain(".gitignore");
    expect(r.pubkey.length).toBeGreaterThan(0);

    // Policy is a valid parse.
    const p = loadPolicy(join(target, "policy.yaml"));
    expect(p.id).toBe("starter");
    expect(p.rules.length).toBeGreaterThan(0);

    // Keypair round-trips.
    const kp = loadKeypair(target);
    expect(kp.publicB64()).toBe(r.pubkey);

    // Secret is gitignored.
    const gi = readFileSync(join(target, ".gitignore"), "utf8");
    expect(gi).toMatch(/ledger\.key/);
  });

  it("second init preserves keypair", () => {
    const dir = mkdtempSync(join(tmpdir(), "custos-init-"));
    const target = join(dir, ".custos");
    const first = runInit({ dir: target });
    const second = runInit({ dir: target });
    expect(second.pubkey).toBe(first.pubkey);
    expect(second.skipped).toContain("ledger.key");
    expect(second.skipped).toContain("policy.yaml");
  });

  it("--force overwrites keypair", () => {
    const dir = mkdtempSync(join(tmpdir(), "custos-init-"));
    const target = join(dir, ".custos");
    const first = runInit({ dir: target });
    const second = runInit({ dir: target, force: true });
    expect(second.pubkey).not.toBe(first.pubkey);
    expect(existsSync(join(target, "ledger.key"))).toBe(true);
  });
});
