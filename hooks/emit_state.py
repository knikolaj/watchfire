#!/usr/bin/env python3
"""
Hook for Claude Code & Codex CLI: emit per-session state to
~/.claude/orchestrator/sessions/<session_id>.json

Reads hook payload from stdin, merges into existing state file, writes atomically.

Usage in hook config:
  command = "/path/emit_state.py --agent claude"   (default)
  command = "/path/emit_state.py --agent codex"

Status mapping (event -> status):
  SessionStart                        -> idle
  UserPromptSubmit                    -> working
  Notification | PermissionRequest    -> waiting_input
  Stop                                -> done
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

STATE_DIR = Path.home() / ".claude" / "orchestrator" / "sessions"

EVENT_TO_STATUS = {
    "SessionStart":      "idle",
    "UserPromptSubmit":  "working",
    "PreToolUse":        "working",         # tool starts after permission cleared
    "Notification":      "waiting_input",   # Claude
    "PermissionRequest": "waiting_input",   # Codex
    "Stop":              "done",
}

# High-frequency events where we skip transcript parsing entirely — they fire
# many times per session and only need to update the status/timestamp. The
# transcript hasn't materially changed since the last UserPromptSubmit/Stop.
LIGHT_EVENTS = {"PreToolUse", "PostToolUse"}

# Approximate context-window sizes by model id (used when transcript doesn't
# carry the limit itself, e.g. Claude). Codex transcripts include
# `model_context_window` directly so this fallback isn't consulted there.
MODEL_LIMITS = {
    # Claude 4.6+ moved to 1M context; older 4.x and Haiku stay at 200K.
    "claude-opus-4-7":   1_000_000,
    "claude-opus-4-6":   1_000_000,
    "claude-sonnet-4-6": 1_000_000,
    "claude-haiku-4-5":    200_000,
    "claude-opus-4":       200_000,  # 4.0 / 4.1 / 4.5
    "claude-sonnet-4":     200_000,  # 4.0 / 4.5
    # OpenAI / Codex (only used as a last-resort fallback)
    "gpt-5":               400_000,
}


def find_agent_pid() -> int:
    """Walk up the process tree from our parent until we hit the claude/codex
    CLI. The hook is spawned via `sh -c "/path/emit_state.py …"`, so
    `os.getppid()` returns the (very short-lived) shell. Recording that PID
    means the orchestrator's pid-liveness sweep deletes the session a few
    seconds later. We instead want the agent CLI's PID — Node sets
    PR_SET_NAME so /proc/<pid>/comm is literally "claude" or "codex"."""
    pid = os.getppid()
    for _ in range(8):
        try:
            with open(f"/proc/{pid}/comm") as f:
                comm = f.read().strip()
            if comm in ("claude", "codex"):
                return pid
            with open(f"/proc/{pid}/status") as f:
                ppid = 0
                for line in f:
                    if line.startswith("PPid:"):
                        ppid = int(line.split()[1])
                        break
            if ppid <= 1:
                return pid
            pid = ppid
        except (OSError, ValueError):
            return os.getppid()
    return os.getppid()


def model_limit(model: str) -> int:
    if not model:
        return 200_000
    # Longest-prefix match so claude-opus-4-7 wins over claude-opus-4.
    for key in sorted(MODEL_LIMITS, key=len, reverse=True):
        if model.startswith(key):
            return MODEL_LIMITS[key]
    return 200_000


def extract_claude_usage(transcript_path: str) -> tuple[int, int] | None:
    """Read claude transcript JSONL, return (tokens_used, limit) from last
    assistant message's `usage` block. None on any read/parse failure."""
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            data = f.read()
    except OSError:
        return None
    last_usage = None
    last_model = ""
    # Walk lines from the end backwards for speed on big transcripts.
    for line in reversed(data.splitlines()):
        if not line or line[0] != "{":
            continue
        if '"usage"' not in line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = obj.get("message") or {}
        usage = msg.get("usage") if isinstance(msg, dict) else None
        if not usage:
            continue
        last_usage = usage
        last_model = msg.get("model") or last_model
        break
    if not last_usage:
        return None
    # Context "fullness" = input portion of the last assistant turn (= what the
    # model just had in its window). Output is the response, not what was in
    # context at request time.
    used = (
        int(last_usage.get("input_tokens") or 0)
        + int(last_usage.get("cache_creation_input_tokens") or 0)
        + int(last_usage.get("cache_read_input_tokens") or 0)
    )
    return used, model_limit(last_model)


def extract_claude_meta(transcript_path: str) -> tuple[str | None, str | None]:
    """Read claude transcript JSONL once, return (custom_title, first_prompt).

    custom_title = latest `{"type":"custom-title","customTitle":"..."}` line
                   (Claude Code writes one per `/rename`).
    first_prompt = first user-message content (matches Claude UI's session label
                   when no custom title is set)."""
    custom_title = None
    first_prompt = None
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            for line in f:
                if not line or line[0] != "{":
                    continue
                # Cheap pre-filter to avoid parsing every line.
                if '"custom-title"' not in line and '"user"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") == "custom-title" and obj.get("customTitle"):
                    custom_title = obj["customTitle"]
                elif first_prompt is None and obj.get("type") == "user":
                    msg = obj.get("message") or {}
                    content = msg.get("content")
                    # Claude transcripts: content is sometimes a string, sometimes
                    # a list of blocks. Pull the first text we find.
                    if isinstance(content, str):
                        first_prompt = content
                    elif isinstance(content, list):
                        for blk in content:
                            if isinstance(blk, dict) and blk.get("type") == "text":
                                first_prompt = blk.get("text", "")
                                break
    except OSError:
        pass
    return custom_title, (first_prompt[:500] if first_prompt else None)


def extract_codex_first_prompt(transcript_path: str) -> str | None:
    """First user prompt from a codex transcript. Codex writes two flavors of
    user messages — `response_item` (which also carries the synthetic
    `<environment_context>` line on session start) and `event_msg` of
    `payload.type == "user_message"` (just the user's actual text). We scan
    for the latter so we don't mistake the env-context prelude for a prompt."""
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            for line in f:
                if not line or line[0] != "{":
                    continue
                if '"user_message"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                payload = obj.get("payload") or {}
                if payload.get("type") != "user_message":
                    continue
                msg = payload.get("message")
                if isinstance(msg, str) and msg.strip():
                    return msg.strip()[:500]
    except OSError:
        pass
    return None


def extract_codex_usage(transcript_path: str) -> tuple[int, int] | None:
    """Read codex transcript JSONL, return (tokens_used, limit) from the most
    recent `token_count` event_msg. None on any failure."""
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            data = f.read()
    except OSError:
        return None
    for line in reversed(data.splitlines()):
        if not line or line[0] != "{":
            continue
        if '"token_count"' not in line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        info = (((obj.get("payload") or {}).get("info")) or {})
        # last_token_usage is per-turn (current context fullness).
        # total_token_usage is cumulative across the whole session — wrong metric.
        last = info.get("last_token_usage") or {}
        used = last.get("input_tokens")
        limit = info.get("model_context_window")
        if used is None or limit is None:
            continue
        return int(used), int(limit)
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", default="claude", choices=["claude", "codex"])
    args = parser.parse_args()

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        raw = ""
        payload = {}

    # Debug log — skip high-frequency events to keep the log readable.
    if payload.get("hook_event_name") not in LIGHT_EVENTS:
        try:
            log = Path.home() / ".claude" / "orchestrator" / "hook.log"
            log.parent.mkdir(parents=True, exist_ok=True)
            with log.open("a") as f:
                f.write(f"[{time.strftime('%H:%M:%S')}] agent={args.agent} bytes={len(raw)} keys={sorted(payload.keys())}\n")
        except Exception:
            pass

    session_id = payload.get("session_id") or "unknown"
    event = payload.get("hook_event_name") or "Unknown"
    cwd = payload.get("cwd") or os.getcwd()

    # Skip cron-driven non-interactive `claude -p` runs. Each such script
    # cd's into its own sandbox dir before invoking claude, so the cwd
    # alone is enough to identify these and keep them out of the widget:
    #   ~/.claude-daily-summary/    — daily-summary.py
    #   ~/.claude-meeting-summaries/ — fireflies-sync.py
    if ".claude-daily-summary" in cwd or ".claude-meeting-summaries" in cwd:
        return 0
    # Normalize: codex lowercases /mnt/c/Users -> /mnt/c/users; rejoin under one district.
    # Lowercase only the WSL drive prefix, not the whole path (case-sensitive elsewhere).
    if cwd.startswith("/mnt/"):
        parts = cwd.split("/")
        # parts = ['', 'mnt', 'c', 'Users', '23738']  -> lowercase parts[2] AND parts[3]
        if len(parts) >= 4:
            parts[2] = parts[2].lower()
            parts[3] = parts[3].lower()
            cwd = "/".join(parts)
    transcript_path = payload.get("transcript_path", "")

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    state_file = STATE_DIR / f"{session_id}.json"

    # Load existing state (if any) so we keep history of last_message etc.
    state: dict = {}
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text())
        except json.JSONDecodeError:
            state = {}

    # Status mapping. Special case: a "Notification" event whose message is
    # the idle "is waiting for your input" reminder is NOT a real permission
    # prompt — Claude has already finished and is just nudging the user.
    # We treat it as `done` (preserve the prior Stop-event status), otherwise
    # any finished session looks like it's blocked on permission.
    new_status = EVENT_TO_STATUS.get(event, state.get("status", "idle"))
    if event == "Notification":
        msg = (payload.get("message") or "").lower()
        if "waiting for your input" in msg:
            new_status = "done"

    state["session_id"] = session_id
    state["agent"] = args.agent
    state["cwd"] = cwd
    state["status"] = new_status
    state["last_event"] = event
    state["last_event_at"] = time.time()
    state.setdefault("started_at", time.time())
    # Record the PID of the agent CLI itself (NOT os.getppid() — that
    # returns the sh-wrapper, which dies immediately). The orchestrator
    # server uses this to garbage-collect state for sessions whose terminal
    # was closed without firing Stop.
    state["pid"] = find_agent_pid()
    if transcript_path:
        state["transcript_path"] = transcript_path
    if payload.get("model"):
        state["model"] = payload["model"]

    if event == "Notification":
        state["last_message"] = payload.get("message", "")
    if event == "PermissionRequest":
        # Codex: build a short message from tool_name / tool_input if present
        tool = payload.get("tool_name") or "permission"
        state["last_message"] = f"approval: {tool}"
    if event == "UserPromptSubmit":
        prompt = payload.get("prompt", "")
        # Keep short — full transcript is on disk anyway
        state["last_prompt"] = prompt[:500]

    # Context usage + title/first-prompt parsing — skipped for LIGHT_EVENTS
    # (PreToolUse/PostToolUse can fire 100+ times per turn during sub-agent
    # runs; the transcript content barely changes between them, so re-parsing
    # is wasted work).
    if transcript_path and event not in LIGHT_EVENTS:
        usage = (
            extract_codex_usage(transcript_path) if args.agent == "codex"
            else extract_claude_usage(transcript_path)
        )
        if usage:
            state["context_tokens"], state["context_limit"] = usage

        if args.agent == "claude":
            title, first = extract_claude_meta(transcript_path)
            if title:
                state["name"] = title
            if first and not state.get("first_prompt"):
                state["first_prompt"] = first
        elif args.agent == "codex" and not state.get("first_prompt"):
            # Codex has no /rename equivalent, so we only fill first_prompt;
            # the widget uses it as the display name when `name` is absent.
            first = extract_codex_first_prompt(transcript_path)
            if first:
                state["first_prompt"] = first

    # Push session name to the terminal title via OSC 0/2. Claude's `/rename`
    # only updates the transcript's `custom-title`; it doesn't emit an OSC
    # escape, so Windows Terminal tabs keep showing the bash default
    # ("user@host: cwd") and multiple sessions in the same cwd are
    # indistinguishable. Writing here gives each tab a unique title that the
    # orchestrator's focus_window.ps1 can match. Skipped for LIGHT_EVENTS
    # because /dev/tty writes show up as visible noise in some terminals if
    # done dozens of times per turn.
    if event not in LIGHT_EVENTS:
        title = (
            state.get("name")
            or (state.get("first_prompt") or "")[:30]
            or session_id[:8]
        )
        if title:
            try:
                with open("/dev/tty", "w") as tty:
                    tty.write(f"\033]0;{title}\007")
            except OSError:
                pass  # no controlling tty (cron/headless invocation)

    # Atomic write
    tmp = state_file.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    tmp.replace(state_file)

    return 0


if __name__ == "__main__":
    sys.exit(main())
