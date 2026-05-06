# Watchfire — Test Plan (TL view)

For each user use case from `use-cases.md`, this doc maps to the
engineering items in `behavior-spec.md` and proposes the test type.
Tests are then written against the engineering IDs (so a failing test
points at exactly one mechanism), but the cross-reference here lets
us trace any failure back to the user-visible promise it broke.

---

## Stack

| layer | runner | rationale |
|---|---|---|
| Python hook | `pytest` | hook is pure-functional + JSONL parsing, ideal for `pytest.tmp_path` fixtures |
| Node server | `node --test tests/server/` | built-in test runner — no new deps; `fetch` + `WebSocket` are built-in too |
| Widget pure logic | `node --test tests/widget/` | `nameOrPrompt`, `fmtElapsed`, `pctClass`, mini-bar count logic, popup HTML builder — extract into a side-effect-free module first (see Dev prep below) |
| WT focus / always-on-top / Edge `--app` window | manual | OS-level, no runner |

Single entry point: `wf test` → runs pytest + node:test, exits non-zero on any failure. Optionally wired into `~/.config/git/hooks/pre-push` later.

---

## Dev preparation (refactor needed before tests)

The current files have side effects at module top level (top-level
`await`, immediate `connectWS()`, DOM-element lookups). Tests can't
import them as-is without spinning the whole app. Two small splits:

| from | to | what moves |
|---|---|---|
| `server/index.js` | `server/chats.js` | `listChatsForCwd`, `listClaudeChatsForCwd`, `listCodexChatsForCwd`, `extractClaudeTranscriptMeta`, `extractCodexTranscriptMeta`, `buildCodexIndex` |
| `server/index.js` | `server/prune.js` | `getSystemBootTimeSec`, `prePruneBoot`, `isClaudeProcessAlive`, `pruneOrphanedSessions` |
| `web/widget.js` | `web/widget-pure.js` | `nameOrPrompt`, `fmtElapsed`, `fmtLimit`, `pctClass`, `statusLabel`, `renderMiniBar` (returns HTML string instead of touching `miniBarEl`), `renderGroup`/`renderRow` (same — return strings) |

`index.js` / `widget.js` keep the wiring (HTTP routes, WS, DOM
mounting) but delegate logic to the modules above.

---

## UC → impl → test mapping

`bs:` references are entries in `behavior-spec.md`.

### UC-1 (Detailed window)

| UC | impl (bs) | test type | test file |
|---|---|---|---|
| 1.1 grouping by cwd | W01 | unit (widget) | `tests/widget/render.test.js` |
| 1.2 context % + model limit | H14, H15, W05 (`pctClass`) | unit (hook) + unit (widget) | `tests/hooks/test_usage.py`, `tests/widget/format.test.js` |
| 1.3 elapsed time | widget `fmtElapsed` | unit (widget) | `tests/widget/format.test.js` |
| 1.4 fallback name | H13, H16, W04 (`nameOrPrompt`) | unit (hook) + unit (widget) | `tests/hooks/test_first_prompt.py`, `tests/widget/format.test.js` |
| 1.5 waiting visual | H04, H05 | unit (hook) | `tests/hooks/test_status_mapping.py` |
| 1.6 click → focus | W23, S05, S06 | integration (server) | `tests/server/focus.test.js` |
| 1.7 hover tooltip | W16, W18 | unit (widget) + manual | `tests/widget/tooltip.test.js`; visual checked by hand |
| 1.8 `[N]` popup | S08–S16, W08–W15 | integration (server) + unit (widget) | `tests/server/chats.test.js`, `tests/widget/popup.test.js` |
| 1.9 Claude vs Codex | W04 (badge classes) | unit (widget) | `tests/widget/render.test.js` |
| 1.10 collapse group | widget `collapsed` set | unit (widget) | `tests/widget/render.test.js` |

### UC-2 (Mini window)

| UC | impl | test type | test file |
|---|---|---|---|
| 2.1 toggle persisted | W19 (`localStorage`) | manual | (visual + reload) |
| 2.2 waiting names | new `renderMiniBar` | unit (widget) | `tests/widget/mini-bar.test.js` |
| 2.3 running/done counts | new `renderMiniBar`, `.zero` CSS | unit (widget) | `tests/widget/mini-bar.test.js` |
| 2.4 click chip → focus | same as 1.6 | integration (server) | covered by `focus.test.js` |

### UC-3 (Hygiene)

| UC | impl | test type | test file |
|---|---|---|---|
| 3.1 reboot prune | S21 (`prePruneBoot`) | unit (server) | `tests/server/prune.test.js` |
| 3.2 closed-terminal prune | S22, S23 (`pruneOrphanedSessions`, `isClaudeProcessAlive`) | unit (server) | `tests/server/prune.test.js` |
| 3.3 cron filter | H10 | unit (hook) | `tests/hooks/test_cron_filter.py` |
| 3.4 realtime updates (WS) | S17–S20 (chokidar broadcast) | integration (server) | `tests/server/ws.test.js` |
| 3.5 auto-reconnect | `ws.js` `onclose` retry | manual | (kill server, watch widget reconnect) |
| 3.6 always-on-top | `start_widget.ps1` SetWindowPos | manual | Windows-only |
| 3.7 auto-size at launch | `start_widget.ps1` height calc | manual | (visual; PS unit-testing not worth it) |
| 3.8 `/rename` propagation | H12 (read), H18 (OSC write) | unit (hook) | `tests/hooks/test_rename.py` |
| 3.9 CLI | C01–C08 | unit (shell) | `tests/cli/test_wf.bats` (or pytest-shell) |

---

## Phasing

**Phase 1 — Highest leverage, no infra-fight (next).**
- pytest setup + all hook unit tests (UC-1.2 hook part, 1.4 hook part, 1.5, 3.3, 3.8). Hooks are the most regression-prone surface (changes to status mapping, transcript parsing, PID logic) and the easiest to mock.
- Widget pure-function tests (UC-1.2 widget, 1.3, 1.4 widget, 1.9, 1.10, 2.2, 2.3) once `widget-pure.js` extraction is done. Tiny, fast.

**Phase 2.**
- Server integration tests (UC-1.6, 1.8, 3.1, 3.2, 3.4) once `chats.js` and `prune.js` extractions are done. These need a tmp `STATE_DIR` and tmp claude/codex transcript fixtures.

**Phase 3 (optional).**
- jsdom-based widget DOM tests for 1.7 tooltip placement, 2.1 toggle behavior. Lower priority — visual is mostly manual anyway.
- CLI shell tests if we add new subcommands.

---

## Manual-only checklist (not auto-tested)

- 1.5 visual pulse animation
- 1.7 tooltip looks right at hover (positioning is unit-tested; aesthetics aren't)
- 2.1 mini toggle reload-persistence
- 3.5 server-restart reconnect
- 3.6 always-on-top (Windows-only)
- 3.7 auto-sized launch (visual)

---

## Next concrete step

If this plan is approved:

1. **Dev refactor**: split `chats.js` / `prune.js` out of `server/index.js`, `widget-pure.js` out of `widget.js`. ~30 minutes, no behaviour change.
2. **QA Phase 1**: pytest scaffold + hook tests. ~1 hour, ~20 tests, catches the largest set of historical bugs (the things we kept fixing in this session: PID walking, OSC title, cron filter, status mapping edges).
3. **QA Phase 2**: node:test scaffold + server tests. ~1 hour, ~10 tests.
4. **`wf test`** wrapper: ~5 minutes.
