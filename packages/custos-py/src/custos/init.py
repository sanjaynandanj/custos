"""`custos init` — scaffold .custos/ (keypair + starter policy + .gitignore)."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from custos.keys import generate_keypair, load_keypair


STARTER_POLICY = """# Custos policy — evaluated top-to-bottom, first match wins.
# See https://github.com/sanjaynandanj/custos for the full grammar.
version: 1
id: starter
default: deny
rules:
  - id: no-traversal
    when:
      args.path: {contains: ".."}
    decision: deny
    reason: path traversal blocked

  - id: allow-workspace-read
    when:
      tool: read_file
      args.path: {prefix: "/workspace/"}
    decision: allow
    reason: workspace-only reads

  - id: safe-http-get
    when:
      tool: http_request
      args.method: {in: ["GET", "HEAD"]}
      args.url: {regex: "^https://"}
    decision: allow
    reason: HTTPS GET/HEAD

  - id: deny-shell
    when:
      tool: {regex: "^shell\\\\."}
    decision: deny
    reason: shell tools disabled
"""

GITIGNORE = """# Ledger signing key — never commit
ledger.key
# Ledger data — audit artefacts, ship via `custos bundle` instead
ledger.jsonl
"""


@dataclass
class InitResult:
    dir: Path
    created: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    pubkey: str = ""


def run_init(dir_path: str | Path = "./.custos", force: bool = False) -> InitResult:
    d = Path(dir_path).resolve()
    d.mkdir(parents=True, exist_ok=True)
    r = InitResult(dir=d)

    def write(name: str, contents: str) -> None:
        p = d / name
        if p.exists() and not force:
            r.skipped.append(name)
            return
        p.write_text(contents, encoding="utf-8")
        r.created.append(name)

    key_path = d / "ledger.key"
    pub_path = d / "ledger.pub"
    if key_path.exists() and pub_path.exists() and not force:
        r.skipped.extend(["ledger.key", "ledger.pub"])
        r.pubkey = load_keypair(d).public_b64()
    else:
        kp = generate_keypair()
        kp.save(d)
        r.created.extend(["ledger.key", "ledger.pub"])
        r.pubkey = kp.public_b64()

    write("policy.yaml", STARTER_POLICY)
    write(".gitignore", GITIGNORE)
    return r
