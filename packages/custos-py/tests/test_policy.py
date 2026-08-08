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


def test_exists_operator():
    p = load_policy({
        "version": 1, "default": "allow",
        "rules": [{"id": "req-actor", "when": {"actor.token": {"exists": False}}, "decision": "deny"}],
    })
    ctx = {"tool": "x", "actor": {"id": "a"}, "server": {"id": "s"}, "args": {}}
    assert p.evaluate(ctx).decision == Decision.DENY
