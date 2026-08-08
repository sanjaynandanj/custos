"""Optional OpenTelemetry instrumentation.

If `opentelemetry-api` is installed, `wrap_gate(gate)` returns a gate that
emits a span per call with attributes for tool, decision, rule, latency.
"""
from __future__ import annotations

from typing import Any


def wrap_gate(gate: "Gate"):  # noqa: F821
    try:
        from opentelemetry import trace
    except ImportError:
        return gate

    tracer = trace.get_tracer("custos")
    original_call = gate.call

    def call(tool, args, fn, trace_id=None):
        with tracer.start_as_current_span(f"custos.tool.{tool}") as span:
            r = original_call(tool, args, fn, trace_id=trace_id)
            span.set_attribute("custos.tool", tool)
            span.set_attribute("custos.decision", r.decision.value)
            span.set_attribute("custos.rule", r.rule or "")
            span.set_attribute("custos.latency_ms", r.record.latency_ms)
            span.set_attribute("custos.trace_id", r.record.trace_id)
            return r

    gate.call = call  # type: ignore
    return gate
