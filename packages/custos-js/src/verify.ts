import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { canonicalBytes } from "./canonical.js";
import { publicKeyFromB64, verifySignature } from "./keys.js";
import { loadPolicy } from "./policy.js";
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

/**
 * Point-in-time policy replay (see spec/WIRE.md §5.1 / §6.1).
 *
 * Walks each record, resolves the policy at `record.policy.hash` from a
 * content-addressed snapshot directory, and asserts that the recorded
 * rule (or default) is consistent with the loaded policy's text — the
 * policy at that hash actually defines the rule the record claims fired
 * and with the same decision.
 *
 * Does NOT verify that the recorded arguments actually satisfy the
 * rule's `when` clauses. Records store `args_hash`, not `args`, to keep
 * tool inputs out of the audit surface. Argument-level replay requires
 * an out-of-band args log. This is intentional; see the "What Custos
 * proves" doc.
 */
export interface ReplayResult {
  ok: boolean;
  records: number;
  replayed: number;
  skippedNoHash: number;
  missingPolicies: string[];
  mismatches: string[];
}

export function replayLedger(ledgerPath: string, policiesDir?: string): ReplayResult {
  if (!existsSync(ledgerPath)) {
    return { ok: false, records: 0, replayed: 0, skippedNoHash: 0,
             missingPolicies: ["ledger file not found"], mismatches: [] };
  }
  const dir = policiesDir ?? join(dirname(ledgerPath), "policies");

  const missing: string[] = [];
  const mismatches: string[] = [];
  let records = 0;
  let replayed = 0;
  let skippedNoHash = 0;
  // Cache loaded policies by hash — the same policy commonly pins
  // hundreds of thousands of consecutive records.
  const cache = new Map<string, ReturnType<typeof loadPolicy>>();
  // Cache dir listing so we don't readdirSync per record.
  const dirEntries: string[] = existsSync(dir) && statSync(dir).isDirectory()
    ? readdirSync(dir)
    : [];

  const lines = readFileSync(ledgerPath, "utf8").split("\n");
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const rec = JSON.parse(raw);
    records += 1;
    const policyHash: string = (rec.policy?.hash ?? "");
    if (!policyHash) { skippedNoHash += 1; continue; }
    if (!cache.has(policyHash)) {
      const hex = policyHash.includes(":") ? policyHash.split(":", 2)[1]! : policyHash;
      // Content-addressed lookup: glob by prefix so extension can vary.
      const match = dirEntries.find((n) => n.startsWith(hex + "."));
      if (!match) {
        missing.push(`seq ${rec.seq}: no snapshot for policy ${policyHash} in ${dir}`);
        continue;
      }
      let loaded;
      try {
        loaded = loadPolicy(join(dir, match));
      } catch (e) {
        mismatches.push(`seq ${rec.seq}: failed to load policy ${policyHash}: ${e}`);
        continue;
      }
      if (loaded.hash !== policyHash) {
        mismatches.push(
          `seq ${rec.seq}: loaded policy hash ${loaded.hash} does not match snapshot filename ${policyHash}`,
        );
        continue;
      }
      cache.set(policyHash, loaded);
    }
    const pol = cache.get(policyHash)!;
    replayed += 1;

    // "error" decisions come from tool execution, not policy evaluation.
    if (rec.decision === "error") continue;

    const ruleId: string = rec.policy?.rule ?? "";
    const recorded: string = rec.decision;
    if (!ruleId) {
      if (recorded !== pol.defaultDecision) {
        mismatches.push(
          `seq ${rec.seq}: no rule fired but recorded decision ${JSON.stringify(recorded)} != policy default ${JSON.stringify(pol.defaultDecision)}`,
        );
      }
      continue;
    }
    const match = pol.rules.find((r) => r.id === ruleId);
    if (!match) {
      mismatches.push(`seq ${rec.seq}: policy ${policyHash} has no rule "${ruleId}"`);
      continue;
    }
    if (match.decision !== recorded) {
      mismatches.push(
        `seq ${rec.seq}: rule "${ruleId}" decides ${JSON.stringify(match.decision)} but record says ${JSON.stringify(recorded)}`,
      );
    }
  }

  const ok = missing.length === 0 && mismatches.length === 0;
  return { ok, records, replayed, skippedNoHash, missingPolicies: missing, mismatches };
}

/**
 * Coverage gap: an interval between two consecutive attestations that
 * exceeded `intervalMs * tolerance`. Auditors reading this list know
 * which time-ranges are unaccounted for by the ledger.
 */
export interface CoverageGap {
  fromTs: string;
  toTs: string;
  durationS: number;
}

export interface CoverageResult {
  ok: boolean;
  records: number;
  attestations: number;
  firstTs: string;
  lastTs: string;
  windowS: number;
  byReason: Record<string, number>;
  gaps: CoverageGap[];
  maxGapS: number;
  totalGapS: number;
  intervalS: number;
  tolerance: number;
}

/**
 * Analyze attestation cadence to bracket periods of observable
 * operation and flag gaps that exceed `intervalS * tolerance`.
 *
 * See spec/WIRE.md §2.3. Requires the operator to have emitted
 * periodic attestations on the expected cadence — otherwise gaps are
 * ambiguous ("stopped observing" vs "nothing happened").
 */
export function verifyCoverage(
  ledgerPath: string,
  intervalS = 60.0,
  tolerance = 2.0,
): CoverageResult {
  const r: CoverageResult = {
    ok: true, records: 0, attestations: 0,
    firstTs: "", lastTs: "", windowS: 0,
    byReason: {}, gaps: [], maxGapS: 0, totalGapS: 0,
    intervalS, tolerance,
  };
  if (!existsSync(ledgerPath)) { r.ok = false; return r; }

  const stamps: { ts: string; reason: string }[] = [];
  const lines = readFileSync(ledgerPath, "utf8").split("\n");
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const rec = JSON.parse(raw);
    r.records += 1;
    if (rec.type !== "attestation") continue;
    r.attestations += 1;
    const reason = rec.attestation?.reason ?? "unknown";
    r.byReason[reason] = (r.byReason[reason] ?? 0) + 1;
    stamps.push({ ts: rec.ts, reason });
  }

  if (stamps.length === 0) { r.ok = false; return r; }
  r.firstTs = stamps[0]!.ts;
  r.lastTs = stamps[stamps.length - 1]!.ts;
  const firstS = new Date(r.firstTs).getTime() / 1000;
  const lastS = new Date(r.lastTs).getTime() / 1000;
  r.windowS = Math.max(0, lastS - firstS);

  const threshold = intervalS * tolerance;
  let prevS = firstS;
  let prevTs = r.firstTs;
  for (let i = 1; i < stamps.length; i++) {
    const curTs = stamps[i]!.ts;
    const curS = new Date(curTs).getTime() / 1000;
    const delta = curS - prevS;
    if (delta > threshold) {
      r.gaps.push({ fromTs: prevTs, toTs: curTs, durationS: delta });
      r.totalGapS += delta;
      if (delta > r.maxGapS) r.maxGapS = delta;
    }
    prevS = curS;
    prevTs = curTs;
  }
  r.ok = r.gaps.length === 0;
  return r;
}
