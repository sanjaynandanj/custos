import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { canonicalBytes } from "./canonical.js";
import { publicKeyFromB64, verifySignature } from "./keys.js";
import { GENESIS_PREV_HASH } from "./record.js";

export interface VerifyResult {
  ok: boolean;
  records: number;
  errors: string[];
}

export function verifyLedger(ledgerPath: string, pubkeyPath?: string): VerifyResult {
  if (!existsSync(ledgerPath)) return { ok: false, records: 0, errors: ["ledger file not found"] };
  const pubPath = pubkeyPath ?? join(dirname(ledgerPath), basename(ledgerPath, extname(ledgerPath)) + ".pub");
  const pubB64 = readFileSync(pubPath, "utf8").trim();
  const pub = publicKeyFromB64(pubB64);

  let expectedSeq = 0;
  let expectedPrev = GENESIS_PREV_HASH;
  let count = 0;

  const data = readFileSync(ledgerPath, "utf8");
  const lines = data.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(raw); } catch (e) {
      return { ok: false, records: count, errors: [`line ${i + 1}: invalid JSON: ${e}`] };
    }
    if (rec.seq !== expectedSeq) return { ok: false, records: count, errors: [`line ${i + 1}: seq mismatch (got ${rec.seq}, expected ${expectedSeq})`] };
    if (rec.prev_hash !== expectedPrev) return { ok: false, records: count, errors: [`line ${i + 1}: prev_hash mismatch`] };
    const { record_hash, sig, ...body } = rec;
    const computed = "sha256:" + createHash("sha256").update(canonicalBytes(body)).digest("hex");
    if (computed !== record_hash) return { ok: false, records: count, errors: [`line ${i + 1}: record_hash mismatch`] };
    if (typeof sig !== "string" || !sig.startsWith("ed25519:")) return { ok: false, records: count, errors: [`line ${i + 1}: sig format invalid`] };
    const sigBytes = Buffer.from(sig.slice(8), "base64");
    const digest = Buffer.from(computed.slice(7), "hex");
    if (!verifySignature(pub, sigBytes, digest)) return { ok: false, records: count, errors: [`line ${i + 1}: invalid signature`] };
    expectedSeq += 1;
    expectedPrev = computed;
    count += 1;
  }
  return { ok: true, records: count, errors: [] };
}
