/**
 * Optional OpenTelemetry instrumentation.
 *
 * If `@opentelemetry/api` is installed, `wrapGate(gate)` returns a gate whose
 * `.call` emits a span per invocation with attributes for tool, decision,
 * rule, latency, and trace id. If the package is missing, the gate is
 * returned unmodified.
 */
import type { Gate, GateResult } from "./sdk.js";

export async function wrapGate(gate: Gate): Promise<Gate> {
  let trace: any;
  try {
    ({ trace } = await import("@opentelemetry/api" as string));
  } catch {
    return gate;
  }
  const tracer = trace.getTracer("custos");
  const originalCall = gate.call.bind(gate);

  gate.call = async function <T>(
    tool: string,
    args: Record<string, unknown>,
    fn: (args: any) => T | Promise<T>,
    traceId?: string,
  ): Promise<GateResult<T>> {
    return await tracer.startActiveSpan(`custos.tool.${tool}`, async (span: any) => {
      try {
        const r = await originalCall(tool, args, fn, traceId);
        span.setAttribute("custos.tool", tool);
        span.setAttribute("custos.decision", r.decision);
        span.setAttribute("custos.rule", r.rule ?? "");
        span.setAttribute("custos.latency_ms", r.record.latency_ms);
        span.setAttribute("custos.trace_id", r.record.trace_id);
        return r;
      } finally {
        span.end();
      }
    });
  } as Gate["call"];

  return gate;
}
