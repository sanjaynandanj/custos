from pathlib import Path

from custos.init import run_init
from custos.keys import load_keypair
from custos.policy import load_policy


def test_init_scaffolds_all_files(tmp_path: Path):
    target = tmp_path / ".custos"
    r = run_init(target)

    assert "ledger.key" in r.created
    assert "ledger.pub" in r.created
    assert "policy.yaml" in r.created
    assert ".gitignore" in r.created
    assert r.pubkey

    # Policy parses.
    p = load_policy(str(target / "policy.yaml"))
    assert p.id == "starter"
    assert len(p.rules) > 0

    # Keypair round-trips.
    assert load_keypair(target).public_b64() == r.pubkey

    # Secret is gitignored.
    assert "ledger.key" in (target / ".gitignore").read_text(encoding="utf-8")


def test_init_preserves_keypair_on_second_call(tmp_path: Path):
    target = tmp_path / ".custos"
    first = run_init(target)
    second = run_init(target)
    assert second.pubkey == first.pubkey
    assert "ledger.key" in second.skipped
    assert "policy.yaml" in second.skipped


def test_init_force_overwrites(tmp_path: Path):
    target = tmp_path / ".custos"
    first = run_init(target)
    second = run_init(target, force=True)
    assert second.pubkey != first.pubkey
