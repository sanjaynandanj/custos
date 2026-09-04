import { mkdirSync, existsSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  createBundle,
  Gate,
  Ledger,
  KeyPair,
  generateKeypair,
  loadKeypair,
  newActor,
  verifyLedger,
  type VerifyResult,
  type Policy,
  type Actor,
  type Server,
} from "custos-mcp";

import type { ApprovalEvent } from "./approvals.js";

/**
 * Owns the Custos Gate/Ledger for the demo, plus a parallel *unsigned*
 * approval-events journal. We intentionally keep the two streams separate:
 * only the Custos ledger is Ed25519-signed and hash-chained. Approval
 * lifecycle events are recorded so the UI can reconstruct the story, but
 * they are labelled distinctly to avoid overclaiming cryptographic
 * guarantees.
 */
export interface CustosStack {
  gate: Gate;
  ledger: Ledger;
  keypair: KeyPair;
  approvalJournalPath: string;
  ledgerPath: string;
  publicKeyPath: string;
  policiesDir: string;
  actor: Actor;
  server: Server;

  appendApprovalEvent(ev: ApprovalEvent): void;
  readApprovalEvents(): ApprovalEvent[];
  verify(): VerifyResult;
  reset(): void;
  buildEvidenceBundle(outPath: string): Promise<string>;
}

export interface CustosStackOptions {
  dir: string;
  policy: Policy;
  policyYaml?: string;
  actor?: Actor;
  server?: Server;
}

export function createCustosStack(opts: CustosStackOptions): CustosStack {
  const { dir, policy } = opts;
  mkdirSync(dir, { recursive: true });
  const ledgerPath = join(dir, "ledger.jsonl");
  const publicKeyPath = join(dir, "ledger.pub");
  const approvalJournalPath = join(dir, "approval-events.jsonl");
  const policiesDir = join(dir, "policies");
  mkdirSync(policiesDir, { recursive: true });

  // Persist the policy YAML so createBundle() can include it in the signed
  // manifest (Custos bundle format v0.3.0 includes a policies_hash so the
  // policy that produced the ledger is provably part of the evidence).
  if (opts.policyYaml) {
    writeFileSync(join(policiesDir, "control-room.yaml"), opts.policyYaml);
  }

  const kp = loadOrCreate(dir);
  const ledger = new Ledger(ledgerPath, kp);
  const actor =
    opts.actor ?? newActor("web-agent", "webmcp-agent", { origin: "browser" });
  const srv: Server = opts.server ?? {
    id: "custos.webmcp.control-room",
    pubkey: kp.publicB64(),
  };
  const gate = new Gate(policy, ledger, actor, srv);

  const stack: CustosStack = {
    gate,
    ledger,
    keypair: kp,
    ledgerPath,
    publicKeyPath,
    approvalJournalPath,
    policiesDir,
    actor,
    server: srv,
    appendApprovalEvent(ev) {
      mkdirSync(dirname(approvalJournalPath), { recursive: true });
      appendFileSync(approvalJournalPath, JSON.stringify(ev) + "\n");
    },
    readApprovalEvents() {
      if (!existsSync(approvalJournalPath)) return [];
      const data = readFileSync(approvalJournalPath, "utf8");
      const out: ApprovalEvent[] = [];
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          /* skip malformed */
        }
      }
      return out;
    },
    verify() {
      return verifyLedger(ledgerPath, publicKeyPath);
    },
    reset() {
      writeFileSync(ledgerPath, "");
      writeFileSync(approvalJournalPath, "");
      // rebuild ledger to reset its seq counter
      const fresh = new Ledger(ledgerPath, kp);
      (stack as any).ledger = fresh;
      (stack as any).gate = new Gate(policy, fresh, actor, srv);
    },
    async buildEvidenceBundle(outPath: string): Promise<string> {
      return createBundle(ledgerPath, publicKeyPath, outPath, kp, policiesDir);
    },
  };
  return stack;
}

function loadOrCreate(dir: string): KeyPair {
  const priv = join(dir, "ledger.key");
  const pub = join(dir, "ledger.pub");
  if (existsSync(priv) && existsSync(pub)) {
    try {
      return loadKeypair(dir);
    } catch {
      // fall through to regenerate
    }
  }
  const kp = generateKeypair();
  kp.save(dir);
  return kp;
}
