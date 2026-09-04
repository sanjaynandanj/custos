"""Offline ledger verification."""
from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from custos.canonical import dumps as canonical_dumps
from custos.keys import public_key_from_b64
from custos.record import GENESIS_PREV_HASH


@dataclass
class VerifyResult:
    ok: bool
    records: int
    errors: List[str] = field(default_factory=list)


def verify_ledger(ledger_path: str | Path, pubkey_path: Optional[str | Path] = None) -> VerifyResult:
    ledger_path = Path(ledger_path)
    if pubkey_path is None:
        pubkey_path = ledger_path.parent / (ledger_path.stem + ".pub")
    pubkey_b64 = Path(pubkey_path).read_bytes().decode("ascii").strip()
    pub = public_key_from_b64(pubkey_b64)

    errors: List[str] = []
    expected_seq = 0
    expected_prev = GENESIS_PREV_HASH
    count = 0

    if not ledger_path.exists():
        return VerifyResult(ok=False, records=0, errors=["ledger file not found"])

    with ledger_path.open("rb") as f:
        for line_no, raw in enumerate(f, start=1):
            if not raw.strip():
                continue
            try:
                rec = json.loads(raw)
            except Exception as e:
                errors.append(f"line {line_no}: invalid JSON: {e}")
                return VerifyResult(ok=False, records=count, errors=errors)
            # Both DecisionRecord and AttestationRecord (v0.4.0+) share
            # the same chain-and-signature discipline, so the verifier
            # doesn't need to switch on ``type`` — hash the body as-is
            # and check the sig. The type discriminator only matters for
            # semantic replay (see replay_ledger + verify_coverage).
            # sequence check
            if rec.get("seq") != expected_seq:
                errors.append(f"line {line_no}: seq mismatch (got {rec.get('seq')}, expected {expected_seq})")
                return VerifyResult(ok=False, records=count, errors=errors)
            # prev_hash check
            if rec.get("prev_hash") != expected_prev:
                errors.append(
                    f"line {line_no}: prev_hash mismatch (got {rec.get('prev_hash')}, expected {expected_prev})"
                )
                return VerifyResult(ok=False, records=count, errors=errors)
            # recompute record_hash
            body = {k: v for k, v in rec.items() if k not in ("record_hash", "sig")}
            body_bytes = canonical_dumps(body)
            computed = "sha256:" + hashlib.sha256(body_bytes).hexdigest()
            if computed != rec.get("record_hash"):
                errors.append(
                    f"line {line_no}: record_hash mismatch (computed {computed}, stored {rec.get('record_hash')})"
                )
                return VerifyResult(ok=False, records=count, errors=errors)
            # verify signature
            sig_val = rec.get("sig", "")
            if not sig_val.startswith("ed25519:"):
                errors.append(f"line {line_no}: sig format invalid")
                return VerifyResult(ok=False, records=count, errors=errors)
            try:
                sig_bytes = base64.b64decode(sig_val.split(":", 1)[1])
                digest = bytes.fromhex(computed.split(":", 1)[1])
                pub.verify(sig_bytes, digest)
            except InvalidSignature:
                errors.append(f"line {line_no}: invalid signature")
                return VerifyResult(ok=False, records=count, errors=errors)
            except Exception as e:
                errors.append(f"line {line_no}: sig verify error: {e}")
                return VerifyResult(ok=False, records=count, errors=errors)
            expected_seq += 1
            expected_prev = computed
            count += 1

    return VerifyResult(ok=True, records=count, errors=[])


@dataclass
class ReplayResult:
    """Result of point-in-time policy replay (see WIRE.md §5.1 / §6.1).

    A replay walks each record, resolves the policy at ``record.policy.hash``
    from a content-addressed snapshot directory, and asserts that the
    recorded rule (or default) is consistent with the loaded policy's
    text — i.e. the policy at that hash actually defines the rule the
    record claims fired, and with the same decision.

    Not verified: whether the recorded arguments actually satisfy the
    rule's ``when`` clauses. Records store ``args_hash`` (not ``args``)
    to keep tool inputs out of the audit surface, so argument-level
    replay requires an out-of-band args log. This is intentional; see
    the "What Custos proves" doc.
    """
    ok: bool
    records: int
    replayed: int
    skipped_no_hash: int
    missing_policies: List[str] = field(default_factory=list)
    mismatches: List[str] = field(default_factory=list)


def replay_ledger(
    ledger_path: str | Path,
    policies_dir: Optional[str | Path] = None,
) -> ReplayResult:
    ledger_path = Path(ledger_path)
    if policies_dir is None:
        policies_dir = ledger_path.parent / "policies"
    policies_dir = Path(policies_dir)

    records = 0
    replayed = 0
    skipped_no_hash = 0
    missing: List[str] = []
    mismatches: List[str] = []
    # Cache loaded Policy objects by hash so we don't re-parse the same
    # snapshot file for every record. Real ledgers frequently pin a
    # single policy for hundreds of thousands of decisions in a row.
    from custos.policy import load_policy as _load_policy
    cache: dict[str, "Policy"] = {}  # noqa: F821

    if not ledger_path.exists():
        return ReplayResult(
            ok=False, records=0, replayed=0, skipped_no_hash=0,
            missing_policies=["ledger file not found"],
        )

    with ledger_path.open("rb") as f:
        for line_no, raw in enumerate(f, start=1):
            if not raw.strip():
                continue
            rec = json.loads(raw)
            records += 1
            # Attestation records don't carry a decision to replay; the
            # verifier's own coverage check consumes them separately.
            if rec.get("type") == "attestation":
                continue
            policy_hash: str = (rec.get("policy") or {}).get("hash", "")
            if not policy_hash:
                skipped_no_hash += 1
                continue
            if policy_hash not in cache:
                hex_part = policy_hash.split(":", 1)[1] if ":" in policy_hash else policy_hash
                # Validate hex_part is a plain 64-char lowercase hex string
                # BEFORE using it in a glob pattern. Without this, a
                # malicious ledger with policy.hash = "sha256:../../etc/foo"
                # would traverse outside policies_dir; the matched file
                # then gets loaded via yaml.safe_load. Sig verification
                # doesn't catch this — the sig covers the bytes of the
                # value, not its semantic shape, so an attacker with the
                # signing key (or a downstream caller that skips
                # verify_ledger) can weaponise the field for filesystem
                # probing. Node is safe by construction (readdirSync +
                # startsWith); Python's pathlib.glob is not.
                import re as _re
                if not _re.fullmatch(r"[0-9a-f]{64}", hex_part):
                    mismatches.append(
                        f"seq {rec.get('seq')}: policy hash {policy_hash!r} is not "
                        "a valid sha256:<64-hex> value; refusing to look up"
                    )
                    continue
                # Glob for any extension — Python and Node writers may
                # produce yaml/yml/json depending on the source. Content
                # addressing means the extension is decoration.
                candidates = sorted(policies_dir.glob(f"{hex_part}.*"))
                if not candidates:
                    missing.append(
                        f"seq {rec.get('seq')}: no snapshot for policy {policy_hash} in {policies_dir}"
                    )
                    continue
                try:
                    loaded = _load_policy(candidates[0])
                except Exception as e:
                    mismatches.append(
                        f"seq {rec.get('seq')}: failed to load policy {policy_hash}: {e}"
                    )
                    continue
                if loaded.hash != policy_hash:
                    # Should be impossible if the file is truly at <hash>.<ext>,
                    # but defend against a subtle CRLF/encoding regression.
                    mismatches.append(
                        f"seq {rec.get('seq')}: loaded policy hash {loaded.hash} "
                        f"does not match snapshot filename {policy_hash}"
                    )
                    continue
                cache[policy_hash] = loaded
            pol = cache[policy_hash]
            replayed += 1

            # An "error" decision means the tool executed and raised — that
            # is not a policy decision at all, so we do not attempt to
            # replay it against the rules.
            if rec.get("decision") == "error":
                continue

            rule_id = (rec.get("policy") or {}).get("rule", "")
            recorded_decision = rec.get("decision")
            if not rule_id:
                # Default path — decision must equal policy default.
                expected = pol.default.value if hasattr(pol.default, "value") else str(pol.default)
                if recorded_decision != expected:
                    mismatches.append(
                        f"seq {rec.get('seq')}: no rule fired but recorded "
                        f"decision {recorded_decision!r} != policy default {expected!r}"
                    )
                continue
            match = next((r for r in pol.rules if r.id == rule_id), None)
            if match is None:
                mismatches.append(
                    f"seq {rec.get('seq')}: policy {policy_hash} has no rule {rule_id!r}"
                )
                continue
            rule_decision = match.decision.value if hasattr(match.decision, "value") else str(match.decision)
            if rule_decision != recorded_decision:
                mismatches.append(
                    f"seq {rec.get('seq')}: rule {rule_id!r} decides {rule_decision!r} "
                    f"but record says {recorded_decision!r}"
                )

    ok = not missing and not mismatches
    return ReplayResult(
        ok=ok, records=records, replayed=replayed,
        skipped_no_hash=skipped_no_hash,
        missing_policies=missing, mismatches=mismatches,
    )


@dataclass
class CoverageGap:
    """A single observed interval where no attestation was emitted."""
    from_ts: str
    to_ts: str
    duration_s: float


@dataclass
class CoverageResult:
    """Result of a liveness-coverage check over the ledger's attestations.

    ``ok`` is True when every observed gap is within tolerance of the
    expected interval. Startups counted separately: a spike in startup
    attestations without matching shutdowns is evidence of unclean
    exits (crashes) and gets surfaced even when total coverage looks OK.

    See spec/WIRE.md §2.3.
    """
    ok: bool
    records: int
    attestations: int
    first_ts: str = ""
    last_ts: str = ""
    window_s: float = 0.0
    by_reason: Dict[str, int] = field(default_factory=dict)
    gaps: List[CoverageGap] = field(default_factory=list)
    max_gap_s: float = 0.0
    total_gap_s: float = 0.0
    interval_s: float = 60.0
    tolerance: float = 2.0


def _parse_iso(ts: str) -> float:
    """Parse RFC3339 millisecond timestamp to epoch seconds."""
    import datetime as _dt
    # Python 3.11+ handles "Z" via datetime.fromisoformat; older versions
    # need explicit substitution. Both are fine after 3.11.
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    return _dt.datetime.fromisoformat(ts).timestamp()


def verify_coverage(
    ledger_path: str | Path,
    interval_s: float = 60.0,
    tolerance: float = 2.0,
) -> CoverageResult:
    """Analyze attestation cadence to bracket periods of observable
    operation and flag gaps that exceed ``interval_s * tolerance``.

    A ``CoverageResult`` with ``ok=True`` means: every consecutive pair
    of attestations was within the tolerance window, so the ledger
    proves the control was observably running across the whole span.
    A ``CoverageResult`` with ``ok=False`` names the gaps — auditors can
    then check external logs / monitoring for what happened in those
    intervals.
    """
    ledger_path = Path(ledger_path)
    result = CoverageResult(
        ok=True, records=0, attestations=0,
        interval_s=interval_s, tolerance=tolerance,
    )
    if not ledger_path.exists():
        result.ok = False
        return result

    stamps: List[Tuple[str, str]] = []  # (ts, reason)
    with ledger_path.open("rb") as f:
        for raw in f:
            if not raw.strip():
                continue
            rec = json.loads(raw)
            result.records += 1
            if rec.get("type") != "attestation":
                continue
            result.attestations += 1
            reason = (rec.get("attestation") or {}).get("reason", "unknown")
            result.by_reason[reason] = result.by_reason.get(reason, 0) + 1
            stamps.append((rec["ts"], reason))

    if not stamps:
        # No attestations at all — can't make a coverage claim either way.
        result.ok = False
        return result

    # A malformed ``ts`` in any record would raise ValueError up the stack
    # and crash the verifier. Signature verification doesn't catch it: the
    # sig is over the body bytes, not their semantic shape, so an attacker
    # with the signing key (or a buggy writer) could poison the timestamp
    # field and break every downstream coverage report. Treat parse
    # failures as a coverage-integrity error instead of a crash.
    def _safe_parse(ts: str) -> Optional[float]:
        try:
            return _parse_iso(ts)
        except (ValueError, TypeError):
            return None

    first_s = _safe_parse(stamps[0][0])
    last_s = _safe_parse(stamps[-1][0])
    if first_s is None or last_s is None:
        result.ok = False
        result.first_ts = stamps[0][0]
        result.last_ts = stamps[-1][0]
        # Surface as a synthetic gap so operators see it in the same list
        # they scan for real gaps — one place to look for anything wrong.
        result.gaps.append(CoverageGap(
            from_ts=stamps[0][0], to_ts=stamps[-1][0], duration_s=-1.0,
        ))
        return result

    result.first_ts = stamps[0][0]
    result.last_ts = stamps[-1][0]
    result.window_s = max(0.0, last_s - first_s)

    threshold = interval_s * tolerance
    prev_ts_s = first_s
    prev_ts_str = stamps[0][0]
    for ts_str, _reason in stamps[1:]:
        cur_s = _safe_parse(ts_str)
        if cur_s is None:
            # Same rationale as above — record the bad boundary and stop
            # this record's gap accounting; keep walking to catch further
            # malformed entries.
            result.ok = False
            result.gaps.append(CoverageGap(
                from_ts=prev_ts_str, to_ts=ts_str, duration_s=-1.0,
            ))
            continue
        delta = cur_s - prev_ts_s
        if delta > threshold:
            gap = CoverageGap(from_ts=prev_ts_str, to_ts=ts_str, duration_s=delta)
            result.gaps.append(gap)
            result.total_gap_s += delta
            if delta > result.max_gap_s:
                result.max_gap_s = delta
        prev_ts_s = cur_s
        prev_ts_str = ts_str

    result.ok = result.ok and len(result.gaps) == 0
    return result
