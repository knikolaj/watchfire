"""UC-1.5 — status mapping in emit_state.py.

Each Claude/Codex hook event maps to a session status the widget renders
with a colored dot. The mapping has two non-obvious edges:
  • A `Notification` event whose message is the idle reminder
    "Claude is waiting for your input" must NOT bump status to
    waiting_input — that would steal a real `done` and make finished
    sessions look blocked.
  • Codex's PermissionRequest is the moral equivalent of Claude's
    permission Notification.
"""
from __future__ import annotations


def test_session_start_yields_idle(run_hook):
    s = run_hook({"session_id": "s1", "hook_event_name": "SessionStart", "cwd": "/x"})
    assert s["status"] == "idle"
    assert s["last_event"] == "SessionStart"


def test_user_prompt_submit_yields_working(run_hook):
    s = run_hook({
        "session_id": "s1",
        "hook_event_name": "UserPromptSubmit",
        "cwd": "/x",
        "prompt": "hello world",
    })
    assert s["status"] == "working"
    assert s["last_prompt"] == "hello world"


def test_pre_tool_use_yields_working(run_hook):
    """PreToolUse fires after permission is granted — must clear stuck
    waiting_input so sub-agents don't look perpetually blocked."""
    s = run_hook({"session_id": "s1", "hook_event_name": "PreToolUse", "cwd": "/x"})
    assert s["status"] == "working"


def test_notification_permission_yields_waiting(run_hook):
    s = run_hook({
        "session_id": "s1",
        "hook_event_name": "Notification",
        "cwd": "/x",
        "message": "Claude needs your permission to use Bash",
    })
    assert s["status"] == "waiting_input"
    assert "permission" in s["last_message"].lower()


def test_notification_idle_reminder_yields_done(run_hook):
    """The string 'is waiting for your input' is the post-Stop idle
    reminder, NOT a real permission prompt. Must collapse to done."""
    s = run_hook({
        "session_id": "s1",
        "hook_event_name": "Notification",
        "cwd": "/x",
        "message": "Claude is waiting for your input",
    })
    assert s["status"] == "done"


def test_stop_yields_done(run_hook):
    s = run_hook({"session_id": "s1", "hook_event_name": "Stop", "cwd": "/x"})
    assert s["status"] == "done"


def test_codex_permission_request_yields_waiting(run_hook):
    s = run_hook(
        {
            "session_id": "s1",
            "hook_event_name": "PermissionRequest",
            "cwd": "/x",
            "tool_name": "shell",
        },
        agent="codex",
    )
    assert s["status"] == "waiting_input"
    assert s["last_message"].startswith("approval:")
