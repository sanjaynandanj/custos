"""Native Custos policy DSL evaluator (see spec/WIRE.md §6)."""
from __future__ import annotations

import fnmatch
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import yaml

from custos.canonical import dumps as canonical_dumps
from custos.record import Decision


_MISSING = object()


def _lookup(ctx: dict, dotted: str) -> Any:
    cur: Any = ctx
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return _MISSING
    return cur


def _match_scalar(value: Any, expected: Any) -> bool:
    if isinstance(expected, str) and isinstance(value, str) and ("*" in expected or "?" in expected):
        return fnmatch.fnmatchcase(value, expected)
    return value == expected


def _match_op(value: Any, op_spec: dict, present: bool = True) -> bool:
    for op, arg in op_spec.items():
        if op == "exists":
            if bool(arg) != present:
                return False
            continue
        if not present:
            # non-exists operators cannot match a missing value
            return False
        if op == "prefix":
            if not (isinstance(value, str) and value.startswith(arg)):
                return False
        elif op == "suffix":
            if not (isinstance(value, str) and value.endswith(arg)):
                return False
        elif op == "contains":
            if not (isinstance(value, str) and arg in value):
                return False
        elif op == "regex":
            # ``arg`` may be a pre-compiled ``re.Pattern`` (see load_policy),
            # or a raw string for callers that construct rules programmatically.
            # Pre-compiling at load time both speeds up evaluation and surfaces
            # malformed patterns early. NOTE: Python's ``re`` engine is
            # backtracking and can be catastrophically slow on adversarial
            # patterns (ReDoS). For untrusted-policy deployments, prefer a
            # linear-time engine such as ``google-re2``.
            if isinstance(arg, re.Pattern):
                if not (isinstance(value, str) and arg.search(value) is not None):
                    return False
            else:
                if not (isinstance(value, str) and re.search(arg, value) is not None):
                    return False
        elif op == "in":
            if value not in arg:
                return False
        elif op == "not_in":
            if value in arg:
                return False
        elif op == "eq":
            if value != arg:
                return False
        elif op == "ne":
            if value == arg:
                return False
        elif op == "gt":
            if not (isinstance(value, (int, float)) and value > arg):
                return False
        elif op == "lt":
            if not (isinstance(value, (int, float)) and value < arg):
                return False
        elif op == "gte":
            if not (isinstance(value, (int, float)) and value >= arg):
                return False
        elif op == "lte":
            if not (isinstance(value, (int, float)) and value <= arg):
                return False
        else:
            raise ValueError(f"unknown match operator: {op}")
    return True


@dataclass
class Rule:
    id: str
    when: Dict[str, Any]
    decision: Decision
    reason: str = ""

    def matches(self, ctx: dict) -> bool:
        for path, expected in self.when.items():
            value = _lookup(ctx, path)
            if isinstance(expected, dict):
                present = value is not _MISSING
                real = None if not present else value
                if not _match_op(real, expected, present=present):
                    return False
            else:
                if value is _MISSING:
                    return False
                if not _match_scalar(value, expected):
                    return False
        return True


@dataclass
class PolicyDecision:
    decision: Decision
    rule_id: str
    reason: str


@dataclass
class Policy:
    version: int
    id: str
    default: Decision
    rules: List[Rule] = field(default_factory=list)
    engine: str = "native"
    # sha256:<hex> of the policy source (raw file bytes when loaded from a
    # path; canonical JSON of the input dict for programmatic construction).
    # Recorded on every DecisionRecord so an auditor can, at any point in
    # the future, reconstruct which exact policy text produced a given
    # decision. See spec/WIRE.md §6.1.
    hash: str = ""
    # Raw source bytes when known — used by callers that need to snapshot
    # the policy alongside the ledger (see custos.bundle content-addressed
    # snapshots). Not part of the wire format.
    source_bytes: bytes = b""
    source_ext: str = ""

    def snapshot_to(self, directory: Union[str, Path]) -> Optional[Path]:
        """Write this policy's raw source to ``<directory>/<hex>.<ext>``.

        The filename is derived from ``self.hash`` (the ``sha256:`` prefix is
        stripped) so the on-disk name is content-addressed: multiple policies
        with different content co-exist under the same directory, and a
        verifier looking for the policy at ``record.policy.hash`` can find it
        by strip-and-glob.

        Idempotent: if the target file already exists it is NOT rewritten
        (the hash guarantees the bytes match). Returns the target path, or
        ``None`` if this policy has no source bytes to snapshot (e.g.
        third-party adapter that never populated it).
        """
        if not self.source_bytes or not self.hash:
            return None
        d = Path(directory)
        d.mkdir(parents=True, exist_ok=True)
        hex_hash = self.hash.split(":", 1)[1] if ":" in self.hash else self.hash
        target = d / f"{hex_hash}.{self.source_ext or 'bin'}"
        if not target.exists():
            target.write_bytes(self.source_bytes)
        return target

    def evaluate(self, ctx: dict) -> PolicyDecision:
        for rule in self.rules:
            if rule.matches(ctx):
                return PolicyDecision(decision=rule.decision, rule_id=rule.id, reason=rule.reason)
        return PolicyDecision(
            decision=self.default,
            rule_id="",
            reason=f"default:{self.default.value}",
        )


def _parse_decision(s: str) -> Decision:
    try:
        return Decision(s)
    except ValueError as e:
        raise ValueError(f"invalid decision: {s!r}") from e


def _precompile_when(rule_id: str, when: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of ``when`` where every ``regex`` operator's argument is
    replaced with a pre-compiled :class:`re.Pattern`.

    This surfaces malformed patterns at load time (raising ``ValueError``)
    rather than at first evaluation, and eliminates re-compilation on every
    call. Note: Python's ``re`` module is a backtracking engine; adversarial
    patterns can still ReDoS. High-security deployments should use
    ``google-re2`` (linear-time) — this pre-compile step reduces the surface
    but does not eliminate the class.
    """
    out: Dict[str, Any] = {}
    for path, expected in when.items():
        if isinstance(expected, dict):
            new_spec: Dict[str, Any] = {}
            for op, arg in expected.items():
                if op == "regex" and isinstance(arg, str):
                    try:
                        new_spec[op] = re.compile(arg)
                    except re.error as e:
                        raise ValueError(
                            f"rule {rule_id!r}: invalid regex for path {path!r}: {e}"
                        ) from e
                else:
                    new_spec[op] = arg
            out[path] = new_spec
        else:
            out[path] = expected
    return out


def load_policy(path_or_data: Union[str, Path, dict]) -> Policy:
    # For file-backed policies we hash the raw file bytes — that is the
    # exact artifact the operator committed to source control, and it is
    # what an auditor will diff six months later. For dict inputs we hash
    # the canonical JSON of the parsed value: programmatic callers do not
    # have a "raw file," so we normalise via the same canonicaliser used
    # everywhere else on the wire. Byte-level: CRLF vs LF policies are
    # different policies. That is the point.
    if isinstance(path_or_data, (str, Path)):
        p = Path(path_or_data)
        raw_bytes = p.read_bytes()
        raw = raw_bytes.decode("utf-8")
        data = yaml.safe_load(raw)
        source_bytes = raw_bytes
        source_ext = p.suffix.lstrip(".") or "yaml"
    else:
        data = path_or_data
        source_bytes = canonical_dumps(data)
        source_ext = "json"
    if data.get("version", 1) != 1:
        raise ValueError(f"unsupported policy version: {data.get('version')}")
    rules = []
    for r in data.get("rules", []):
        rules.append(
            Rule(
                id=r["id"],
                when=_precompile_when(r["id"], r.get("when", {})),
                decision=_parse_decision(r["decision"]),
                reason=r.get("reason", ""),
            )
        )
    policy_hash = "sha256:" + hashlib.sha256(source_bytes).hexdigest()
    return Policy(
        version=data.get("version", 1),
        id=data.get("id", "default"),
        default=_parse_decision(data.get("default", "deny")),
        rules=rules,
        hash=policy_hash,
        source_bytes=source_bytes,
        source_ext=source_ext,
    )
