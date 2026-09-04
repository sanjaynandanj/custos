"""Custos CLI: `custos <command>`."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import click

from custos import __version__
from custos.bundle import create_bundle, verify_bundle
from custos.demo import run_demo
from custos.init import run_init
from custos.keys import generate_keypair, load_keypair
from custos.ledger import Ledger
from custos.policy import load_policy
from custos.record import Actor, Server
from custos.telemetry import emit as tel_emit, prompt_consent
from custos.verify import replay_ledger, verify_coverage, verify_ledger


@click.group()
@click.version_option(__version__, prog_name="custos")
def main():
    """Custos: runtime governance for MCP tool calls."""


@main.command()
@click.option("--dir", "dir_", default="./.custos", show_default=True, help="Directory to scaffold")
@click.option("--force", is_flag=True, help="Overwrite existing keypair and policy")
@click.option("--yes", is_flag=True, help="Assume yes to telemetry prompt (non-interactive)")
@click.option("--no-telemetry", is_flag=True, help="Assume no to telemetry prompt (non-interactive)")
def init(dir_: str, force: bool, yes: bool, no_telemetry: bool):
    """Scaffold .custos/ with keypair, starter policy, and .gitignore."""
    r = run_init(dir_path=dir_, force=force)
    click.echo(f"custos init  ->  {r.dir}")
    for f in r.created:
        click.echo(f"  + {f}")
    for f in r.skipped:
        click.echo(f"  = {f} (exists, use --force to overwrite)")
    click.echo(f"  pubkey (base64): {r.pubkey}")

    cfg = prompt_consent(assume_yes=yes, assume_no=no_telemetry)
    if cfg.enabled:
        tel_emit("install", __version__)

    click.echo("\nNext:")
    click.echo("  custos demo                       # 30-second end-to-end run")
    click.echo(f"  custos show-policy {r.dir}/policy.yaml")
    click.echo(f"  custos proxy --policy {r.dir}/policy.yaml -- <upstream-mcp-cmd>")


@main.command()
@click.option("--keep", is_flag=True, help="Retain the temp ledger dir for inspection")
@click.option("--quiet", is_flag=True, help="Suppress output (for scripting)")
def demo(keep: bool, quiet: bool):
    """Self-contained end-to-end run against an in-process mock MCP."""
    r = run_demo(keep=keep, quiet=quiet)
    tel_emit("demo", __version__)
    if not r.verified:
        sys.exit(1)


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
@click.option(
    "--replay",
    is_flag=True,
    help=(
        "Also point-in-time replay: for each record, resolve the policy at "
        "record.policy.hash and assert the recorded rule/default is consistent "
        "with the loaded policy text. Requires content-addressed snapshots "
        "in --policies-dir (default: <ledger>/../policies)."
    ),
)
@click.option(
    "--policies-dir",
    "policies_dir",
    default=None,
    help="Content-addressed policy snapshot directory (for --replay).",
)
def verify(ledger_path: str, pub_path: str | None, replay: bool, policies_dir: str | None):
    """Verify a signed ledger; optionally replay policy at each record's hash."""
    r = verify_ledger(ledger_path, pub_path)
    if r.ok:
        click.secho(f"OK  {r.records} records verified", fg="green")
    else:
        for e in r.errors:
            click.secho(f"ERR {e}", fg="red")
        sys.exit(1)

    if replay:
        rr = replay_ledger(ledger_path, policies_dir=policies_dir)
        # Report structure is deliberately verbose — auditors want the
        # non-happy path enumerated line-by-line, not a summary.
        click.echo(
            f"REPLAY  {rr.replayed}/{rr.records} records replayed"
            f" (skipped {rr.skipped_no_hash} pre-v0.4.0 records)"
        )
        for m in rr.missing_policies:
            click.secho(f"MISS   {m}", fg="yellow")
        for m in rr.mismatches:
            click.secho(f"MISMATCH {m}", fg="red")
        if not rr.ok:
            sys.exit(2)
    sys.exit(0)


@main.command()
@click.option("--ledger", "ledger_path", default="./.custos/ledger.jsonl", show_default=True)
@click.option(
    "--interval", "interval_s", default=60.0, show_default=True, type=float,
    help="Expected periodic attestation interval in seconds.",
)
@click.option(
    "--tolerance", default=2.0, show_default=True, type=float,
    help="Multiplier: any gap > interval * tolerance is flagged.",
)
def coverage(ledger_path: str, interval_s: float, tolerance: float):
    """Report control-liveness coverage from attestation records (WIRE §2.3).

    Answers the reviewer's question: "was the control actually running
    the whole time, or did it just stop observing?" Requires the
    operator to have emitted periodic attestations on the expected
    cadence — otherwise gaps are ambiguous.
    """
    r = verify_coverage(ledger_path, interval_s=interval_s, tolerance=tolerance)
    if r.attestations == 0:
        click.secho("NO ATTESTATIONS in ledger — cannot compute coverage.", fg="yellow")
        click.echo(
            "Emit `Gate(..., attest=True)` (default) or "
            "`ledger.append_attestation(reason='periodic', ...)` on your cadence."
        )
        sys.exit(2)
    click.echo(
        f"COVERAGE  {r.attestations} attestations across {r.window_s:.1f}s "
        f"({r.first_ts} → {r.last_ts})"
    )
    for reason, n in sorted(r.by_reason.items()):
        click.echo(f"  {reason:<14} {n}")
    if r.gaps:
        click.secho(
            f"GAPS  {len(r.gaps)} gap(s) > {interval_s * tolerance:.1f}s"
            f" (max {r.max_gap_s:.1f}s, total {r.total_gap_s:.1f}s)",
            fg="red",
        )
        for g in r.gaps:
            click.echo(f"  {g.from_ts} → {g.to_ts}  ({g.duration_s:.1f}s)")
        sys.exit(2)
    click.secho(
        f"OK   control observably operating for {r.window_s:.1f}s with no gaps",
        fg="green",
    )
    sys.exit(0)


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
    tel_emit("proxy", __version__)
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
@click.option(
    "--token",
    default=None,
    help="Require Authorization: Bearer <token> on /api/* (or set CUSTOS_DASHBOARD_TOKEN)",
)
def serve(ledger_path: str, host: str, port: int, token: str | None):
    """Launch the FastAPI dashboard (requires `pip install custos-mcp[web]`).

    The dashboard has NO authentication by default. Do not expose it to
    untrusted networks. Use --token or CUSTOS_DASHBOARD_TOKEN to require
    a bearer token.
    """
    from custos.dashboard import create_app
    import uvicorn

    tel_emit("serve", __version__)
    uvicorn.run(create_app(ledger_path, token=token), host=host, port=port, log_level="warning")


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
