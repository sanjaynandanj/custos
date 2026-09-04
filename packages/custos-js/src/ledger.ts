import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync, fsyncSync, writeSync } from "node:fs";
import { dirname, join, basename, extname } from "node:path";

import { canonicalBytes } from "./canonical.js";
import { newSpanId, newTraceId, isoNowMs } from "./ids.js";
import { KeyPair } from "./keys.js";
import {
  AttestationRecord, AttestationReason, DecisionRecord, GENESIS_PREV_HASH,
  attestationBody, recordBody,
} from "./record.js";

export class LedgerError extends Error {}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashOfValue(value: unknown): string {
  return "sha256:" + sha256Hex(canonicalBytes(value));
}

function seal(record: DecisionRecord, kp: KeyPair): void {
  const body = canonicalBytes(recordBody(record));
  const hash = "sha256:" + sha256Hex(body);
  record.record_hash = hash;
  const digest = Buffer.from(hash.slice(7), "hex");
  const sig = kp.sign(digest);
  record.sig = "ed25519:" + sig.toString("base64");
}

export class Ledger {
  private _seq = 0;
  private _prev = GENESIS_PREV_HASH;

  constructor(public readonly path: string, private kp: KeyPair) {
    mkdirSync(dirname(path), { recursive: true });
    this.recoverTail();
    // pubkey sidecar
    const stem = basename(path, extname(path));
    writeFileSync(join(dirname(path), stem + ".pub"), kp.publicB64());
  }

  private recoverTail(): void {
    if (!existsSync(this.path)) return;
    const size = statSync(this.path).size;
    if (size === 0) return;
    const fd = openSync(this.path, "r");
    const readBytes = Math.min(8192, size);
    const buf = Buffer.alloc(readBytes);
    readSync(fd, buf, 0, readBytes, size - readBytes);
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return;
    const last = JSON.parse(lines[lines.length - 1]!);
    this._seq = last.seq + 1;
    this._prev = last.record_hash;
  }

  /**
   * Append a decision record to the ledger.
   *
   * Concurrency: this method is synchronous by design — it uses openSync /
   * writeSync / closeSync and mutates in-memory chain state (seq, prev)
   * atomically within a single event-loop tick. Concurrent calls from
   * multiple event-loop tasks on the same Ledger instance therefore
   * serialize naturally (JS is single-threaded within an isolate).
   *
   * Cross-instance or cross-process concurrent writes to the same ledger
   * file are UNSAFE: seq/prev_hash state is per-instance and the hash chain
   * will diverge. Use a single Ledger per file. For higher-security
   * deployments consider re2 for policy regex evaluation as well.
   */
  append(record: DecisionRecord): DecisionRecord {
    record.seq = this._seq;
    record.prev_hash = this._prev;
    seal(record, this.kp);
    // Serialize full record (with sealed fields) canonically
    const full = { ...recordBody(record), record_hash: record.record_hash, sig: record.sig };
    const line = Buffer.concat([canonicalBytes(full), Buffer.from("\n")]);
    const fd = openSync(this.path, "a");
    try {
      writeToFd(fd, line);
      try { fsyncSync(fd); } catch { /* ignore */ }
    } finally {
      closeSync(fd);
    }
    this._seq += 1;
    this._prev = record.record_hash!;
    return record;
  }

  /**
   * Append a signed attestation record to the chain (WIRE §2.3).
   *
   * Attestations share the ledger's hash chain and signing key with
   * decisions, so a verifier reading the same file gets a single
   * timeline of "what the control was doing and whether it was alive."
   */
  appendAttestation(opts: {
    reason: AttestationReason;
    custosVersion: string;
    policyHash?: string;
    activeActors?: string[];
    uptimeMs?: number;
    traceId?: string;
  }): AttestationRecord {
    const rec: AttestationRecord = {
      v: 1,
      seq: this._seq,
      ts: isoNowMs(),
      trace_id: opts.traceId ?? newTraceId(),
      span_id: newSpanId(),
      prev_hash: this._prev,
      type: "attestation",
      attestation: {
        reason: opts.reason,
        custos_version: opts.custosVersion,
        policy_hash: opts.policyHash ?? "",
        active_actors: opts.activeActors ?? [],
        uptime_ms: opts.uptimeMs ?? 0,
      },
    };
    const body = canonicalBytes(attestationBody(rec));
    const recordHash = "sha256:" + sha256Hex(body);
    rec.record_hash = recordHash;
    const digest = Buffer.from(recordHash.slice(7), "hex");
    const sig = this.kp.sign(digest);
    rec.sig = "ed25519:" + sig.toString("base64");
    const full = { ...attestationBody(rec), record_hash: recordHash, sig: rec.sig };
    const line = Buffer.concat([canonicalBytes(full), Buffer.from("\n")]);
    const fd = openSync(this.path, "a");
    try {
      writeToFd(fd, line);
      try { fsyncSync(fd); } catch { /* ignore */ }
    } finally {
      closeSync(fd);
    }
    this._seq += 1;
    this._prev = recordHash;
    return rec;
  }

  *iterRecords(): Generator<DecisionRecord> {
    if (!existsSync(this.path)) return;
    const data = readFileSync(this.path, "utf8");
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      yield JSON.parse(line);
    }
  }

  get seq(): number { return this._seq; }
  get head(): string { return this._prev; }
}

function writeToFd(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    offset += writeSync(fd, buf, offset, buf.length - offset);
  }
}
