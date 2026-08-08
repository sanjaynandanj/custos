"""Custos CLI: `custos <command>`."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import click

from custos import __version__
from custos.bundle import create_bundle, verify_bundle
from custos.keys import generate_keypair, load_keypair
from custos.ledger import Ledger
from custos.policy import load_policy
from custos.record import Actor, Server
from custos.verify import verify_ledger


@click.group()
@click.version_option(__version__, prog_name="custos")
def main():
    """Custos: runtime governance for MCP tool calls."""


@main.command()
@click.option("--dir", "dir_", default="./.custos", show_default=True, help="Directory to write ledger.key + ledger.pub")
def keygen(dir_: str):
    """Generate a new Ed25519 signing keypair."""
    kp = generate_keypair()
    kp.save(dir_)
    click.echo(f"wrote {dir_}/ledger.key + ledger.pub")
    click.echo(f"pubkey (base64): {kp.public_b64()}")


@main.command()
@click.option("--ledger", "ledger_path", default="./.custos/ledger.jsonl", show_default=True)
@click.option("--pub", "pub_path", default=None, help="Public key (defaults to ledger.pub sidecar)")
def verify(ledger_path: str, pub_path: str | None):
    """Verify a signed ledger."""
    r = verify_ledger(ledger_path, pub_path)
    if r.ok:
        click.secho(f"OK  {r.records} records verified", fg="green")
        sys.exit(0)
    else:
        for e in r.errors:
            click.secho(f"ERR {e}", fg="red")
        sys.exit(1)


@main.command()
@click.option("--policy", "policy_path", required=True, help="Policy YAML/JSON")
@click.option("--ledger", "ledger_path", default="./.custos/ledger.jsonl", show_default=True)
@click.option("--keys", "keys_dir", default="./.custos", show_default=True)
@click.option("--actor-id", default="agent")
@click.option("--server-id", default="upstream")
@click.argument("upstream", nargs=-1, required=True)
def proxy(policy_path: str, ledger_path: str, keys_dir: str, actor_id: str, server_id: str, upstream: tuple):
    """Run stdio MCP proxy: custos proxy --policy p.yaml -- python -m server."""
    from custos.proxy import ProxyConfig, run_stdio_proxy

    policy = load_policy(policy_path)
    kp = load_keypair(keys_dir)
    ledger = Ledger(ledger_path, kp)
    cfg = ProxyConfig(
        upstream_cmd=list(upstream),
        policy=policy,
        ledger=ledger,
        actor=Actor(id=actor_id),
        server=Server(id=server_id, pubkey=kp.public_b64()),
    )
    code = asyncio.run(run_stdio_proxy(cfg))
    sys.exit(code)


@main.command()
@click.option("--ledger", "ledger_path", default="./.custos/ledger.jsonl", show_default=True)
@click.option("--host", default="127.0.0.1", show_default=True)
@click.option("--port", default=8787, show_default=True, type=int)
def serve(ledger_path: str, host: str, port: int):
    """Launch the FastAPI dashboard (requires `pip install custos-mcp[web]`)."""
    from custos.dashboard import create_app
    import uvicorn

    uvicorn.run(create_app(ledger_path), host=host, port=port, log_level="warning")


@main.command()
@click.option("--ledger", "ledger_path", default="./.custos/ledger.jsonl", show_default=True)
@click.option("--keys", "keys_dir", default="./.custos", show_default=True)
@click.option("--policies", default=None, help="Optional policies dir to snapshot")
@click.argument("output")
def bundle(ledger_path: str, keys_dir: str, policies: str | None, output: str):
    """Export a signed evidence bundle."""
    kp = load_keypair(keys_dir)
    ledger = Path(ledger_path)
    pub = ledger.parent / (ledger.stem + ".pub")
    out = create_bundle(ledger, pub, output, kp, policies_dir=policies)
    click.echo(f"wrote {out}")


@main.command("verify-bundle")
@click.argument("bundle_path")
def verify_bundle_cmd(bundle_path: str):
    """Verify a portable evidence bundle."""
    r = verify_bundle(bundle_path)
    if r["ok"]:
        click.secho(f"OK  {r['records']} records verified", fg="green")
        click.echo(json.dumps(r.get("manifest"), indent=2))
        sys.exit(0)
    click.secho(f"FAIL {r['errors']}", fg="red")
    sys.exit(1)


@main.command("show-policy")
@click.argument("policy_path")
def show_policy(policy_path: str):
    """Load and print a normalized policy."""
    p = load_policy(policy_path)
    click.echo(f"id={p.id} version={p.version} default={p.default.value} rules={len(p.rules)}")
    for r in p.rules:
        click.echo(f"  {r.id}: when={r.when} decision={r.decision.value} reason={r.reason!r}")


if __name__ == "__main__":
    main()
