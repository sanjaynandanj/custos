"""Python writes a signed ledger for Node to verify."""
import sys
from pathlib import Path

from custos.keys import generate_keypair
from custos.ledger import Ledger
from custos.policy import load_policy
from custos.record import Actor, Server
from custos.sdk import Gate


def main(out_dir: str) -> None:
    d = Path(out_dir)
    d.mkdir(parents=True, exist_ok=True)
    kp = generate_keypair()
    kp.save(d)
    ledger = Ledger(d / "ledger.jsonl", kp)
    policy = load_policy({
        "version": 1, "default": "deny",
        "rules": [
            {"id": "allow-read", "when": {"tool": "read"}, "decision": "allow", "reason": "ok"},
        ],
    })
    gate = Gate(policy, ledger, Actor("py-agent"), Server("py-srv", pubkey=kp.public_b64()))
    for i in range(5):
        gate.call("read", {"i": i, "note": "café"}, fn=lambda i, note: {"got": i, "n": note})
    gate.call("write", {"i": 99}, fn=lambda i: i)  # denied
    print(f"wrote {d/'ledger.jsonl'}")


if __name__ == "__main__":
    main(sys.argv[1])
