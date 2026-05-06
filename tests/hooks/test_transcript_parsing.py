"""Transcript-extraction tests.

UC-1.2 (context %) — extract_claude_usage / extract_codex_usage read
the latest token counters out of the transcript JSONL.
UC-1.4 / UC-3.8 — extract_claude_meta picks up `customTitle` set by
`/rename` and the very first user prompt; the codex equivalent walks
event_msg/user_message lines, skipping the synthetic
<environment_context> response_item that Codex always writes first.

Plus the LIGHT_EVENTS guard: PreToolUse fires up to 100× per turn, and
re-parsing the transcript on each is the largest source of overhead we
fixed in the loop. Test the side effect: it must NOT update
context_tokens / first_prompt on PreToolUse.
"""
from __future__ import annotations

import json
import textwrap


# --- Claude transcript fixtures -------------------------------------------

def _claude_transcript(*lines: str) -> str:
    return "\n".join(lines) + "\n"


CLAUDE_TWO_PROMPTS = _claude_transcript(
    json.dumps({"type": "user", "message": {"content": "first user prompt"}}),
    json.dumps({"type": "assistant", "message": {
        "model": "claude-opus-4-7",
        "usage": {"input_tokens": 100, "cache_creation_input_tokens": 50,
                  "cache_read_input_tokens": 1000, "output_tokens": 200},
    }}),
    json.dumps({"type": "user", "message": {"content": "second prompt"}}),
    json.dumps({"type": "custom-title", "customTitle": "Renamed by /rename"}),
    json.dumps({"type": "assistant", "message": {
        "model": "claude-opus-4-7",
        "usage": {"input_tokens": 200, "cache_creation_input_tokens": 100,
                  "cache_read_input_tokens": 5000, "output_tokens": 300},
    }}),
)


def test_extract_claude_usage_uses_last_assistant_turn(tmp_path):
    """`usage` from the LAST assistant message is the current context
    fullness. Earlier turns must be ignored (their input may have been
    smaller before history accumulated)."""
    import emit_state
    fp = tmp_path / "t.jsonl"
    fp.write_text(CLAUDE_TWO_PROMPTS)
    used, limit = emit_state.extract_claude_usage(str(fp))
    assert used == 200 + 100 + 5000   # last assistant input + cache_creation + cache_read
    assert limit == 1_000_000          # claude-opus-4-7 → 1M


def test_extract_claude_meta_returns_custom_title_and_first_prompt(tmp_path):
    import emit_state
    fp = tmp_path / "t.jsonl"
    fp.write_text(CLAUDE_TWO_PROMPTS)
    title, first = emit_state.extract_claude_meta(str(fp))
    assert title == "Renamed by /rename"
    assert first == "first user prompt"


def test_extract_claude_meta_handles_block_array_content(tmp_path):
    """Claude transcripts sometimes give `content` as a list of blocks
    rather than a flat string. Must still pull the text out of the first
    text block."""
    import emit_state
    fp = tmp_path / "t.jsonl"
    fp.write_text(_claude_transcript(json.dumps({
        "type": "user",
        "message": {"content": [
            {"type": "image_ref", "ref": "img1"},
            {"type": "text", "text": "the actual prompt"},
        ]},
    })))
    _, first = emit_state.extract_claude_meta(str(fp))
    assert first == "the actual prompt"


def test_extract_claude_meta_no_match_returns_blanks(tmp_path):
    import emit_state
    fp = tmp_path / "t.jsonl"
    fp.write_text("# not even json\n")
    title, first = emit_state.extract_claude_meta(str(fp))
    assert title is None and first is None


# --- Codex transcript fixtures -------------------------------------------

CODEX_TRANSCRIPT = "\n".join([
    json.dumps({"type": "session_meta", "payload": {
        "id": "019d-...", "cwd": "/home/nj/proj"}}),
    # The first user 'message' is the synthetic environment_context — must
    # NOT be picked as first_prompt.
    json.dumps({"type": "response_item", "payload": {
        "type": "message", "role": "user",
        "content": [{"type": "input_text",
                     "text": "<environment_context><cwd>/home/nj/proj</cwd></environment_context>"}],
    }}),
    json.dumps({"type": "event_msg", "payload": {
        "type": "user_message", "message": "real first prompt"}}),
    json.dumps({"type": "event_msg", "payload": {
        "type": "user_message", "message": "second prompt"}}),
    json.dumps({"type": "event_msg", "payload": {
        "type": "token_count",
        "info": {"last_token_usage": {"input_tokens": 12345},
                 "model_context_window": 258400}}}),
]) + "\n"


def test_extract_codex_first_prompt_skips_environment_context(tmp_path):
    import emit_state
    fp = tmp_path / "t.jsonl"
    fp.write_text(CODEX_TRANSCRIPT)
    assert emit_state.extract_codex_first_prompt(str(fp)) == "real first prompt"


def test_extract_codex_usage_pulls_last_token_usage(tmp_path):
    import emit_state
    fp = tmp_path / "t.jsonl"
    fp.write_text(CODEX_TRANSCRIPT)
    used, limit = emit_state.extract_codex_usage(str(fp))
    assert used == 12345
    assert limit == 258400


# --- LIGHT_EVENTS guard ---------------------------------------------------

def test_pre_tool_use_does_not_re_parse_transcript(run_hook, tmp_path):
    """PreToolUse with a transcript_path should NOT re-extract context_tokens
    or first_prompt. Transcript content barely changes between PreToolUse
    invocations and re-parsing 100× per turn was the biggest hot spot."""
    fp = tmp_path / "t.jsonl"
    fp.write_text(CLAUDE_TWO_PROMPTS)
    s = run_hook({
        "session_id": "s1",
        "hook_event_name": "PreToolUse",
        "cwd": "/x",
        "transcript_path": str(fp),
    })
    assert s["status"] == "working"
    # Heavy fields must be absent — they're populated only on non-LIGHT events.
    assert "context_tokens" not in s
    assert "first_prompt" not in s


def test_user_prompt_submit_does_re_parse_transcript(run_hook, tmp_path):
    fp = tmp_path / "t.jsonl"
    fp.write_text(CLAUDE_TWO_PROMPTS)
    s = run_hook({
        "session_id": "s1",
        "hook_event_name": "UserPromptSubmit",
        "cwd": "/x",
        "prompt": "p",
        "transcript_path": str(fp),
    })
    assert s["context_tokens"] == 200 + 100 + 5000
    assert s["context_limit"] == 1_000_000
    assert s["name"] == "Renamed by /rename"
    assert s["first_prompt"] == "first user prompt"
