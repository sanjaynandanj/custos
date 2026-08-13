"""Opt-in anonymous telemetry (Python).

What is sent: {id, event, version, os, python} — nothing else.
Never sent: file paths, policy contents, tool names, ledger data, hostnames.

Off by default. Users must consent via `custos init`, or by editing
~/.custos/telemetry.json. Env var CUSTOS_TELEMETRY=off overrides consent.
No network requests unless CUSTOS_TELEMETRY_URL is set to a non-empty value.
"""
from __future__ import annotations

import json
import os
import platform
import sys
import threading
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib import request as urlrequest


CONFIG_DIR = Path.home() / ".custos"
CONFIG_PATH = CONFIG_DIR / "telemetry.json"


@dataclass
class TelemetryConfig:
    enabled: bool
    id: str
    consented_at: str
    version: int = 1


def _config_dir() -> Path:
    # Recomputed each call so tests that override HOME see the new location.
    return Path.home() / ".custos"


def _config_path() -> Path:
    return _config_dir() / "telemetry.json"


def read_config() -> Optional[TelemetryConfig]:
    p = _config_path()
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return TelemetryConfig(
            enabled=bool(data.get("enabled", False)),
            id=str(data.get("id", "")),
            consented_at=str(data.get("consented_at", "")),
            version=int(data.get("version", 1)),
        )
    except Exception:
        return None


def write_config(cfg: TelemetryConfig) -> None:
    d = _config_dir()
    d.mkdir(parents=True, exist_ok=True)
    _config_path().write_text(json.dumps(asdict(cfg), indent=2), encoding="utf-8")


def prompt_consent(assume_yes: bool = False, assume_no: bool = False) -> TelemetryConfig:
    existing = read_config()
    if existing is not None:
        return existing

    if assume_yes:
        enabled = True
    elif assume_no:
        enabled = False
    elif sys.stdin.isatty():
        sys.stdout.write(
            "Send anonymous usage counts to help prioritize Custos work? "
            "(only { install/command event, uuid, os, python version } — "
            "no paths, policies, or ledger data) [y/N] "
        )
        sys.stdout.flush()
        answer = sys.stdin.readline().strip().lower()
        enabled = answer in ("y", "yes")
    else:
        enabled = False

    cfg = TelemetryConfig(
        enabled=enabled,
        id=str(uuid.uuid4()) if enabled else "",
        consented_at=datetime.now(timezone.utc).isoformat(),
    )
    write_config(cfg)
    return cfg


def emit(event: str, cli_version: str) -> None:
    if os.environ.get("CUSTOS_TELEMETRY") == "off":
        return
    url = os.environ.get("CUSTOS_TELEMETRY_URL", "")
    if not url:
        return
    cfg = read_config()
    if cfg is None or not cfg.enabled or not cfg.id:
        return

    payload = json.dumps({
        "id": cfg.id,
        "event": event,
        "version": cli_version,
        "os": platform.system().lower(),
        "python": platform.python_version(),
    }).encode("utf-8")

    def send() -> None:
        try:
            req = urlrequest.Request(url, data=payload, headers={"content-type": "application/json"}, method="POST")
            urlrequest.urlopen(req, timeout=1.0).close()
        except Exception:
            pass

    threading.Thread(target=send, daemon=True).start()
