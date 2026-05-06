"""Pytest config for hook tests.

Adds the project's `hooks/` dir to sys.path so tests can `import emit_state`
without an installable package layout. Also gives every test an isolated
HOME (so the hook's hook.log / state writes can't escape into the user's
real ~/.watchfire).
"""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

PROJ_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJ_ROOT / "hooks"))


@pytest.fixture
def isolated_home(monkeypatch, tmp_path):
    """Redirect $HOME (and thus Path.home()) to a tmp dir for the duration
    of the test. The hook's hook.log path uses Path.home() and we don't
    want to spam the real ~/.watchfire/hook.log."""
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


@pytest.fixture
def state_dir(monkeypatch, tmp_path):
    """Override emit_state.STATE_DIR to a tmp dir. STATE_DIR is captured at
    import time from Path.home(), so HOME-redirection alone isn't enough."""
    import emit_state
    d = tmp_path / "sessions"
    monkeypatch.setattr(emit_state, "STATE_DIR", d)
    return d


@pytest.fixture
def run_hook(monkeypatch, isolated_home, state_dir):
    """Simulate Claude Code invoking the hook with a JSON payload on stdin.
    Returns the parsed state-file dict (or None if the hook wrote nothing).
    """
    import emit_state

    def _invoke(payload: dict, agent: str = "claude") -> dict | None:
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
        monkeypatch.setattr("sys.argv", ["emit_state.py", "--agent", agent])
        rc = emit_state.main()
        assert rc == 0, f"hook returned non-zero: {rc}"
        sid = payload.get("session_id")
        if not sid:
            return None
        path = state_dir / f"{sid}.json"
        if not path.exists():
            return None
        return json.loads(path.read_text())

    return _invoke
