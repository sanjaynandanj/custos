import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDemo } from "../src/demo.js";

describe("custos demo", () => {
  it("runs 3 calls, verifies chain, cleans up", async () => {
    const r = await runDemo({ quiet: true });
    // 1 startup attestation + 3 demo calls.
    expect(r.records).toBe(4);
    expect(r.verified).toBe(true);
    expect(r.results.map((x) => x.decision)).toEqual(["allow", "deny", "deny"]);
    expect(r.results[1].rule).toBe("no-traversal");
    expect(r.results[2].rule).toBe("deny-shell");
  });

  it("--keep leaves ledger on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custos-demo-"));
    const r = await runDemo({ dir, keep: true, quiet: true });
    expect(r.dir).toBe(dir);
    // The ledger file exists — used further down the pipe for `custos verify`.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "ledger.jsonl"))).toBe(true);
  });
});
