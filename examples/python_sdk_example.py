"""In-process Gate SDK example (Python).

Run:
  pip install custos-mcp
  python examples/python_sdk_example.py
"""
import shutil
from pathlib import Path

from custos import Actor, Gate, Ledger, Server, generate_keypair, load_policy


def read_file(path: str) -> str:
    return Path(path).read_text() if Path(path).exists() else f"<missing:{path}>"


def http_request(method: str, url: str) -> dict:
    return {"status": 200, "url": url, "method": method}


def main():
    workdir = Path(".custos-demo")
    if workdir.exists():
        shutil.rmtree(workdir)
    kp = generate_keypair()
    kp.save(workdir)
    ledger = Ledger(workdir / "ledger.jsonl", kp)
    policy = load_policy("examples/policy.yaml")

    gate = Gate(policy, ledger, Actor("agent-1"), Server("demo", pubkey=kp.public_b64()))

    for path in ["/workspace/notes.md", "/etc/passwd", "/workspace/../secret"]:
        r = gate.call("read_file", {"path": path}, fn=read_file)
        print(f"  read_file({path!r}) -> {r.decision.value}  reason={r.reason!r}")

    for m, u in [("GET", "https://api.example.com/"), ("POST", "https://api.example.com/"), ("GET", "http://x")]:
        r = gate.call("http_request", {"method": m, "url": u}, fn=http_request)
        print(f"  http_request({m},{u}) -> {r.decision.value}  reason={r.reason!r}")

    print(f"\nledger head: {ledger.head}")
    print(f"records: {ledger.seq}")

    from custos.verify import verify_ledger
    v = verify_ledger(workdir / "ledger.jsonl")
    print(f"verify: ok={v.ok} records={v.records}")


if __name__ == "__main__":
    main()
