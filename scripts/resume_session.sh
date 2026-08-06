#!/usr/bin/env bash
# Re-open a past Claude/Codex session so you can pick the conversation back up.
#
# Launched by watchfire's /resume endpoint inside a fresh Windows Terminal tab:
#   wt.exe nt wsl.exe -e bash -lic 'exec "$0" "$@"' resume_session.sh <agent> <cwd> <id>
#
# cwd and name arrive base64-encoded (wt drops quoting around sub-command args,
# which would split a value containing spaces); decode them here. agent and id
# have no spaces so they pass through as-is. We run under `bash -lic` so
# nvm-installed claude/codex are on PATH.
agent=$1
cwd=$(printf '%s' "$2" | base64 -d 2>/dev/null)
id=$3
name=$(printf '%s' "$4" | base64 -d 2>/dev/null)

# On any problem, drop into an interactive shell instead of exiting — otherwise
# the terminal window just vanishes and you never see why.
fail() {
    echo "watchfire resume: $1" >&2
    echo "(dropping to a shell — the session was not resumed)" >&2
    exec bash -i
}

[[ -n "$agent" && -n "$id" ]] || fail "missing agent or session id"
if [[ -n "$cwd" ]]; then
    cd "$cwd" 2>/dev/null || fail "cwd not found: $cwd"
fi

# Title the tab with the session name (same OSC 0 escape emit_state.py uses),
# so it reads e.g. "Fable Health" instead of the launch command ("wsl.exe").
# The agent's own hook re-asserts this on its first event, keeping it in sync.
[[ -n "$name" ]] && printf '\033]0;%s\007' "$name"

# exec so this terminal *becomes* the live session (no leftover wrapper shell).
case "$agent" in
    claude) exec claude --resume "$id" ;;
    codex)  exec codex resume "$id" ;;
    *)      fail "unknown agent: $agent" ;;
esac
