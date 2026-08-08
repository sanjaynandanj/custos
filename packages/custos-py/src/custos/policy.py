"""Native Custos policy DSL evaluator (see spec/WIRE.md §6)."""
from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import yaml

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


def load_policy(path_or_data: Union[str, Path, dict]) -> Policy:
    if isinstance(path_or_data, (str, Path)):
        p = Path(path_or_data)
        raw = p.read_text(encoding="utf-8")
        data = yaml.safe_load(raw)
    else:
        data = path_or_data
    if data.get("version", 1) != 1:
        raise ValueError(f"unsupported policy version: {data.get('version')}")
    rules = []
    for r in data.get("rules", []):
        rules.append(
            Rule(
                id=r["id"],
                when=r.get("when", {}),
                decision=_parse_decision(r["decision"]),
                reason=r.get("reason", ""),
            )
        )
    return Policy(
        version=data.get("version", 1),
        id=data.get("id", "default"),
        default=_parse_decision(data.get("default", "deny")),
        rules=rules,
    )
