import importlib
import re
from pathlib import Path
from unittest import mock

import pytest


@pytest.fixture
def fake_home(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    # Force Path.home() to see the new HOME on Windows too.
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    import custos.telemetry as tel
    importlib.reload(tel)
    yield tel


def test_assume_no_writes_disabled(fake_home):
    cfg = fake_home.prompt_consent(assume_no=True)
    assert cfg.enabled is False
    assert cfg.id == ""
    assert fake_home.read_config().enabled is False


def test_assume_yes_writes_enabled_with_uuid(fake_home):
    cfg = fake_home.prompt_consent(assume_yes=True)
    assert cfg.enabled is True
    assert re.match(r"^[0-9a-f-]{36}$", cfg.id)


def test_second_prompt_returns_existing(fake_home):
    a = fake_home.prompt_consent(assume_yes=True)
    b = fake_home.prompt_consent(assume_no=True)  # should NOT overwrite
    assert b.id == a.id
    assert b.enabled is True


def test_emit_noop_when_url_unset(fake_home, monkeypatch):
    monkeypatch.delenv("CUSTOS_TELEMETRY_URL", raising=False)
    fake_home.prompt_consent(assume_yes=True)
    with mock.patch("urllib.request.urlopen") as m:
        fake_home.emit("test", "0.0.0")
        m.assert_not_called()


def test_emit_noop_when_disabled(fake_home, monkeypatch):
    monkeypatch.setenv("CUSTOS_TELEMETRY_URL", "https://example.invalid/e")
    fake_home.prompt_consent(assume_no=True)
    with mock.patch("urllib.request.urlopen") as m:
        fake_home.emit("test", "0.0.0")
        m.assert_not_called()


def test_emit_noop_when_env_off(fake_home, monkeypatch):
    monkeypatch.setenv("CUSTOS_TELEMETRY_URL", "https://example.invalid/e")
    monkeypatch.setenv("CUSTOS_TELEMETRY", "off")
    fake_home.prompt_consent(assume_yes=True)
    with mock.patch("urllib.request.urlopen") as m:
        fake_home.emit("test", "0.0.0")
        m.assert_not_called()
