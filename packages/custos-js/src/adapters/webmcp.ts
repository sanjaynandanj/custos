/**
 * WebMCP adapter.
 *
 * Registers Custos-gated tools with a browser's WebMCP surface
 * (`document.modelContext`). The Custos core (Gate/Ledger) is Node-only —
 * this adapter deliberately imports NOTHING from Node built-ins so it can be
 * bundled into a browser. It talks to Custos through a caller-supplied
 * `CustosDecider` callback (typically an HTTP call to a backend where Custos
 * runs).
 *
 * The adapter is intentionally thin. It knows how to:
 *   - forward WebMCP tool metadata verbatim,
 *   - normalise Custos outcomes to the MCP-shaped `isError` result the agent
 *     understands,
 *   - propagate AbortSignal cancellation,
 *   - clean up registrations.
 *
 * It does NOT know about policies, approvals, or ledgers.
 *
 * The WebMCP standard is still emerging. This adapter targets the current
 * `document.modelContext.registerTool` shape described at
 * https://webmachinelearning.github.io/webmcp/ and
 * https://developer.chrome.com/docs/ai/webmcp. Callers can pass any
 * `ModelContext` implementation; unit tests inject a fake, so the adapter is
 * validated without a browser.
 */

export interface ModelContextToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface ModelContextTool<TInput = unknown, TOutput = unknown> {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ModelContextToolAnnotations;
  execute: (
    input: TInput,
    ctx?: { signal?: AbortSignal },
  ) => Promise<TOutput> | TOutput;
}

/**
 * Minimum surface we require from `document.modelContext`. Real browser
 * implementations may return `void`, an object with `unregister()`, or a
 * `Promise` — we cope with all three.
 */
export interface ModelContext {
  registerTool(
    tool: ModelContextTool,
  ):
    | void
    | { unregister?: () => void }
    | Promise<void | { unregister?: () => void }>;
}

export type CustosOutcome =
  | { decision: "allow"; result: unknown; traceId?: string }
  | { decision: "deny"; rule: string; reason: string; traceId?: string }
  | {
      decision: "approval";
      approvalId: string;
      reason: string;
      traceId?: string;
      /** Resolves once the human approves/denies (or times out). */
      wait: (signal?: AbortSignal) => Promise<CustosOutcome>;
    };

export type CustosDecider = (
  input: unknown,
  ctx: { signal?: AbortSignal },
) => Promise<CustosOutcome>;

export interface CustosWebToolSpec
  extends Omit<ModelContextTool, "execute"> {
  /** Called for every WebMCP invocation. Return a CustosOutcome. */
  decide: CustosDecider;
}

export interface CustosRegistration {
  unregister(): void;
}

const MCP_TEXT_CONTENT_TYPE = "text";

interface McpErrorResult {
  isError: true;
  content: { type: "text"; text: string }[];
  _custos: {
    rule: string;
    reason: string;
    traceId?: string;
    approvalId?: string;
  };
}

function deniedResult(
  rule: string,
  reason: string,
  traceId?: string,
  approvalId?: string,
): McpErrorResult {
  const suffix = traceId ? ` (trace ${traceId})` : "";
  return {
    isError: true,
    content: [
      {
        type: MCP_TEXT_CONTENT_TYPE,
        text: `custos denied [${rule}]: ${reason}${suffix}`,
      },
    ],
    _custos: { rule, reason, traceId, approvalId },
  };
}

function errorResult(rule: string, err: unknown): McpErrorResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      { type: MCP_TEXT_CONTENT_TYPE, text: `custos ${rule}: ${msg}` },
    ],
    _custos: { rule, reason: msg },
  };
}

async function runOutcome(
  outcome: CustosOutcome,
  signal?: AbortSignal,
): Promise<unknown> {
  if (outcome.decision === "allow") return outcome.result;
  if (outcome.decision === "deny") {
    return deniedResult(outcome.rule, outcome.reason, outcome.traceId);
  }
  // approval — wait for human, then recurse on the resulting outcome.
  if (signal?.aborted) {
    return deniedResult(
      "custos.cancelled",
      "call cancelled before approval",
      outcome.traceId,
      outcome.approvalId,
    );
  }
  const next = await outcome.wait(signal);
  return runOutcome(next, signal);
}

/**
 * Feature-detect WebMCP. Safe to call from Node (returns null).
 */
export function getModelContext(doc?: unknown): ModelContext | null {
  const g = globalThis as unknown as { document?: unknown };
  const d: any = doc ?? g.document;
  if (!d) return null;
  const mc = d.modelContext;
  if (mc && typeof mc.registerTool === "function") return mc as ModelContext;
  return null;
}

/**
 * Register a single Custos-gated WebMCP tool.
 */
export function registerCustosWebTool(
  mc: ModelContext,
  spec: CustosWebToolSpec,
): CustosRegistration {
  if (!spec || typeof spec.name !== "string" || spec.name.length === 0) {
    throw new Error("registerCustosWebTool: spec.name is required");
  }
  if (typeof spec.decide !== "function") {
    throw new Error("registerCustosWebTool: spec.decide is required");
  }
  const decide = spec.decide;

  const mcpTool: ModelContextTool = {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: spec.annotations,
    execute: async (input, ctx) => {
      const signal = ctx?.signal;
      try {
        const outcome = await decide(input, { signal });
        return await runOutcome(outcome, signal);
      } catch (err) {
        // AbortError surfaces from fetch; treat as cancelled.
        if (
          err &&
          typeof err === "object" &&
          "name" in err &&
          (err as { name: string }).name === "AbortError"
        ) {
          return deniedResult(
            "custos.cancelled",
            "call cancelled",
            undefined,
          );
        }
        return errorResult("error", err);
      }
    },
  };

  // Browsers may return void, {unregister}, or a Promise — normalise all.
  const raw = mc.registerTool(mcpTool);
  let disposer: (() => void) | undefined;
  const captured = raw as unknown;
  if (
    captured &&
    typeof captured === "object" &&
    typeof (captured as { unregister?: unknown }).unregister === "function"
  ) {
    disposer = (captured as { unregister: () => void }).unregister.bind(
      captured,
    );
  } else if (captured && typeof (captured as Promise<unknown>).then === "function") {
    // Fire-and-forget: resolve later, capture disposer if present.
    (captured as Promise<{ unregister?: () => void } | void>)
      .then((resolved) => {
        if (
          resolved &&
          typeof resolved === "object" &&
          typeof resolved.unregister === "function"
        ) {
          disposer = resolved.unregister.bind(resolved);
        }
      })
      .catch(() => {
        /* the caller's registerTool rejected — nothing to clean up */
      });
  }

  return {
    unregister(): void {
      try {
        disposer?.();
      } catch {
        /* ignore — best-effort cleanup */
      }
    },
  };
}

/**
 * Register a batch of Custos-gated tools. Returns a single disposer.
 */
export function registerCustosWebTools(
  mc: ModelContext,
  specs: CustosWebToolSpec[],
): { unregisterAll(): void } {
  const regs = specs.map((s) => registerCustosWebTool(mc, s));
  return {
    unregisterAll(): void {
      for (const r of regs) r.unregister();
    },
  };
}

/**
 * Helpers for callers that want to talk to a Custos backend over HTTP.
 * Kept intentionally minimal — most apps will wrap their own client.
 */
export interface HttpDeciderOptions {
  /** Backend URL that receives `{ name, input, traceId? }` and returns a
   *  JSON-serialised CustosOutcome (with `wait` reconstituted client-side). */
  invokeUrl: string;
  /** Poll URL used by the default `wait` implementation:
   *  `${pollUrlBase}/${approvalId}` → returns a final CustosOutcome. */
  pollUrlBase: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
}

export function makeHttpDecider(
  toolName: string,
  opts: HttpDeciderOptions,
): CustosDecider {
  const doFetch = opts.fetchImpl ?? fetch;
  const pollInterval = opts.pollIntervalMs ?? 750;

  return async function decide(input, ctx) {
    const res = await doFetch(opts.invokeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: toolName, input }),
      signal: ctx.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        decision: "deny",
        rule: "custos.backend_error",
        reason: `backend ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    const outcome = (await res.json()) as CustosOutcome;
    if (outcome.decision !== "approval") return outcome;
    // Attach a wait() that polls the backend for the final resolution.
    const approvalId = outcome.approvalId;
    return {
      ...outcome,
      wait: async (signal?: AbortSignal) => {
        while (true) {
          if (signal?.aborted) {
            return {
              decision: "deny",
              rule: "custos.cancelled",
              reason: "call cancelled",
              traceId: outcome.traceId,
            };
          }
          const pollRes = await doFetch(
            `${opts.pollUrlBase}/${encodeURIComponent(approvalId)}`,
            { signal },
          );
          if (pollRes.status === 202) {
            await sleep(pollInterval, signal);
            continue;
          }
          if (!pollRes.ok) {
            const text = await pollRes.text();
            return {
              decision: "deny",
              rule: "custos.backend_error",
              reason: `poll ${pollRes.status}: ${text.slice(0, 200)}`,
              traceId: outcome.traceId,
            };
          }
          return (await pollRes.json()) as CustosOutcome;
        }
      },
    };
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new DOMExceptionShim("aborted", "AbortError"));
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Shim so this file has no runtime dependency on DOMException in Node. */
class DOMExceptionShim extends Error {
  constructor(msg: string, name = "Error") {
    super(msg);
    this.name = name;
  }
}
