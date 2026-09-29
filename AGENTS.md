# Agent notes — watchfire

Read `README.md` first: what watchfire is, setup, usage, stack. Behaviour and
test plans live in `docs/` (`behavior-spec.md`, `use-cases.md`, `test-plan.md`).

## Constraints

- **This repository is public.** No personal paths, usernames, hostnames,
  tokens or screenshots with private data. Machine- and user-specific values
  belong in `~/.watchfire/config.json` (see `server/config.js`) or in the
  templates that `deploy/install.sh` renders per machine — never in code.
- **Keep the server local-only.** It binds `127.0.0.1` and checks `Host` /
  `Origin`, including on the WebSocket handshake, and accepts only UUID-shaped
  session ids (`server/guard.js`). Do not weaken any of these: with WSL
  mirrored networking, a looser bind or check exposes it on the Wi-Fi.
- **Hooks are global.** `hooks/emit_state.py` runs inside every Claude Code and
  Codex session on the machine; a crash or slow path there affects all of them.
  Keep it fast, and never let it raise into the agent.

## Checks

`watchfire test` runs both suites (pytest for the hook, `node:test` for the
server). Run it before proposing a change as done.
