#!/usr/bin/env python3
"""
Hook for Claude Code & Codex CLI: emit per-session state to
~/.watchfire/sessions/<session_id>.json

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
import re
import sys
import time
from pathlib import Path

STATE_DIR = Path.home() / ".watchfire" / "sessions"

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
    # Claude 4.6+ and the Claude 5 family are 1M context; older 4.x and Haiku
    # stay at 200K.
    "claude-fable-5":    1_000_000,
    "claude-opus-5":     1_000_000,
    "claude-sonnet-5":   1_000_000,
    "claude-opus-4-8":   1_000_000,
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
    means watchfire's pid-liveness sweep deletes the session a few
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


def agent_tty(pid) -> str | None:
    """Resolve the terminal device the agent CLI (pid) is attached to.

    The hook runs without a controlling terminal, so /dev/tty is unusable
    (ENXIO). The agent CLI, however, still has the terminal on its stdio, so
    follow one of its fds to the pts and return that path. Only real terminal
    devices are accepted — a redirected fd (log file, pipe) is skipped so we
    never spray OSC escapes into a file. None if nothing usable is found.
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    for fd in (0, 1, 2):
        try:
            dev = os.readlink(f"/proc/{pid}/fd/{fd}")
        except OSError:
            continue
        if dev.startswith("/dev/pts/") or (dev.startswith("/dev/tty") and dev != "/dev/tty"):
            return dev
    return None


def model_limit(model: str) -> int:
    if not model:
        return 200_000
    # Longest-prefix match so claude-opus-4-7 wins over claude-opus-4.
    for key in sorted(MODEL_LIMITS, key=len, reverse=True):
        if model.startswith(key):
            return MODEL_LIMITS[key]
    return 200_000


def model_label(model: str) -> str:
    """Short human label for a model id, for terminal tab titles:
    claude-opus-4-8 -> "Opus 4.8", claude-fable-5 -> "Fable 5",
    gpt-5.5(-codex) -> "GPT-5.5". Empty for no model; unknown -> as-is."""
    if not model:
        return ""
    m = re.match(r"^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?", model)
    if m:
        fam = m.group(1).capitalize()
        ver = f"{m.group(2)}.{m.group(3)}" if m.group(3) else m.group(2)
        return f"{fam} {ver}"
    m = re.match(r"^gpt-([0-9.]+)", model, re.IGNORECASE)
    if m:
        return f"GPT-{m.group(1)}"
    return model


def terminal_title(base: str, model: str, status: str) -> str:
    """Compose the OSC terminal-tab title.

    Base name, then the model in parens ("Health (Opus 4.8)"), then — only
    while `working` — a leading yellow dot ("🟡 Health (Opus 4.8)"). Every
    other status means the session wants your attention, so we leave those
    clean: the *absence* of the dot is itself the "your turn" signal.
    """
    title = base or ""
    label = model_label(model or "")
    if title and label:
        title = f"{title} ({label})"
    if title and status == "working":
        title = f"🟡 {title}"
    return title


def extract_claude_model(transcript_path: str) -> str | None:
    """Latest assistant `message.model` from a claude transcript.

    Claude Code does not *reliably* put `model` in the hook payload — some
    sessions never carry it — so the transcript is the authoritative source
    (every assistant message records the model it ran on). Walk from the end
    and take the first one. None on any read/parse failure.
    """
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            data = f.read()
    except OSError:
        return None
    for line in reversed(data.splitlines()):
        if not line or line[0] != "{" or '"model"' not in line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = obj.get("message") or {}
        model = msg.get("model") if isinstance(msg, dict) else None
        if model:
            return model
    return None


def extract_codex_model(transcript_path: str) -> str | None:
    """Latest `turn_context.model` from a codex transcript (Codex records the
    model there, one per turn). None on any read/parse failure."""
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            data = f.read()
    except OSError:
        return None
    model = None
    for line in data.splitlines():
        if not line or line[0] != "{":
            continue
        if '"turn_context"' not in line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "turn_context":
            m = (obj.get("payload") or {}).get("model")
            if isinstance(m, str) and m:
                model = m  # later occurrences overwrite — latest wins
    return model


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


def extract_codex_thread_name(transcript_path: str) -> str | None:
    """Latest `thread_name_updated` event from a codex transcript — Codex's
    equivalent of Claude's `/rename` customTitle. The user explicitly named
    the session, so this should win over first_prompt fallback in the
    widget."""
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            data = f.read()
    except OSError:
        return None
    name = None
    for line in data.splitlines():
        if not line or line[0] != "{":
            continue
        if '"thread_name_updated"' not in line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        payload = obj.get("payload") or {}
        if payload.get("type") != "thread_name_updated":
            continue
        n = payload.get("thread_name")
        if isinstance(n, str) and n.strip():
            name = n.strip()  # later occurrences overwrite — latest wins
    return name


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
            log = Path.home() / ".watchfire" / "hook.log"
            log.parent.mkdir(parents=True, exist_ok=True)
            with log.open("a") as f:
                f.write(f"[{time.strftime('%H:%M:%S')}] agent={args.agent} bytes={len(raw)} keys={sorted(payload.keys())}\n")
        except Exception:
            pass

    session_id = payload.get("session_id")
    event = payload.get("hook_event_name") or "Unknown"
    cwd = payload.get("cwd") or os.getcwd()
    # Drop hooks that arrive without a session_id — they have no identity
    # to attach to and used to land as a single "unknown.json" orphan that
    # got overwritten by every subsequent malformed event.
    if not session_id:
        return 0

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
    # returns the sh-wrapper, which dies immediately). The watchfire server
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
            # Authoritative model from the transcript (the hook payload's
            # `model` is unreliable — some sessions never carry it, which left
            # them with no model for the tab label and limit calc).
            cmodel = extract_claude_model(transcript_path)
            if cmodel:
                state["model"] = cmodel
            title, first = extract_claude_meta(transcript_path)
            if title:
                state["name"] = title
            if first and not state.get("first_prompt"):
                state["first_prompt"] = first
        elif args.agent == "codex":
            # Codex names sessions via /rename (`thread_name_updated` event).
            # Refresh on every non-light event so renames propagate quickly.
            tname = extract_codex_thread_name(transcript_path)
            if tname:
                state["name"] = tname
            # Like Claude above, pull the model from the transcript (Codex
            # records it in turn_context, one per turn) for the tab label.
            cmodel = extract_codex_model(transcript_path)
            if cmodel:
                state["model"] = cmodel
            if not state.get("first_prompt"):
                first = extract_codex_first_prompt(transcript_path)
                if first:
                    state["first_prompt"] = first

    # Push session name to the terminal title via OSC 0/2. Claude's `/rename`
    # only updates the transcript's `custom-title`; it doesn't emit an OSC
    # escape, so Windows Terminal tabs keep showing the bash default
    # ("user@host: cwd") and multiple sessions in the same cwd are
    # indistinguishable. Writing here gives each tab a unique title that the
    # watchfire's focus_window.ps1 can match.
    #
    # Recomputed on EVERY event — including LIGHT_EVENTS — because the 🟡
    # working dot tracks `status`, which flips to "working" on a PreToolUse
    # (a light event). If we only wrote on non-light events, a mid-turn
    # Notification would strip the dot and the next PreToolUse wouldn't put it
    # back. We still touch /dev/tty only when the title actually changes
    # (tracked in `_tab_title`), so it's a handful of writes per turn — not the
    # dozens (visible as noise in some terminals) the LIGHT_EVENTS skip
    # originally guarded against.
    base = (
        state.get("name")
        or (state.get("first_prompt") or "")[:30]
        or session_id[:8]
    )
    # e.g. "Fable Health (Opus 4.8)", prefixed with 🟡 while working.
    title = terminal_title(base, state.get("model") or "", state.get("status") or "")
    if title and title != state.get("_tab_title"):
        # NB: NOT /dev/tty. The hook is spawned without a controlling terminal,
        # so opening /dev/tty fails with ENXIO and the OSC escape never reaches
        # the tab. Write to the agent CLI's own terminal device instead (found
        # by following its stdio in /proc). Falls back to /dev/tty for the rare
        # case where we're already interactive (e.g. manual testing).
        tty_path = agent_tty(state.get("pid")) or "/dev/tty"
        try:
            with open(tty_path, "w") as tty:
                tty.write(f"\033]0;{title}\007")
            state["_tab_title"] = title
        except OSError:
            pass  # terminal already gone, or a headless invocation

    # Atomic write
    tmp = state_file.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    tmp.replace(state_file)

    return 0


if __name__ == "__main__":
    sys.exit(main())
