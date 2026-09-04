import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeypair, publicKeyFromB64 } from "../src/keys.js";
import { Ledger } from "../src/ledger.js";
import { loadPolicy } from "../src/policy.js";
import { Gate } from "../src/sdk.js";
import { newActor } from "../src/record.js";
import {
  TOKEN_PREFIX, TokenError, generateToken, verifyToken,
} from "../src/token.js";

describe("per-call attestation tokens (WIRE §8)", () => {
  it("generate + verify roundtrips fields", () => {
    const kp = generateKeypair();
    const token = generateToken(
      kp, "01HXYZ", "abc123def456", "read_file", "sha256:aaaa",
      "2026-08-08T12:34:56.789Z",
    );
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);

    const pub = publicKeyFromB64(kp.publicB64());
    const v = verifyToken(pub, token);
    expect(v.payload.trace_id).toBe("01HXYZ");
    expect(v.payload.span_id).toBe("abc123def456");
    expect(v.payload.tool).toBe("read_file");
    expect(v.payload.args_hash).toBe("sha256:aaaa");
    expect(v.payload.ts).toBe("2026-08-08T12:34:56.789Z");
    expect(v.payload.kid.length).toBeGreaterThan(0);
  });

  it("rejects wrong key", () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    const token = generateToken(kp1, "t", "s", "read", "sha256:x", "2026-01-01T00:00:00.000Z");
    expect(() => verifyToken(publicKeyFromB64(kp2.publicB64()), token)).toThrow(TokenError);
  });

  it("rejects tampered payload", () => {
    const kp = generateKeypair();
    const token = generateToken(kp, "t", "s", "read", "sha256:x", "2026-01-01T00:00:00.000Z");
    const [rest, sig] = token.slice(TOKEN_PREFIX.length).split(".");
    const flipped = rest![10] === "A" ? "B" : "A";
    const tampered = TOKEN_PREFIX + rest!.slice(0, 10) + flipped + rest!.slice(11) + "." + sig;
    expect(() => verifyToken(publicKeyFromB64(kp.publicB64()), tampered)).toThrow(TokenError);
  });

  it("rejects malformed tokens", () => {
    const kp = generateKeypair();
    const pub = publicKeyFromB64(kp.publicB64());
    expect(() => verifyToken(pub, "not-a-custos-token")).toThrow(TokenError);
    expect(() => verifyToken(pub, TOKEN_PREFIX + "no-dot-here")).toThrow(TokenError);
    expect(() => verifyToken(pub, TOKEN_PREFIX + "!!!.???")).toThrow(TokenError);
  });

  it("Gate.call allow populates token; deny does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custos-tok-"));
    const kp = generateKeypair();
    kp.save(dir);
    const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
    const policy = loadPolicy({
      version: 1, default: "deny",
      rules: [{ id: "allow-read", when: { tool: "read" }, decision: "allow" }],
    });
    const gate = new Gate(policy, ledger, newActor("a"), { id: "s" });

    const allowed = await gate.call("read", { i: 0 }, () => 0);
    expect(allowed.allowed).toBe(true);
    expect(allowed.token).toBeTruthy();
    const v = verifyToken(publicKeyFromB64(kp.publicB64()), allowed.token!);
    expect(v.payload.tool).toBe("read");
    expect(v.payload.trace_id).toBe(allowed.record.trace_id);
    expect(v.payload.args_hash).toBe(allowed.record.args_hash);

    const denied = await gate.call("write", { i: 0 }, () => 0);
    expect(denied.allowed).toBe(false);
    expect(denied.token).toBeUndefined();
  });
});
