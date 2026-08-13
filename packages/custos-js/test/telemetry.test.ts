import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Force telemetry.ts to write its config into a throwaway HOME each test.
let fakeHome: string;
let origHome: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "custos-tel-home-"));
  origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  vi.resetModules();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("telemetry", () => {
  it("assumeNo writes disabled config with no id", async () => {
    const { promptConsent, readConfig } = await import("../src/telemetry.js");
    const cfg = await promptConsent({ assumeNo: true });
    expect(cfg.enabled).toBe(false);
    expect(cfg.id).toBe("");
    expect(readConfig()?.enabled).toBe(false);
  });

  it("assumeYes writes enabled config with uuid", async () => {
    const { promptConsent } = await import("../src/telemetry.js");
    const cfg = await promptConsent({ assumeYes: true });
    expect(cfg.enabled).toBe(true);
    expect(cfg.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("second call returns existing config", async () => {
    const { promptConsent } = await import("../src/telemetry.js");
    const a = await promptConsent({ assumeYes: true });
    const b = await promptConsent({ assumeNo: true });
    expect(b.id).toBe(a.id);
    expect(b.enabled).toBe(true);
  });

  it("emit is a no-op when URL unset", async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    delete process.env.CUSTOS_TELEMETRY_URL;
    const { promptConsent, emit } = await import("../src/telemetry.js");
    await promptConsent({ assumeYes: true });
    emit({ event: "test", cliVersion: "0.0.0" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("emit is a no-op when disabled", async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    process.env.CUSTOS_TELEMETRY_URL = "https://example.invalid/e";
    const { promptConsent, emit } = await import("../src/telemetry.js");
    await promptConsent({ assumeNo: true });
    emit({ event: "test", cliVersion: "0.0.0" });
    expect(fetchSpy).not.toHaveBeenCalled();
    delete process.env.CUSTOS_TELEMETRY_URL;
  });

  it("emit is a no-op when CUSTOS_TELEMETRY=off overrides consent", async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    process.env.CUSTOS_TELEMETRY_URL = "https://example.invalid/e";
    process.env.CUSTOS_TELEMETRY = "off";
    const { promptConsent, emit } = await import("../src/telemetry.js");
    await promptConsent({ assumeYes: true });
    emit({ event: "test", cliVersion: "0.0.0" });
    expect(fetchSpy).not.toHaveBeenCalled();
    delete process.env.CUSTOS_TELEMETRY_URL;
    delete process.env.CUSTOS_TELEMETRY;
  });
});
