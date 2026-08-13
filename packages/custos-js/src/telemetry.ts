// Opt-in anonymous telemetry.
//
// What is sent: { id, event, version, os, node } — nothing else.
// Never sent: file paths, policy contents, tool names, ledger data, hostnames.
//
// Off by default. Users must consent via `custos init` prompt, or by editing
// ~/.custos/telemetry.json. Env var CUSTOS_TELEMETRY=off overrides consent.
// No network requests unless CUSTOS_TELEMETRY_URL is set to a non-empty value.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const CONFIG_DIR = join(homedir(), ".custos");
const CONFIG_PATH = join(CONFIG_DIR, "telemetry.json");
const DEFAULT_URL = process.env.CUSTOS_TELEMETRY_URL ?? "";

export interface TelemetryConfig {
  enabled: boolean;
  id: string;
  consentedAt: string;
  version: 1;
}

export function readConfig(): TelemetryConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as TelemetryConfig;
  } catch {
    return null;
  }
}

export function writeConfig(cfg: TelemetryConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export async function promptConsent(opts: { assumeYes?: boolean; assumeNo?: boolean } = {}): Promise<TelemetryConfig> {
  const existing = readConfig();
  if (existing) return existing;

  let enabled = false;
  if (opts.assumeYes) enabled = true;
  else if (opts.assumeNo) enabled = false;
  else if (process.stdin.isTTY) enabled = await ask();

  const cfg: TelemetryConfig = {
    enabled,
    id: enabled ? randomUUID() : "",
    consentedAt: new Date().toISOString(),
    version: 1,
  };
  writeConfig(cfg);
  return cfg;
}

async function ask(): Promise<boolean> {
  process.stdout.write(
    "Send anonymous usage counts to help prioritize Custos work? " +
    "(only { install/command event, uuid, os, node version } — no paths, policies, or ledger data) [y/N] ",
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export interface EmitOptions {
  event: string;
  cliVersion: string;
}

export function emit(opts: EmitOptions): void {
  if (process.env.CUSTOS_TELEMETRY === "off") return;
  if (!DEFAULT_URL) return;
  const cfg = readConfig();
  if (!cfg || !cfg.enabled || !cfg.id) return;

  const payload = JSON.stringify({
    id: cfg.id,
    event: opts.event,
    version: opts.cliVersion,
    os: platform(),
    node: process.version,
  });

  // Fire-and-forget. Node < 18 lacks global fetch — bail silently there.
  const f = (globalThis as any).fetch as typeof fetch | undefined;
  if (!f) return;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 1000);
  f(DEFAULT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    signal: ac.signal,
  }).catch(() => {}).finally(() => clearTimeout(t));
}
