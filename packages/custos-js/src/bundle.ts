import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { createGzip, createGunzip } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";

import { canonicalBytes } from "./canonical.js";
import { publicKeyFromB64, verifySignature, KeyPair } from "./keys.js";
import { verifyLedger, VerifyResult } from "./verify.js";

// Minimal ustar tar writer/reader — sufficient for our bundle format.

interface TarEntry { name: string; data: Buffer; }

function tarPad(n: number): number { return (512 - (n % 512)) % 512; }

function buildTar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    const header = Buffer.alloc(512, 0);
    header.write(e.name.slice(0, 100), 0, "utf8");
    header.write("0000644", 100, "ascii"); // mode
    header.write("0000000", 108, "ascii"); // uid
    header.write("0000000", 116, "ascii"); // gid
    header.write(e.data.length.toString(8).padStart(11, "0"), 124, "ascii"); // size
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0"), 136, "ascii"); // mtime
    header.write("        ", 148, "ascii"); // chksum placeholder
    header.write("0", 156, "ascii"); // typeflag
    header.write("ustar  ", 257, "ascii");
    // checksum
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    chunks.push(header, e.data, Buffer.alloc(tarPad(e.data.length), 0));
  }
  chunks.push(Buffer.alloc(1024, 0)); // end marker
  return Buffer.concat(chunks);
}

async function gzipBuffer(buf: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(Readable.from(buf), createGzip(), new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  }));
  return Buffer.concat(chunks);
}

async function gunzipBuffer(buf: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(Readable.from(buf), createGunzip(), new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  }));
  return Buffer.concat(chunks);
}

function readTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const nameEnd = header.indexOf(0, 0);
    const name = header.subarray(0, nameEnd >= 0 && nameEnd < 100 ? nameEnd : 100).toString("utf8");
    const sizeStr = header.subarray(124, 135).toString("ascii").replace(/\0/g, "").trim();
    const size = parseInt(sizeStr, 8);
    off += 512;
    const data = buf.subarray(off, off + size);
    entries.push({ name, data: Buffer.from(data) });
    off += size + tarPad(size);
  }
  return entries;
}

export async function createBundle(
  ledgerPath: string, pubkeyPath: string, output: string, kp: KeyPair, policiesDir?: string,
): Promise<string> {
  const ledger = readFileSync(ledgerPath);
  const pub = readFileSync(pubkeyPath);
  let records = 0;
  for (const line of ledger.toString("utf8").split("\n")) if (line.trim()) records++;
  const manifest = {
    v: 1,
    created: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    records,
    pubkey: pub.toString("ascii").trim(),
  };
  const manifestBytes = canonicalBytes(manifest);
  const digest = createHash("sha256").update(manifestBytes).digest();
  const sig = "ed25519:" + kp.sign(digest).toString("base64");

  const entries: TarEntry[] = [
    { name: "bundle/manifest.json", data: Buffer.from(manifestBytes) },
    { name: "bundle/manifest.sig", data: Buffer.from(sig, "ascii") },
    { name: "bundle/ledger.jsonl", data: ledger },
    { name: "bundle/ledger.pub", data: pub },
  ];
  if (policiesDir && existsSync(policiesDir)) {
    // simple non-recursive add of top-level files
    for (const f of readdirSync(policiesDir)) {
      const full = join(policiesDir, f);
      if (statSync(full).isFile()) {
        entries.push({ name: `bundle/policies/${f}`, data: readFileSync(full) });
      }
    }
  }
  const tar = buildTar(entries);
  const gz = await gzipBuffer(tar);
  writeFileSync(output, gz);
  return output;
}

export async function verifyBundle(path: string): Promise<VerifyResult & { manifest?: unknown }> {
  const gz = readFileSync(path);
  const tar = await gunzipBuffer(gz);
  const entries = readTar(tar);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const manifestBytes = byName.get("bundle/manifest.json");
  const sig = byName.get("bundle/manifest.sig")?.toString("ascii").trim();
  const ledger = byName.get("bundle/ledger.jsonl");
  const pubB64 = byName.get("bundle/ledger.pub")?.toString("ascii").trim();
  if (!manifestBytes || !sig || !ledger || !pubB64) return { ok: false, records: 0, errors: ["bundle incomplete"] };
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const pub = publicKeyFromB64(pubB64);
  const digest = createHash("sha256").update(canonicalBytes(manifest)).digest();
  if (!sig.startsWith("ed25519:")) return { ok: false, records: 0, errors: ["manifest sig format invalid"] };
  if (!verifySignature(pub, Buffer.from(sig.slice(8), "base64"), digest)) {
    return { ok: false, records: 0, errors: ["manifest signature invalid"] };
  }
  const td = mkdtempSync(join(tmpdir(), "custos-bundle-"));
  try {
    writeFileSync(join(td, "ledger.jsonl"), ledger);
    writeFileSync(join(td, "ledger.pub"), pubB64);
    const r = verifyLedger(join(td, "ledger.jsonl"), join(td, "ledger.pub"));
    return { ...r, manifest };
  } finally {
    rmSync(td, { recursive: true, force: true });
  }
}
