"""Filter-style behaviors in emit_state.py.

UC-3.3 — cron-driven runs sandboxed under ~/.claude-daily-summary or
~/.claude-meeting-summaries must produce no widget state at all.
UC hygiene — events arriving without a session_id used to land as a
shared `unknown.json` orphan; now they're dropped.

Plus model_limit longest-prefix matching: Claude 4.6/4.7 are 1M, older
4.x are 200K, etc. Regression-prone every time a new model ships.
"""
from __future__ import annotations


def test_daily_summary_cwd_writes_nothing(run_hook, state_dir):
    out = run_hook({
        "session_id": "s1",
        "hook_event_name": "UserPromptSubmit",
        "cwd": "/home/nj/.claude-daily-summary/2026-05",
        "prompt": "summarize",
    })
    assert out is None
    assert not state_dir.exists() or list(state_dir.glob("*.json")) == []


def test_meeting_summary_cwd_writes_nothing(run_hook, state_dir):
    out = run_hook({
        "session_id": "s1",
        "hook_event_name": "UserPromptSubmit",
        "cwd": "/home/nj/.claude-meeting-summaries/2026-05",
        "prompt": "summarize",
    })
    assert out is None
    assert not state_dir.exists() or list(state_dir.glob("*.json")) == []


def test_missing_session_id_writes_nothing(run_hook, state_dir):
    out = run_hook({
        "hook_event_name": "UserPromptSubmit",
        "cwd": "/x",
        "prompt": "anything",
    })
    assert out is None
    assert not state_dir.exists() or list(state_dir.glob("*.json")) == []


def test_wsl_drive_cwd_is_lowercased(run_hook):
    s = run_hook({
        "session_id": "s1",
        "hook_event_name": "SessionStart",
        "cwd": "/mnt/c/Users/23738",
    })
    assert s["cwd"] == "/mnt/c/users/23738"


def test_wsl_non_drive_cwd_is_left_alone(run_hook):
    s = run_hook({
        "session_id": "s1",
        "hook_event_name": "SessionStart",
        "cwd": "/home/nj/projects/Palisade/Self-Replication",
    })
    assert s["cwd"] == "/home/nj/projects/Palisade/Self-Replication"


# --- model_limit ----------------------------------------------------------

def test_model_limit_known_models():
    import emit_state
    assert emit_state.model_limit("claude-fable-5") == 1_000_000
    assert emit_state.model_limit("claude-opus-5") == 1_000_000
    assert emit_state.model_limit("claude-sonnet-5") == 1_000_000
    assert emit_state.model_limit("claude-opus-4-8") == 1_000_000
    assert emit_state.model_limit("claude-opus-4-7") == 1_000_000
    assert emit_state.model_limit("claude-opus-4-7[1m]") == 1_000_000  # suffix tolerated
    assert emit_state.model_limit("claude-opus-4-6") == 1_000_000
    assert emit_state.model_limit("claude-sonnet-4-6") == 1_000_000
    assert emit_state.model_limit("claude-haiku-4-5") == 200_000
    # Older 4.x must NOT be matched by 4-7 prefix — longest-prefix wins.
    assert emit_state.model_limit("claude-opus-4-1") == 200_000
    assert emit_state.model_limit("claude-sonnet-4-5") == 200_000
    # Sonnet 5 must NOT be captured by the claude-sonnet-4 prefix (would wrongly
    # give 200K); the 1M sonnet-5 entry wins on exact prefix.
    assert emit_state.model_limit("claude-sonnet-5") == 1_000_000
    # Opus 5 must NOT be captured by the claude-opus-4 prefix — this was the
    # widget's "146% [200K]" bug before claude-opus-5 was added.
    assert emit_state.model_limit("claude-opus-5") == 1_000_000
    assert emit_state.model_limit("gpt-5") == 400_000


def test_model_limit_unknown_falls_back_to_200k():
    import emit_state
    assert emit_state.model_limit("") == 200_000
    assert emit_state.model_limit("totally-unknown") == 200_000


def test_model_label():
    import emit_state
    assert emit_state.model_label("claude-opus-5") == "Opus 5"
    assert emit_state.model_label("claude-opus-4-8") == "Opus 4.8"
    assert emit_state.model_label("claude-sonnet-4-6") == "Sonnet 4.6"
    assert emit_state.model_label("claude-fable-5") == "Fable 5"
    assert emit_state.model_label("claude-haiku-4-5") == "Haiku 4.5"
    assert emit_state.model_label("gpt-5.5") == "GPT-5.5"
    assert emit_state.model_label("gpt-5.5-codex") == "GPT-5.5"
    assert emit_state.model_label("") == ""
    assert emit_state.model_label("some-future-model") == "some-future-model"


def test_agent_tty_picks_pts(monkeypatch):
    import os, emit_state
    monkeypatch.setattr(os, "readlink", lambda p: "/dev/pts/5")
    assert emit_state.agent_tty(123) == "/dev/pts/5"


def test_agent_tty_rejects_non_tty(monkeypatch):
    """A redirected fd (log file / pipe) must be skipped — we never spray OSC
    escapes into a file. /dev/tty itself is rejected too (we want the concrete
    pts, and opening /dev/tty from the hook fails with ENXIO anyway)."""
    import os, emit_state
    monkeypatch.setattr(os, "readlink", lambda p: "/home/nj/session.log")
    assert emit_state.agent_tty(123) is None
    monkeypatch.setattr(os, "readlink", lambda p: "/dev/tty")
    assert emit_state.agent_tty(123) is None


def test_agent_tty_bad_pid():
    import emit_state
    assert emit_state.agent_tty(None) is None
    assert emit_state.agent_tty("not-an-int") is None
    # A pid with no /proc entry resolves to nothing, not a crash.
    assert emit_state.agent_tty(2_147_483_646) is None


def test_terminal_title():
    import emit_state
    # A yellow dot marks working; every other status stays clean.
    assert emit_state.terminal_title("Health", "claude-opus-4-8", "working") == "🟡 Health (Opus 4.8)"
    assert emit_state.terminal_title("Health", "claude-opus-4-8", "idle") == "Health (Opus 4.8)"
    assert emit_state.terminal_title("Health", "claude-opus-4-8", "done") == "Health (Opus 4.8)"
    assert emit_state.terminal_title("Health", "claude-opus-4-8", "waiting_input") == "Health (Opus 4.8)"
    # No model -> no parens; dot still applies while working.
    assert emit_state.terminal_title("Health", "", "working") == "🟡 Health"
    assert emit_state.terminal_title("Health", "", "idle") == "Health"
    # Empty base -> empty title (nothing to write), regardless of status.
    assert emit_state.terminal_title("", "claude-opus-4-8", "working") == ""
