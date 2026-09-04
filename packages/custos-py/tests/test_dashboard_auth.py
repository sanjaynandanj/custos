"""Tests for opt-in bearer-token auth on the FastAPI dashboard."""
from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from custos.dashboard import create_app  # noqa: E402


def _empty_ledger(tmp_path):
    p = tmp_path / "ledger.jsonl"
    p.write_text("", encoding="utf-8")
    return p


def test_no_token_configured_allows_api(tmp_path):
    """Backwards compat: when no token is set, /api/* is open (no header)."""
    app = create_app(_empty_ledger(tmp_path))
    with TestClient(app) as c:
        r = c.get("/api/stats")
        assert r.status_code == 200
        assert r.json()["total"] == 0


def test_token_required_rejects_missing_header(tmp_path):
    app = create_app(_empty_ledger(tmp_path), token="s3cret")
    with TestClient(app) as c:
        r = c.get("/api/stats")
        assert r.status_code == 401


def test_token_required_rejects_wrong_header(tmp_path):
    app = create_app(_empty_ledger(tmp_path), token="s3cret")
    with TestClient(app) as c:
        r = c.get("/api/stats", headers={"Authorization": "Bearer nope"})
        assert r.status_code == 401


def test_token_required_accepts_correct_header(tmp_path):
    app = create_app(_empty_ledger(tmp_path), token="s3cret")
    with TestClient(app) as c:
        r = c.get("/api/stats", headers={"Authorization": "Bearer s3cret"})
        assert r.status_code == 200


def test_html_index_never_requires_auth(tmp_path):
    """Only /api/* is gated; the HTML shell stays open so browsers can load it."""
    app = create_app(_empty_ledger(tmp_path), token="s3cret")
    with TestClient(app) as c:
        r = c.get("/")
        assert r.status_code == 200
        assert "custos" in r.text.lower()


def test_env_var_configures_token(tmp_path, monkeypatch):
    monkeypatch.setenv("CUSTOS_DASHBOARD_TOKEN", "envtok")
    app = create_app(_empty_ledger(tmp_path))
    with TestClient(app) as c:
        assert c.get("/api/stats").status_code == 401
        assert c.get("/api/stats", headers={"Authorization": "Bearer envtok"}).status_code == 200
