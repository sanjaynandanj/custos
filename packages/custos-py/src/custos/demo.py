"""`custos demo` — self-contained end-to-end run against an in-process mock MCP."""
from __future__ import annotations

import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from custos.keys import generate_keypair
from custos.ledger import Ledger
from custos.policy import load_policy
from custos.record import Actor, Server
from custos.sdk import Gate, GateResult
from custos.verify import verify_ledger


DEMO_POLICY = {
    "version": 1,
    "id": "demo",
    "default": "deny",
    "rules": [
        {"id": "no-traversal", "when": {"args.path": {"contains": ".."}}, "decision": "deny", "reason": "path traversal blocked"},
        {"id": "allow-workspace-read", "when": {"tool": "read_file", "args.path": {"prefix": "/workspace/"}}, "decision": "allow", "reason": "workspace-only reads"},
        {"id": "deny-shell", "when": {"tool": {"regex": r"^shell\."}}, "decision": "deny", "reason": "shell tools disabled"},
    ],
}

CALLS = [
    ("read_file", {"path": "/workspace/README.md"}, "read a workspace file", "allow"),
    ("read_file", {"path": "/workspace/../etc/passwd"}, "path traversal", "deny"),
    ("shell.exec", {"cmd": "rm -rf /"}, "shell command", "deny"),
]


@dataclass
class DemoResult:
    dir: Path
    results: list[GateResult]
    verified: bool
    records: int


def run_demo(dir_path: str | Path | None = None, keep: bool = False, quiet: bool = False) -> DemoResult:
    d = Path(dir_path) if dir_path else Path(tempfile.mkdtemp(prefix="custos-demo-"))
    log = (lambda _s: None) if quiet else print

    kp = generate_keypair()
    kp.save(d)
    ledger_path = d / "ledger.jsonl"
    ledger = Ledger(ledger_path, kp)
    policy = load_policy(DEMO_POLICY)
    gate = Gate(policy, ledger, Actor("demo-agent"), Server("mock-mcp", pubkey=kp.public_b64()))

    log(f"custos demo -- ledger dir: {d}\n")

    results: list[GateResult] = []
    for tool, args, label, expected in CALLS:
        r = gate.call(tool, args, fn=lambda **_: {"ok": True})
        results.append(r)
        mark = "OK " if r.decision.value == expected else "!! "
        log(f"  {mark}{label:<24} tool={tool:<12} -> {r.decision.value:<5} rule={r.rule or 'default'}  reason={r.reason}")

    v = verify_ledger(str(ledger_path), str(d / "ledger.pub"))
    log(f"\n  ledger: {v.records} record(s), signature chain {'verified' if v.ok else 'FAILED'}")
    if not quiet and not keep:
        tail = ledger_path.read_text(encoding="utf-8").strip().splitlines()[-1]
        log(f"  last record: {tail}")

    if not keep:
        shutil.rmtree(d, ignore_errors=True)
        log(f"\n  cleaned up {d} (pass --keep to inspect)")
    else:
        log(f"\n  kept {d} -- inspect with: custos verify --ledger {ledger_path}")

    return DemoResult(dir=d, results=results, verified=v.ok, records=v.records)
