import pytest

from custos.policy import load_policy
from custos.record import Decision


def test_default_deny():
    p = load_policy({"version": 1, "id": "t", "default": "deny", "rules": []})
    r = p.evaluate({"tool": "x", "actor": {"id": "a"}, "server": {"id": "s"}, "args": {}})
    assert r.decision == Decision.DENY


def test_exact_match_allow():
    p = load_policy({
        "version": 1, "default": "deny",
        "rules": [{"id": "r1", "when": {"tool": "read_file"}, "decision": "allow", "reason": "ok"}],
    })
    r = p.evaluate({"tool": "read_file", "actor": {"id": "a"}, "server": {"id": "s"}, "args": {}})
    assert r.decision == Decision.ALLOW
    assert r.rule_id == "r1"


def test_prefix_and_wildcard():
    p = load_policy({
        "version": 1, "default": "deny",
        "rules": [{
            "id": "r1",
            "when": {"actor.id": "agent-*", "args.path": {"prefix": "/workspace/"}},
            "decision": "allow",
        }],
    })
    ctx = {"tool": "read_file", "actor": {"id": "agent-42"}, "server": {"id": "s"}, "args": {"path": "/workspace/x.txt"}}
    assert p.evaluate(ctx).decision == Decision.ALLOW
    ctx["args"]["path"] = "/etc/passwd"
    assert p.evaluate(ctx).decision == Decision.DENY


def test_regex_and_in():
    p = load_policy({
        "version": 1, "default": "deny",
        "rules": [{
            "id": "http",
            "when": {"tool": "http_request", "args.method": {"in": ["GET", "HEAD"]}, "args.url": {"regex": "^https://"}},
            "decision": "allow",
        }],
    })
    ctx = {"tool": "http_request", "actor": {"id": "a"}, "server": {"id": "s"}, "args": {"method": "GET", "url": "https://x"}}
    assert p.evaluate(ctx).decision == Decision.ALLOW
    ctx["args"]["method"] = "POST"
    assert p.evaluate(ctx).decision == Decision.DENY


def test_policy_regex_precompiled():
    """Sanity check that regexes are compiled once at load time: 10 rules × 1000
    evaluations should complete in well under 1 second. Also verifies that an
    invalid regex raises at load, not on first evaluation."""
    import time

    rules = [
        {
            "id": f"r{i}",
            "when": {"tool": {"regex": f"^tool-{i}-.*$"}},
            "decision": "allow",
        }
        for i in range(10)
    ]
    p = load_policy({"version": 1, "default": "deny", "rules": rules})
    ctx = {"tool": "tool-9-x", "actor": {"id": "a"}, "server": {"id": "s"}, "args": {}}
    t0 = time.perf_counter()
    for _ in range(1000):
        p.evaluate(ctx)
    elapsed = time.perf_counter() - t0
    assert elapsed < 1.0, f"regex eval too slow: {elapsed:.3f}s"

    with pytest.raises(ValueError):
        load_policy({
            "version": 1, "default": "deny",
            "rules": [{"id": "bad", "when": {"tool": {"regex": "([unclosed"}}, "decision": "allow"}],
        })


def test_exists_operator():
    p = load_policy({
        "version": 1, "default": "allow",
        "rules": [{"id": "req-actor", "when": {"actor.token": {"exists": False}}, "decision": "deny"}],
    })
    ctx = {"tool": "x", "actor": {"id": "a"}, "server": {"id": "s"}, "args": {}}
    assert p.evaluate(ctx).decision == Decision.DENY


def test_policy_hash_is_content_addressed(tmp_path):
    """A policy's ``hash`` MUST be a deterministic sha256 of its source
    bytes, so that a decision record's ``policy.hash`` pins the exact text
    that produced the decision. Editing the source (even trivially) MUST
    change the hash — that is the whole point of the field."""
    p1 = load_policy({"version": 1, "id": "t", "default": "deny", "rules": []})
    p2 = load_policy({"version": 1, "id": "t", "default": "deny", "rules": []})
    assert p1.hash.startswith("sha256:")
    assert len(p1.hash) == len("sha256:") + 64
    assert p1.hash == p2.hash, "same input must yield same hash"

    p3 = load_policy({"version": 1, "id": "t", "default": "allow", "rules": []})
    assert p1.hash != p3.hash, "different input must yield different hash"

    # File-backed: byte-identical files hash the same; a one-byte edit changes
    # the hash. Auditors will diff the exact bytes committed to git — the
    # hash MUST reflect that, not the parsed shape.
    f = tmp_path / "policy.yaml"
    f.write_bytes(b"version: 1\nid: t\ndefault: deny\nrules: []\n")
    a = load_policy(f)
    b = load_policy(f)
    assert a.hash == b.hash
    f.write_bytes(b"version: 1\nid: t\ndefault: allow\nrules: []\n")
    c = load_policy(f)
    assert a.hash != c.hash
