# Watchfire — Use Cases

Behavior catalog. Every entry is a thing the app *does* — a place a bug
could live. Tests will be written against these IDs so a failing test
points at a specific UC, and adding a UC is the trigger for adding a test.

**Format**

| field | meaning |
|---|---|
| `Trigger` | What kicks the behavior off (event, request, click). |
| `Expected` | Externally observable result. |
| `Notes` | Edge cases, gotchas. |
| `Test` | `unit` / `integration` / `manual` — what kind of test we'll write. |

**Status legend** — `auto` = tested by `wf test`, `manual` = checklist only.

---

## H. Hook (`hooks/emit_state.py`)

The hook is invoked by Claude/Codex via stdin-JSON. It produces one
JSON state file per session under `~/.watchfire/sessions/<id>.json`.

### Status mapping

| ID | Trigger | Expected | Test |
|---|---|---|---|
| H01 | `hook_event_name = SessionStart` | New state file, `status = idle`. | unit |
| H02 | `UserPromptSubmit` | `status = working`, `last_prompt = payload.prompt[:500]`. | unit |
| H03 | `PreToolUse` | `status = working`. Clears stuck `waiting_input` after permission grant. Heavy parsing skipped. | unit |
| H04 | `Notification` (any other message) | `status = waiting_input`, `last_message = payload.message`. | unit |
| H05 | `Notification` with `"is waiting for your input"` | Treated as idle reminder → `status = done` (preserves prior Stop). | unit |
| H06 | `Stop` | `status = done`. | unit |
| H07 | `PermissionRequest` (codex) | `status = waiting_input`, `last_message = "approval: <tool>"`. | unit |

### Identity & tracking

| ID | Trigger | Expected | Test |
|---|---|---|---|
| H08 | Any event | `state.pid` = walked-up agent CLI PID (claude/codex `comm`), not the sh-wrapper's `getppid()`. | unit |
| H09 | `cwd` starts with `/mnt/<drive>/<top>` | First two segments after `/mnt/` lowercased to canonicalize Codex/Claude case mismatch. | unit |
| H10 | `cwd` contains `.claude-daily-summary` or `.claude-meeting-summaries` | Hook returns 0 with no state write (cron-only runs filtered). | unit |
| H11 | `payload.session_id` missing/empty | Hook returns 0 with no state write (no `unknown.json` orphan). | unit |

### Transcript extraction

| ID | Trigger | Expected | Test |
|---|---|---|---|
| H12 | Claude transcript with `{"type":"custom-title","customTitle":"…"}` | `state.name` = customTitle. | unit |
| H13 | Claude transcript, first `type=user` entry | `state.first_prompt` = first 500 chars of that text (set once, never overwritten). | unit |
| H14 | Claude transcript with `usage` block on last assistant message | `state.context_tokens` = input + cache_creation + cache_read; `state.context_limit` = `MODEL_LIMITS[model]`. | unit |
| H15 | Codex transcript, last `event_msg.token_count` | `state.context_tokens` = `last_token_usage.input_tokens`; `state.context_limit` = `model_context_window`. | unit |
| H16 | Codex transcript, first `event_msg.user_message` | `state.first_prompt` = its `payload.message[:500]` (skips the `<environment_context>` `response_item`). | unit |
| H17 | `event ∈ {PreToolUse, PostToolUse}` | Transcript NOT re-parsed; only `status / last_event / last_event_at / pid` updated. | unit |

### Side effects

| ID | Trigger | Expected | Test |
|---|---|---|---|
| H18 | Any non-LIGHT event with `state.name` (or first_prompt / id fallback) | OSC 0/2 escape `\033]0;<title>\007` written to `/dev/tty` (so WT tabs match). | unit |
| H19 | Hook with no controlling tty (cron, no terminal) | `/dev/tty` open fails silently, no traceback. | unit |
| H20 | Multiple hooks for same `session_id` | State file merged (existing fields preserved unless overwritten by event). Atomic write via `.tmp` + replace. | unit |

---

## S. Server (`server/index.js`)

Local Node HTTP + WebSocket server, port 4173.

### Static + cache

| ID | Trigger | Expected | Test |
|---|---|---|---|
| S01 | `GET /` | Serves `web/index.html`. | integration |
| S02 | `GET /widget.html` | Serves widget page. | integration |
| S03 | Any static asset | Response includes `Cache-Control: no-store, no-cache, must-revalidate` (Edge `--app` would otherwise cache JS/CSS). | integration |
| S04 | `GET` outside `WEB_DIR` (e.g. `../server/index.js`) | 403, no read. | integration |

### `/focus`

| ID | Trigger | Expected | Test |
|---|---|---|---|
| S05 | `POST /focus { name, cwd }` | Spawns `focus_window.ps1 -TabName <name>`. | integration |
| S06 | Body has no `name` | Falls back to last `cwd` segment as `-TabName`. | integration |
| S07 | Body fully empty | Calls PS without `-TabName` → still focuses first WT window. | integration |

### `/chats`

| ID | Trigger | Expected | Test |
|---|---|---|---|
| S08 | `GET /chats?cwd=X` | Returns merged claude + codex chats for X, sorted by `last_modified` desc, capped at 50. | integration |
| S09 | Claude project dir name with original case | Matches `cwd` lowercase via case-insensitive scan of `~/.claude/projects/`. | integration |
| S10 | Each Claude transcript | Extracted `name` (customTitle if any) + `first_prompt`. | integration |
| S11 | Codex sessions tree | Walked recursively under `~/.codex/sessions/`, `*.jsonl` only. | integration |
| S12 | Each Codex transcript with `session_meta.payload.cwd` | Used as the cwd. | integration |
| S13 | Older Codex transcript with `<cwd>…</cwd>` only | Falls back to regex extraction. | integration |
| S14 | Codex transcript file ≥ 64KB on first line | Line-by-line stream still parses (`session_meta` carries full system prompt). | integration |
| S15 | `/chats` called twice within 30s | Second call returns from in-memory codex index cache. | integration |
| S16 | Codex transcript filename `rollout-…-<UUID>.jsonl` | `session_id` regex captures only the trailing UUID, not the timestamp prefix. | unit |

### WebSocket

| ID | Trigger | Expected | Test |
|---|---|---|---|
| S17 | Client connects | Server sends `{type: "snapshot", sessions: […]}` immediately. | integration |
| S18 | New `*.json` appears in state dir | `{type: "session_added", session: {…}}` broadcast. | integration |
| S19 | Existing `*.json` rewritten | `{type: "session_changed", session: {…}}` broadcast. | integration |
| S20 | `*.json` unlinked | `{type: "session_removed", session_id}` broadcast. | integration |

### Garbage collection

| ID | Trigger | Expected | Test |
|---|---|---|---|
| S21 | Server start | `prePruneBoot` deletes state files whose `last_event_at < /proc/stat btime`. | unit |
| S22 | Server start, then every 5 min | `pruneOrphaned` deletes state files whose recorded `pid` doesn't have a live `/proc/<pid>/cmdline` containing claude/codex/node. | unit |
| S23 | State file with no `pid` field (legacy) | Skipped by orphan prune (only boot prune covers it). | unit |

---

## W. Widget UI (`web/widget.js`, `web/widget.html`)

Compact list view, served at `/widget.html`. Edge `--app` window.

### Rendering

| ID | Trigger | Expected | Test |
|---|---|---|---|
| W01 | WS snapshot received | One `.group` per cwd, rows inside sorted by `last_event_at` desc; groups sorted by their freshest session. | unit (logic) |
| W02 | Group header click on `.g-toggle` | Adds/removes cwd from `collapsed` set, re-renders. | manual |
| W03 | `.g-count` (the `[N]` badge) shown next to folder name | `N` = `chatsCounts.get(cwd)` if known, else current row count. | unit (logic) |
| W04 | `nameOrPrompt(s)` | Returns `name` ‖ `first_prompt` ‖ `last_prompt` ‖ first 8 chars of session_id. | unit |
| W05 | Row context % column | `pct >= 80 → .danger`, `pct >= 50 → .warn`, else default. | unit |
| W06 | Status `waiting_input` | Row gets `.waiting` class (red border); window glow pulses. | manual |
| W07 | Periodic re-render | Every 5s so `1:23` elapsed timer ticks visibly. | manual |

### `[N]` chats popup

| ID | Trigger | Expected | Test |
|---|---|---|---|
| W08 | Click `.g-count` | Popup pinned (`pinnedCwd = cwd`), tooltip shows active rows + non-active rows. | manual |
| W09 | Click same `.g-count` again | Popup hides, `pinnedCwd = null`. | manual |
| W10 | Click outside popup | Popup hides. | manual |
| W11 | Hover any row while popup is pinned | Row hover tooltip suppressed (popup wins). | manual |
| W12 | Active rows | Status dot color, name in `--text`, status label. | manual |
| W13 | Non-active rows | `inactive` class, name in `#b0bcc8`, label `non active`. | manual |
| W14 | `[N]` initial paint | Shows `active.length` until `/chats` resolves; then re-renders with truth. | manual |
| W15 | `WS upsert/remove` for a cwd | `chatsCounts` and `chatsCache` for that cwd invalidated. | unit (logic) |

### Row hover tooltip

| ID | Trigger | Expected | Test |
|---|---|---|---|
| W16 | `mouseenter` on a row | Tooltip with model + last prompt + cwd, anchored to row with 5px gap above (fallback below if no room). | manual |
| W17 | `mouseleave` on a row | Tooltip hidden — unless a chat popup is pinned for some cwd, then preserved. | manual |
| W18 | Body has `zoom: 1.15` | Tooltip dimensions read via `getBoundingClientRect`, not `offsetWidth`. | unit (logic) |

### Mini bar

| ID | Trigger | Expected | Test |
|---|---|---|---|
| W19 | Toggle button click | Body `.mini` class toggled; persisted in `localStorage["orchestrator.mini"]`. | manual |
| W20 | Mini render | Row 1: every `waiting_input` session as a clickable chip with name. Row 2: `N running · N done` (zeros hidden). `idle` not surfaced. | unit (logic) |
| W21 | Click waiting chip | `focusSession(s)` → `POST /focus`. | manual |
| W22 | No waiting sessions | Row 1 shows italic `no waiting`. | unit (logic) |

### Click-through

| ID | Trigger | Expected | Test |
|---|---|---|---|
| W23 | Row click | `POST /focus { session_id, cwd, name }`. | integration |
| W24 | WS disconnects | Auto-reconnects every 1s (`ws.js` `onclose`). | integration |

---

## M. Iso map (`web/main.js`)

Phaser scene served at `/`.

| ID | Trigger | Expected | Test |
|---|---|---|---|
| M01 | Per cwd | Spiral-placed 3×3 district with fence, watchtower (bottom-left), folder name below south corner. | manual |
| M02 | Hover watchtower | Tooltip lists active + non-active chats for that cwd (same data as widget popup). | manual |
| M03 | Per session | One isometric house: walls (sunlit + shaded), tiled hip roof, plank seams, foundation, window glow = status, chimney smoke when `working`, pulsing window when `waiting_input`. | manual |
| M04 | Roof color | Claude → terra `#a64633`; Codex → teal `#3a7a8a`. | manual |
| M05 | Click house | `POST /focus { session_id, cwd, name }`. | manual |
| M06 | Right-mouse drag | Camera pans. | manual |
| M07 | Mouse wheel | Camera zooms (clamped to 0.4–2.5). | manual |

---

## C. CLI (`~/.local/bin/wf`, alias `orch` symlink)

| ID | Trigger | Expected | Test |
|---|---|---|---|
| C01 | `wf` (no args) | Equivalent to `wf widget`. | unit (shell) |
| C02 | `wf widget` | Ensures server is up, launches Edge `--app` widget pointing at `/widget.html`. | manual |
| C03 | `wf map` | Ensures server is up, opens `/` in default browser. | manual |
| C04 | `wf server` | Starts Node server, writes pid to `~/.watchfire/server.pid`, log to `server.log`. | unit (shell) |
| C05 | `wf stop` | Stops server, removes pid file. | unit (shell) |
| C06 | `wf status` | Prints PID + URL when running, `not running` otherwise. | unit (shell) |
| C07 | `wf logs` | Tails `server.log`. | manual |
| C08 | `orch <args>` | Same as `wf <args>` (symlink). | unit (shell) |

---

## Out of scope (for now)

- Visual layout regressions (CSS, dot sizes, font metrics) — caught by eyeballing.
- Phaser scene rendering correctness — manual review only.
- Cross-WSL-distro behavior — single-machine app.
