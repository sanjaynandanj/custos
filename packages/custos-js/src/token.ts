/**
 * Per-call attestation tokens (WIRE §8, added in v0.4.0).
 *
 * A **call attestation token** is a tiny, self-contained proof that a
 * specific tool call passed the Custos gate. The proxy (or SDK)
 * generates one on every `allow` decision and injects it into the
 * forwarded call's `_meta.custos_token`. A cooperating tool server
 * verifies the token before executing and logs verified / rejected /
 * unattested calls.
 *
 * Without downstream cooperation, the Custos ledger proves properties
 * about the calls that reached it — not that those were all the calls.
 * Attestation tokens close that gap: cross-checking the tool server's
 * "verified / unattested" log against the Custos ledger proves coverage
 * cryptographically.
 *
 * Format (URL-safe, no padding):
 *
 *     custos:v1:<b64url(canonical_json(payload))>.<b64url(ed25519_sig)>
 *
 * Payload fields: trace_id, span_id, tool, args_hash, ts, kid (short
 * public-key fingerprint for multi-issuer routing).
 */
import { createHash, KeyObject, sign as edSign, verify as edVerify } from "node:crypto";

import { canonicalBytes } from "./canonical.js";
import { KeyPair } from "./keys.js";

export const TOKEN_PREFIX = "custos:v1:";

export interface TokenPayload {
  trace_id: string;
  span_id: string;
  tool: string;
  args_hash: string;
  ts: string;
  kid: string;
}

export interface VerifiedToken {
  payload: TokenPayload;
}

export class TokenError extends Error {}

function b64urlEncode(data: Uint8Array): string {
  return Buffer.from(data).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = "=".repeat((-s.length) & 3);
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/** 8-byte fingerprint of the public key, base64url (no pad). */
export function kidFor(pubkeyBytes: Uint8Array): string {
  const digest = createHash("sha256").update(pubkeyBytes).digest();
  return b64urlEncode(digest.subarray(0, 8));
}

/** Sign a per-call attestation token. Returns the full token string. */
export function generateToken(
  kp: KeyPair,
  trace_id: string,
  span_id: string,
  tool: string,
  args_hash: string,
  ts: string,
): string {
  const payload: TokenPayload = {
    trace_id, span_id, tool, args_hash, ts,
    kid: kidFor(kp.publicRaw()),
  };
  const body = canonicalBytes(payload as unknown as Record<string, unknown>);
  const sig = kp.sign(Buffer.from(body));
  return TOKEN_PREFIX + b64urlEncode(body) + "." + b64urlEncode(sig);
}

/**
 * Verify a token against a public key. Throws `TokenError` on any
 * format or signature failure. The token is intentionally checked ONLY
 * for signature integrity — the caller is responsible for freshness
 * (age-of-`ts` policy), which is application-specific.
 */
export function verifyToken(pubkey: KeyObject, token: string): VerifiedToken {
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new TokenError(`invalid token prefix; expected ${TOKEN_PREFIX}`);
  }
  const rest = token.slice(TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot < 0) throw new TokenError("token missing '.' separator");
  const payloadB64 = rest.slice(0, dot);
  const sigB64 = rest.slice(dot + 1);
  let body: Buffer, sig: Buffer;
  try {
    body = b64urlDecode(payloadB64);
    sig = b64urlDecode(sigB64);
  } catch (e) {
    throw new TokenError(`token b64url decode failed: ${e}`);
  }
  if (!edVerify(null, body, pubkey, sig)) {
    throw new TokenError("token signature invalid");
  }
  let d: any;
  try {
    d = JSON.parse(body.toString("utf8"));
  } catch (e) {
    throw new TokenError(`token payload not JSON: ${e}`);
  }
  const required = ["trace_id", "span_id", "tool", "args_hash", "ts", "kid"] as const;
  const missing = required.filter((k) => !(k in d));
  if (missing.length > 0) {
    throw new TokenError(`token payload missing fields: ${missing.join(",")}`);
  }
  return {
    payload: {
      trace_id: d.trace_id, span_id: d.span_id, tool: d.tool,
      args_hash: d.args_hash, ts: d.ts, kid: d.kid,
    },
  };
}
