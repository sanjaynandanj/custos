import { generateKeyPairSync, sign as edSign, verify as edVerify, createPrivateKey, createPublicKey, KeyObject } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";

export class KeyPair {
  constructor(public privateKey: KeyObject, public publicKey: KeyObject) {}

  publicRaw(): Buffer {
    // Extract raw 32-byte ed25519 public key from DER SPKI.
    const der = this.publicKey.export({ format: "der", type: "spki" });
    return der.subarray(der.length - 32);
  }

  privateRaw(): Buffer {
    const der = this.privateKey.export({ format: "der", type: "pkcs8" });
    return der.subarray(der.length - 32);
  }

  publicB64(): string {
    return this.publicRaw().toString("base64");
  }

  sign(data: Uint8Array): Buffer {
    return edSign(null, data, this.privateKey);
  }

  save(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const priv = join(dir, "ledger.key");
    const pub = join(dir, "ledger.pub");
    writeFileSync(priv, Buffer.from(this.privateRaw().toString("base64")));
    writeFileSync(pub, Buffer.from(this.publicRaw().toString("base64")));
    try { chmodSync(priv, 0o600); } catch { /* ignore on Windows */ }
  }
}

export function generateKeypair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return new KeyPair(privateKey, publicKey);
}

// PKCS8 DER prefix for Ed25519 private key (32-byte seed).
const PKCS8_ED25519_PREFIX = Buffer.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

// SPKI DER prefix for Ed25519 public key.
const SPKI_ED25519_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
  0x70, 0x03, 0x21, 0x00,
]);

export function loadKeypair(dir: string): KeyPair {
  const rawPriv = Buffer.from(readFileSync(join(dir, "ledger.key"), "utf8").trim(), "base64");
  const rawPub = Buffer.from(readFileSync(join(dir, "ledger.pub"), "utf8").trim(), "base64");
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, rawPriv]),
    format: "der",
    type: "pkcs8",
  });
  const pub = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, rawPub]),
    format: "der",
    type: "spki",
  });
  return new KeyPair(priv, pub);
}

export function publicKeyFromB64(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64");
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function verifySignature(pub: KeyObject, sig: Uint8Array, data: Uint8Array): boolean {
  return edVerify(null, data, pub, sig);
}
