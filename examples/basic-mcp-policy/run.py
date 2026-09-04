"""Smallest possible Custos example: one tool, one allow rule, one fallback deny."""
import shutil
from pathlib import Path
from custos import Actor, Gate, Ledger, Server, generate_keypair, load_policy

here = Path(__file__).parent
workdir = here / ".custos"
if workdir.exists():
    shutil.rmtree(workdir)
kp = generate_keypair()
kp.save(workdir)
ledger = Ledger(workdir / "ledger.jsonl", kp)
policy = load_policy(here / "policy.yaml")

gate = Gate(policy, ledger, Actor("agent-1"), Server("demo", pubkey=kp.public_b64()))


def read_file(path: str) -> str:
    return f"<contents of {path}>"


for path in ["/workspace/notes.txt", "/etc/passwd"]:
    r = gate.call("read_file", {"path": path}, fn=read_file)
    print(f"read_file({path!r}) -> {r.decision.value}  reason={r.reason!r}")
print(f"\nledger head: {ledger.head}   records: {ledger.seq}")
