import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync, fsyncSync, writeSync } from "node:fs";
import { dirname, join, basename, extname } from "node:path";

import { canonicalBytes } from "./canonical.js";
import { KeyPair } from "./keys.js";
import { DecisionRecord, GENESIS_PREV_HASH, recordBody } from "./record.js";

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
