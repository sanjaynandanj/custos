import { randomBytes } from "node:crypto";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newTraceId(): string {
  const tsMs = BigInt(Date.now());
  const tsBuf = Buffer.alloc(6);
  tsBuf.writeUIntBE(Number(tsMs & 0xffffffffffffn), 0, 6);
  const rand = randomBytes(10);
  const raw = Buffer.concat([tsBuf, rand]);
  // 16 bytes -> 128 bits -> 26 base32 chars
  let bits = 0n;
  for (const b of raw) bits = (bits << 8n) | BigInt(b);
  const out = new Array<string>(26);
  for (let i = 25; i >= 0; i--) {
    out[i] = ULID_ALPHABET[Number(bits & 0x1fn)]!;
    bits >>= 5n;
  }
  return out.join("");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function isoNowMs(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return (
    d.getUTCFullYear() + "-" +
    pad(d.getUTCMonth() + 1) + "-" +
    pad(d.getUTCDate()) + "T" +
    pad(d.getUTCHours()) + ":" +
    pad(d.getUTCMinutes()) + ":" +
    pad(d.getUTCSeconds()) + "." +
    pad(d.getUTCMilliseconds(), 3) + "Z"
  );
}
