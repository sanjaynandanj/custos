"""Simulate 6 coding-agent tool calls under a Custos policy.

Mix of read/write/shell/commit/delete — some allowed, some denied. The Gate
records every decision to `.custos/ledger.jsonl` regardless.
"""
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
gate = Gate(policy, ledger, Actor("coding-agent"), Server("dev-tools", pubkey=kp.public_b64()))


# Mock tool implementations — the Gate only calls these on ALLOW.
def read_file(path):     return f"<read {path}>"
def write_file(path, content): return {"written": path, "bytes": len(content)}
def run_shell(cmd):      return {"stdout": f"ran: {cmd}", "exit": 0}
def git_commit(branch, message): return {"branch": branch, "sha": "deadbeef"}
def delete_file(path):   return {"deleted": path}

calls = [
    ("read_file",   {"path": "src/app.py"}),                                  # allow
    ("write_file",  {"path": "../etc/hosts", "content": "evil"}),             # deny (traversal)
    ("write_file",  {"path": "src/main.ts", "content": "ok"}),                # allow
    ("run_shell",   {"cmd": "pytest"}),                                       # allow
    ("run_shell",   {"cmd": "rm -rf /"}),                                     # deny (not in whitelist)
    ("git_commit",  {"branch": "main", "message": "bypass"}),                 # deny (protected)
    ("delete_file", {"path": "src/app.py"}),                                  # deny (never)
]

fns = {
    "read_file": read_file, "write_file": write_file, "run_shell": run_shell,
    "git_commit": git_commit, "delete_file": delete_file,
}

for tool, args in calls:
    r = gate.call(tool, args, fn=fns[tool])
    tag = "ALLOW" if r.allowed else "DENY "
    print(f"{tag} {tool:12s} rule={r.rule or '-':30s} reason={r.reason}")

print(f"\nledger records: {ledger.seq}   head: {ledger.head}")
