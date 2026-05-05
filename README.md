# Watchfire

A widget for monitoring parallel CLI sessions.

Once you have five-plus Claude Code and Codex sessions open across different
terminals, you lose track of who's working, who's stuck on a permission
prompt, and who finished an hour ago. Watchfire surfaces all of that in two
views:

- a compact, always-on-top **widget** with per-session status, context %, and
  the last prompt — click any row to jump to the matching Windows Terminal tab
- an isometric **map** where each project directory is its own walled village
  and every session is a little house with smoke from the chimney while it's
  working — the watchtower at the corner shows every chat that's ever lived
  in that directory, archived or active

Local-only. No auth, no cloud, just localhost + WebSocket.

## How it works

```
  Claude Code / Codex hooks
            │
            ▼
    hooks/emit_state.py            (one JSON file per session)
            │
            ▼
  ~/.claude/orchestrator/sessions/<session-id>.json
            │
            ▼ chokidar
       Node WS server
            │
       ┌────┴────┐
       ▼         ▼
   widget.html  index.html
   (compact)    (iso map)
```

Each Claude/Codex hook event runs `emit_state.py`, which mirrors the
session's status and metadata into a JSON file. The Node server watches that
directory and pushes changes to the browser over WebSocket.

## Status colors

| status          | meaning                               | visual                     |
|-----------------|---------------------------------------|----------------------------|
| `working`       | agent is processing                   | yellow + chimney smoke     |
| `waiting_input` | permission prompt or idle ping        | red, pulsing window glow   |
| `done`          | turn finished                         | green                      |
| `idle`          | session started, no prompt yet        | dim grey                   |

## Setup

```bash
# 1. Install server deps
cd server && npm install

# 2. Wire the hook into Claude Code (~/.claude/settings.json)
#    Add emit_state.py under SessionStart, UserPromptSubmit, PreToolUse,
#    Notification, Stop. See settings.json.example.

# 3. Add the codex hook (~/.codex/config.toml — agent=codex variant)

# 4. Drop ./bin/orch onto your PATH (or symlink it).
```

## Usage

```
orch widget    # launch the always-on-top widget (default)
orch map       # open the iso map in the default browser
orch server    # start the Node server (orch widget does this implicitly)
orch stop      # stop the server
orch status    # is anything listening on :4173?
orch logs      # tail server stdout
```

Click a row in the widget → the corresponding Windows Terminal tab gets
focus. Hover the watchtower in the iso map → see every chat the directory
has ever hosted, active and archived (read from `~/.claude/projects/<dir>/`).

## Implementation notes

- **Sub-agent fix.** Sub-agents fire a Notification before each tool, which
  used to leave the session stuck on `waiting_input` even after the user
  approved. We hook `PreToolUse` and flip back to `working` once the tool
  actually starts.
- **PID-based GC.** Every hook records the agent CLI's PID (walking up from
  the sh-wrapper's parent until we hit a process whose `comm` is
  `claude`/`codex`). The server prunes state files whose PID is dead every
  5 minutes — covers terminals closed without firing Stop.
- **Boot-time prune.** On server start, anything whose `last_event_at`
  predates `/proc/stat btime` is dropped — handles laptop reboots.
- **Cron-run filter.** `daily-summary.py` and `fireflies-sync.py` `cd` into
  sandbox dirs (`~/.claude-daily-summary/<month>`,
  `~/.claude-meeting-summaries/<month>`) before invoking `claude -p`, so the
  hook can recognize them by cwd and skip writing state.
- **Tab focusing.** Claude's `/rename` updates the transcript but doesn't
  push the title to the terminal. We do that via OSC 0/2 from the hook,
  giving each WT tab a unique title that the click-handler can match
  through UI Automation.
- **Light events.** `PreToolUse` skips all transcript parsing — it fires
  100+ times per turn during agent loops, so re-reading the JSONL each time
  was the largest source of overhead.

## Caveats

- Linux/WSL only — uses `/proc/`. Trivial to port to macOS by swapping
  `/proc/<pid>/comm` for `ps -o comm=`.
- Tab focusing is Windows-Terminal-specific (UI Automation + OSC titles).

## Stack

Plain Node (no framework) + `ws` + `chokidar` for the server. Phaser 3 for
the iso map. Vanilla DOM + CSS for the widget. Edge `--app` mode for the
chrome-less always-on-top window.
