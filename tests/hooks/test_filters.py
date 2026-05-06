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
    assert emit_state.model_limit("claude-opus-4-7") == 1_000_000
    assert emit_state.model_limit("claude-opus-4-7[1m]") == 1_000_000  # suffix tolerated
    assert emit_state.model_limit("claude-opus-4-6") == 1_000_000
    assert emit_state.model_limit("claude-sonnet-4-6") == 1_000_000
    assert emit_state.model_limit("claude-haiku-4-5") == 200_000
    # Older 4.x must NOT be matched by 4-7 prefix — longest-prefix wins.
    assert emit_state.model_limit("claude-opus-4-1") == 200_000
    assert emit_state.model_limit("claude-sonnet-4-5") == 200_000
    assert emit_state.model_limit("gpt-5") == 400_000


def test_model_limit_unknown_falls_back_to_200k():
    import emit_state
    assert emit_state.model_limit("") == 200_000
    assert emit_state.model_limit("totally-unknown") == 200_000
