from pathlib import Path

from custos.demo import run_demo


def test_demo_runs_three_calls_and_verifies(tmp_path: Path):
    r = run_demo(dir_path=tmp_path / "demo", keep=True, quiet=True)
    # 1 startup attestation (Gate init) + 3 gate.call decisions.
    assert r.records == 4
    assert r.verified is True
    decisions = [x.decision.value for x in r.results]
    assert decisions == ["allow", "deny", "deny"]
    assert r.results[1].rule == "no-traversal"
    assert r.results[2].rule == "deny-shell"


def test_demo_keep_leaves_ledger(tmp_path: Path):
    d = tmp_path / "demo"
    r = run_demo(dir_path=d, keep=True, quiet=True)
    assert r.dir == d
    assert (d / "ledger.jsonl").exists()
