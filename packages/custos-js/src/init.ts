import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { generateKeypair, loadKeypair } from "./keys.js";

export interface InitOptions {
  dir?: string;
  force?: boolean;
}

export interface InitResult {
  dir: string;
  created: string[];
  skipped: string[];
  pubkey: string;
}

const STARTER_POLICY = `# Custos policy — evaluated top-to-bottom, first match wins.
# See https://github.com/sanjaynandanj/custos for the full grammar.
version: 1
id: starter
default: deny
rules:
  - id: no-traversal
    when:
      args.path: {contains: ".."}
    decision: deny
    reason: path traversal blocked

  - id: allow-workspace-read
    when:
      tool: read_file
      args.path: {prefix: "/workspace/"}
    decision: allow
    reason: workspace-only reads

  - id: safe-http-get
    when:
      tool: http_request
      args.method: {in: ["GET", "HEAD"]}
      args.url: {regex: "^https://"}
    decision: allow
    reason: HTTPS GET/HEAD

  - id: deny-shell
    when:
      tool: {regex: "^shell\\\\."}
    decision: deny
    reason: shell tools disabled
`;

const GITIGNORE = `# Ledger signing key — never commit
ledger.key
# Ledger data — audit artefacts, ship via \`custos bundle\` instead
ledger.jsonl
`;

export function runInit(opts: InitOptions = {}): InitResult {
  const dir = resolve(opts.dir ?? "./.custos");
  mkdirSync(dir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  const write = (name: string, contents: string | Buffer) => {
    const p = join(dir, name);
    if (existsSync(p) && !opts.force) { skipped.push(name); return; }
    writeFileSync(p, contents);
    created.push(name);
  };

  const keyPath = join(dir, "ledger.key");
  const pubPath = join(dir, "ledger.pub");
  let pubkey: string;
  if (existsSync(keyPath) && existsSync(pubPath) && !opts.force) {
    skipped.push("ledger.key", "ledger.pub");
    pubkey = loadKeypair(dir).publicB64();
  } else {
    const kp = generateKeypair();
    kp.save(dir);
    created.push("ledger.key", "ledger.pub");
    pubkey = kp.publicB64();
  }

  write("policy.yaml", STARTER_POLICY);
  write(".gitignore", GITIGNORE);

  return { dir, created, skipped, pubkey };
}
