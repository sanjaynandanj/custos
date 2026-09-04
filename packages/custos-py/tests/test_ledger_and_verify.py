from pathlib import Path

import pytest

from custos.keys import generate_keypair
from custos.ledger import Ledger
from custos.policy import load_policy
from custos.record import Actor, Server
from custos.sdk import Gate
from custos.verify import replay_ledger, verify_coverage, verify_ledger


@pytest.fixture()
def workdir(tmp_path):
    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy({
        "version": 1, "default": "deny",
        "rules": [
            {"id": "allow-read", "when": {"tool": "read"}, "decision": "allow"},
        ],
    })
    gate = Gate(policy=policy, ledger=ledger, actor=Actor("agent-1"), server=Server("srv"))
    return tmp_path, gate


def test_gate_allow_and_verify(workdir):
    tmp_path, gate = workdir
    r = gate.call("read", {"path": "/tmp/x"}, fn=lambda path: f"contents of {path}")
    assert r.allowed
    assert r.result == "contents of /tmp/x"

    r2 = gate.call("write", {"path": "/tmp/x"}, fn=lambda path: None)
    assert not r2.allowed

    for _ in range(5):
        gate.call("read", {"path": "/a"}, fn=lambda path: "ok")

    v = verify_ledger(tmp_path / "ledger.jsonl", tmp_path / "ledger.pub")
    assert v.ok, v.errors
    # 1 startup attestation (Gate init) + 1 allow + 1 deny + 5 allows.
    assert v.records == 8


def test_policy_hash_recorded_and_verifies(workdir):
    """Every record produced by the Gate must embed the policy.hash of the
    policy that was live at decision time, so audit reconstruction can
    trust the record itself rather than a sidecar "which version" log.
    The full signed chain must still verify with the new field present."""
    import json

    tmp_path, gate = workdir
    expected = gate.policy.hash
    assert expected.startswith("sha256:")

    gate.call("read", {"path": "/tmp/a"}, fn=lambda path: "ok")
    gate.call("write", {"path": "/tmp/b"}, fn=lambda path: None)  # denied

    lines = (tmp_path / "ledger.jsonl").read_text(encoding="utf-8").splitlines()
    decisions = [
        json.loads(l) for l in lines if json.loads(l).get("type") != "attestation"
    ]
    assert len(decisions) == 2
    for rec in decisions:
        assert rec["policy"]["hash"] == expected

    v = verify_ledger(tmp_path / "ledger.jsonl", tmp_path / "ledger.pub")
    assert v.ok, v.errors


def test_startup_attestation_is_emitted_and_verifies(tmp_path):
    """Constructing a Gate MUST append a signed startup attestation to
    the ledger so the record "this control was operational at time T"
    is available to auditors. Reviewer's ask #2: silence should not be
    ambiguous. The attestation is fully signed and participates in the
    hash chain."""
    import json

    from custos.keys import generate_keypair
    from custos.ledger import Ledger
    from custos.policy import load_policy
    from custos.record import Actor, Server
    from custos.sdk import Gate

    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy({"version": 1, "id": "t", "default": "allow", "rules": []})
    Gate(policy, ledger, Actor("agent-x"), Server("s"))

    lines = (tmp_path / "ledger.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1, "Gate init should have emitted exactly one attestation"
    rec = json.loads(lines[0])
    assert rec["type"] == "attestation"
    assert rec["attestation"]["reason"] == "startup"
    assert rec["attestation"]["policy_hash"] == policy.hash
    assert rec["attestation"]["active_actors"] == ["agent-x"]
    # Chain verification treats attestation records uniformly.
    v = verify_ledger(tmp_path / "ledger.jsonl", tmp_path / "ledger.pub")
    assert v.ok, v.errors


def test_gate_warns_when_startup_attestation_fails(tmp_path):
    """If a caller passes a third-party Ledger that doesn't implement
    append_attestation, the Gate MUST NOT construct silently — that
    reproduces the exact "you stopped observing" failure mode the
    reviewer flagged. Emit a RuntimeWarning naming the failing class."""
    import warnings

    from custos.keys import generate_keypair
    from custos.policy import load_policy
    from custos.record import Actor, Server
    from custos.sdk import Gate

    class BrokenLedger:
        """Duck-types just enough for Gate construction — has .path but
        no append_attestation. Mimics a third-party Ledger predating
        v0.4.0."""
        def __init__(self, path):
            from pathlib import Path
            self.path = Path(path)
            self.path.parent.mkdir(parents=True, exist_ok=True)

    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = BrokenLedger(tmp_path / "ledger.jsonl")
    policy = load_policy({"version": 1, "id": "t", "default": "allow", "rules": []})

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        Gate(policy, ledger, Actor("a"), Server("s"))
        matches = [w for w in caught if issubclass(w.category, RuntimeWarning)
                   and "startup attestation failed" in str(w.message)]
        assert matches, "Expected a RuntimeWarning about startup attestation failure"
        # The warning must name the specific Ledger class so an operator
        # can find the culprit — not just "attestation failed" generically.
        assert "BrokenLedger" in str(matches[0].message)


def test_attest_false_suppresses_startup_attestation(tmp_path):
    """`attest=False` must be a hard opt-out — the ledger stays empty
    until the first gate.call. This is the escape hatch for tests and
    write-heavy paths that manage attestation externally."""
    from custos.keys import generate_keypair
    from custos.ledger import Ledger
    from custos.policy import load_policy
    from custos.record import Actor, Server
    from custos.sdk import Gate

    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy({"version": 1, "id": "t", "default": "allow", "rules": []})
    Gate(policy, ledger, Actor("a"), Server("s"), attest=False)

    p = tmp_path / "ledger.jsonl"
    assert not p.exists() or p.stat().st_size == 0


def test_enforcement_label_on_sdk_records(workdir):
    """Every record produced by the in-process Gate should carry
    enforcement={point: 'sdk', effect: 'blocked'} by default. That's the
    honest label for what the SDK actually does: the wrapped fn never
    runs on deny. Reviewer's ask #3 — a `deny` should never be mistaken
    for outcome unless the record explicitly says so."""
    import json

    tmp_path, gate = workdir
    gate.call("read", {"i": 0}, fn=lambda i: i)
    gate.call("write", {"i": 0}, fn=lambda i: i)  # denied

    lines = (tmp_path / "ledger.jsonl").read_text(encoding="utf-8").splitlines()
    decisions = [
        json.loads(l) for l in lines if json.loads(l).get("type") != "attestation"
    ]
    assert len(decisions) == 2  # 1 allow + 1 deny
    for rec in decisions:
        assert rec["enforcement"] == {"point": "sdk", "effect": "blocked"}


def test_gate_rejects_invalid_enforcement_at_construction(tmp_path):
    """Enforcement.validate() must fire at author time so a typo in
    `point` or `effect` blows up on Gate construction — not silently
    lands in the ledger and lies to auditors. Wire-loaded records are
    deliberately NOT validated (forward-compat) — this only guards the
    author-facing surface."""
    from custos.keys import generate_keypair
    from custos.ledger import Ledger
    from custos.policy import load_policy
    from custos.record import Actor, Enforcement, Server
    from custos.sdk import Gate

    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy({"version": 1, "id": "t", "default": "allow", "rules": []})

    with pytest.raises(ValueError, match="point"):
        Gate(policy, ledger, Actor("a"), Server("s"),
             enforcement=Enforcement(point="sdkk", effect="blocked"),
             attest=False)
    with pytest.raises(ValueError, match="effect"):
        Gate(policy, ledger, Actor("a"), Server("s"),
             enforcement=Enforcement(point="sdk", effect="advisor"),
             attest=False)

    # Valid enforcement must construct cleanly.
    Gate(policy, ledger, Actor("a"), Server("s"),
         enforcement=Enforcement(point="attest-only", effect="advisory"),
         attest=False)


def test_advisory_mode_marks_deny_as_advisory_and_runs_fn(tmp_path):
    """Advisory mode: on deny, the fn runs anyway and the record says so.
    The recorded decision reflects what the policy WOULD deny, and
    enforcement.effect is 'advisory' so no auditor mistakes it for a
    real block. Staged-rollout use case."""
    import json

    from custos.keys import generate_keypair
    from custos.ledger import Ledger
    from custos.policy import load_policy
    from custos.record import Actor, Server
    from custos.sdk import Gate

    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy({
        "version": 1, "default": "deny",
        "rules": [{"id": "allow-read", "when": {"tool": "read"}, "decision": "allow"}],
    })
    gate = Gate(policy, ledger, Actor("a"), Server("s"), advisory=True)
    # This would normally be denied (default: deny), but advisory=True runs
    # the fn AND records the deny opinion.
    ran = []
    r = gate.call("write", {"i": 0}, fn=lambda i: ran.append(i) or "done")
    assert ran == [0], "advisory mode must execute the fn even on deny"
    assert r.record.decision.value == "deny"
    assert r.record.enforcement.effect == "advisory"

    lines = (tmp_path / "ledger.jsonl").read_text(encoding="utf-8").splitlines()
    decisions = [
        json.loads(l) for l in lines if json.loads(l).get("type") != "attestation"
    ]
    assert len(decisions) == 1
    rec = decisions[0]
    assert rec["enforcement"] == {"point": "sdk", "effect": "advisory"}
    assert rec["decision"] == "deny"


def test_replay_reconstructs_decisions_from_snapshot(tmp_path):
    """Given a ledger + content-addressed policy snapshots, `replay_ledger`
    must resolve each record's policy.hash, load the policy, and confirm
    the recorded rule (or default) is consistent with the policy text.

    This is the reviewer's core audit ask: reconstruct WHY an agent was
    permitted / denied a specific action, using only the sealed evidence.
    """
    from custos.keys import generate_keypair
    from custos.ledger import Ledger
    from custos.policy import load_policy
    from custos.record import Actor, Server
    from custos.sdk import Gate

    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)

    # Two policies, both live over the same ledger.
    p1 = load_policy({
        "version": 1, "id": "t", "default": "deny",
        "rules": [{"id": "allow-read", "when": {"tool": "read"}, "decision": "allow"}],
    })
    g1 = Gate(p1, ledger, Actor("a1"), Server("s1"))
    g1.call("read", {"i": 0}, fn=lambda i: i)      # allow via rule
    g1.call("write", {"i": 0}, fn=lambda i: i)     # deny via default

    p2 = load_policy({"version": 1, "id": "t", "default": "allow", "rules": []})
    g2 = Gate(p2, ledger, Actor("a1"), Server("s1"))
    g2.call("anything", {}, fn=lambda: 1)          # allow via default

    r = replay_ledger(tmp_path / "ledger.jsonl")
    assert r.ok, (r.missing_policies, r.mismatches)
    # 2 Gates each emit 1 startup attestation + 3 decision records.
    assert r.records == 5
    assert r.replayed == 3
    assert r.skipped_no_hash == 0
    assert r.missing_policies == []
    assert r.mismatches == []


def test_replay_flags_missing_snapshot(tmp_path):
    """A record whose policy.hash has no snapshot on disk MUST be
    reported — silence would defeat the point of the whole feature."""
    from custos.keys import generate_keypair
    from custos.ledger import Ledger
    from custos.policy import load_policy
    from custos.record import Actor, Server
    from custos.sdk import Gate

    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy({"version": 1, "id": "t", "default": "allow", "rules": []})
    gate = Gate(policy, ledger, Actor("a1"), Server("s1"))
    gate.call("t", {}, fn=lambda: 1)

    # Remove the snapshot to simulate a lost policy source.
    snap_dir = tmp_path / "policies"
    for f in snap_dir.iterdir():
        f.unlink()

    r = replay_ledger(tmp_path / "ledger.jsonl")
    assert not r.ok
    assert len(r.missing_policies) == 1
    assert policy.hash in r.missing_policies[0]


def test_replay_rejects_path_traversal_in_policy_hash(tmp_path):
    """A malicious ledger with policy.hash = 'sha256:../foo' MUST NOT be
    treated as a filesystem lookup. Without validation, pathlib.glob
    happily traverses outside policies_dir and any matching file gets
    fed to yaml.safe_load — turning a signed-log replay into a file
    probe / arbitrary-YAML-parse primitive. Regression test for the
    review's P1 finding."""
    import json

    from custos.keys import generate_keypair
    from custos.ledger import Ledger
    from custos.policy import load_policy
    from custos.record import Actor, Server
    from custos.sdk import Gate

    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy({"version": 1, "id": "t", "default": "allow", "rules": []})
    gate = Gate(policy, ledger, Actor("a"), Server("s"))
    gate.call("t", {}, fn=lambda: 1)

    # Rewrite the (last) decision record with a poisoned policy.hash. We
    # do this by parsing/mutating/rewriting so the chain hash still
    # matches — the point is that the verifier's REPLAY path is what
    # gets attacked, not the chain integrity check.
    p = tmp_path / "ledger.jsonl"
    lines = p.read_text(encoding="utf-8").splitlines()
    decision_idx = next(i for i, l in enumerate(lines) if json.loads(l).get("type") != "attestation")
    rec = json.loads(lines[decision_idx])
    rec["policy"]["hash"] = "sha256:../../etc/passwd"
    lines[decision_idx] = json.dumps(rec, separators=(",", ":"))
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")

    r = replay_ledger(p)
    # Must NOT crash, must NOT emit a "missing" entry (which would still
    # confirm the file was probed), must reject the value up-front.
    assert not r.ok
    assert any("not a valid sha256" in m for m in r.mismatches), r.mismatches
    assert not r.missing_policies


def test_replay_detects_swapped_policy(tmp_path):
    """If someone replaces the snapshot at <hex>.<ext> with a policy that
    does not actually contain the recorded rule (or whose rule has a
    different decision), replay MUST flag it as a mismatch. This is the
    "backdated policy" attack the reviewer implicitly cares about."""
    from custos.keys import generate_keypair
    from custos.ledger import Ledger
    from custos.policy import load_policy
    from custos.record import Actor, Server
    from custos.sdk import Gate

    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy({
        "version": 1, "id": "t", "default": "deny",
        "rules": [{"id": "allow-read", "when": {"tool": "read"}, "decision": "allow"}],
    })
    gate = Gate(policy, ledger, Actor("a1"), Server("s1"))
    gate.call("read", {"i": 0}, fn=lambda i: i)

    # Overwrite the on-disk snapshot with a DIFFERENT policy — one that
    # lacks the `allow-read` rule. Note: the filename `<hex>.<ext>` still
    # claims to hash to `policy.hash`, so the load check will catch the
    # tampered filename first; that's the layered defense.
    hex_hash = policy.hash.split(":", 1)[1]
    snap = tmp_path / "policies" / f"{hex_hash}.json"
    snap.write_bytes(b'{"version":1,"id":"t","default":"deny","rules":[]}')

    r = replay_ledger(tmp_path / "ledger.jsonl")
    assert not r.ok
    # Either the hash-vs-filename check fires (preferred) or the
    # rule-missing check fires — both are correct signals of tamper.
    assert r.mismatches, (r.missing_policies, r.mismatches)


def test_verify_coverage_reports_gaps_between_attestations(tmp_path):
    """Reviewer's ask #2 rendered concrete: given a stream of attestation
    records, verify_coverage names the intervals where no attestation was
    observed. Silence stops being ambiguous — auditors see exactly which
    time window is unaccounted for."""
    import time
    from datetime import datetime, timezone, timedelta

    from custos.keys import generate_keypair
    from custos.ledger import Ledger
    from custos.record import Actor, Server

    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)

    # Emit four attestations. The 3rd is far away from the 2nd — that's
    # the observable gap. We can't easily manipulate `ts` on the record
    # without going around the Ledger.append_attestation API, so use
    # real sleeps but scale interval and tolerance so the test finishes
    # in <1s.
    ledger.append_attestation(reason="startup", custos_version="test")
    time.sleep(0.02)
    ledger.append_attestation(reason="periodic", custos_version="test")
    time.sleep(0.5)  # this is the "gap"
    ledger.append_attestation(reason="periodic", custos_version="test")
    time.sleep(0.02)
    ledger.append_attestation(reason="shutdown", custos_version="test")

    # interval=0.1s tolerance=2 → threshold=0.2s. The 0.5s sleep is a gap.
    r = verify_coverage(tmp_path / "ledger.jsonl", interval_s=0.1, tolerance=2.0)
    assert r.attestations == 4
    assert r.by_reason == {"startup": 1, "periodic": 2, "shutdown": 1}
    assert not r.ok, "0.5s gap should be reported"
    assert len(r.gaps) == 1
    assert r.gaps[0].duration_s >= 0.4


def test_iso_now_ms_roundtrips_through_parse_iso():
    """`_parse_iso` is version-sensitive: Python 3.11 rewrote
    `datetime.fromisoformat` for full RFC3339, but 3.10 (still supported
    per pyproject.toml) only handles the specific shape `isoformat()`
    emits. This test pins the exact output of `iso_now_ms()` against the
    verifier's parser so a future format change on either side breaks
    loudly, not silently."""
    from custos.ids import iso_now_ms
    from custos.verify import _parse_iso

    ts = iso_now_ms()
    # Structural: RFC3339 UTC millisecond, e.g. 2026-08-08T12:34:56.789Z.
    assert ts.endswith("Z")
    assert "T" in ts
    assert "." in ts

    # Semantic: parse must succeed and produce a finite epoch second.
    epoch = _parse_iso(ts)
    assert isinstance(epoch, float)
    assert epoch > 0

    # Regression pin: a hand-crafted representative literal MUST also parse.
    # If a future refactor changes the emitter format, both this literal
    # and iso_now_ms() would need to be updated in lockstep.
    assert _parse_iso("2026-08-08T12:34:56.789Z") > 0


def test_verify_coverage_does_not_crash_on_malformed_ts(tmp_path):
    """Sig verification covers body bytes, not semantic content. An
    attacker with the signing key (or a buggy writer) can poison the
    ts field. verify_coverage MUST report this cleanly instead of
    raising ValueError up the stack. Regression test for the review's
    P2 finding."""
    import json

    from custos.keys import generate_keypair
    from custos.ledger import Ledger

    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    ledger.append_attestation(reason="periodic", custos_version="test")
    ledger.append_attestation(reason="periodic", custos_version="test")

    # Poison the second record's ts field.
    p = tmp_path / "ledger.jsonl"
    lines = p.read_text(encoding="utf-8").splitlines()
    rec = json.loads(lines[1])
    rec["ts"] = "not-a-timestamp"
    lines[1] = json.dumps(rec, separators=(",", ":"))
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Must not raise.
    r = verify_coverage(p, interval_s=0.1, tolerance=2.0)
    assert not r.ok
    assert len(r.gaps) >= 1
    # Synthetic gap uses duration_s = -1.0 as sentinel for "malformed
    # boundary" — auditors see it in the same list they scan for real
    # gaps.
    assert any(g.duration_s == -1.0 for g in r.gaps)


def test_verify_coverage_ok_when_cadence_within_tolerance(tmp_path):
    """When every consecutive attestation pair is within tolerance, the
    result claims 'control was observably operating' for the window."""
    import time

    from custos.keys import generate_keypair
    from custos.ledger import Ledger

    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    for i in range(5):
        ledger.append_attestation(reason="periodic", custos_version="test")
        time.sleep(0.03)

    # interval 0.1s * tolerance 2 = 0.2s threshold; every gap is ~0.03s.
    r = verify_coverage(tmp_path / "ledger.jsonl", interval_s=0.1, tolerance=2.0)
    assert r.ok, r.gaps
    assert r.attestations == 5
    assert r.gaps == []


def test_tamper_detected(workdir):
    tmp_path, gate = workdir
    for i in range(3):
        gate.call("read", {"i": i}, fn=lambda i: i)

    # Tamper: flip a byte in the middle of the file
    p = tmp_path / "ledger.jsonl"
    data = bytearray(p.read_bytes())
    # find first "allow" occurrence and mutate to "deny "
    idx = data.find(b'"allow"')
    assert idx > 0
    data[idx : idx + 7] = b'"deny "'
    p.write_bytes(bytes(data))

    v = verify_ledger(p, tmp_path / "ledger.pub")
    assert not v.ok
    assert any("record_hash" in e or "sig" in e or "seq" in e for e in v.errors)
