// History hides tool-spawned codex sessions (rescue `codex exec` / companion)
// by default, keyed on the transcript `source`. The user's own interactive
// codex ("cli") and all Claude chats stay visible.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isServiceSession, filterHistoryChats } from "../../web/widget-pure.js";

test("isServiceSession flags only non-cli codex sessions", () => {
  assert.equal(isServiceSession({ agent: "codex", source: "exec" }), true, "rescue exec");
  assert.equal(isServiceSession({ agent: "codex", source: "vscode" }), true, "companion");
  assert.equal(isServiceSession({ agent: "codex", source: "subagent" }), true, "sub-agent thread");
  assert.equal(isServiceSession({ agent: "codex", source: "cli" }), false, "interactive codex");
  assert.equal(isServiceSession({ agent: "codex", source: "" }), false, "old rollout, no source");
  assert.equal(isServiceSession({ agent: "codex" }), false, "source absent");
  assert.equal(isServiceSession({ agent: "claude", source: "exec" }), false, "codex source values mean nothing for claude");
  assert.equal(isServiceSession(null), false, "null-safe");
});

test("codex: originator decides, so daemon-hosted TUI tabs (source vscode) stay visible", () => {
  const tui = { agent: "codex", source: "vscode", originator: "codex-tui" };
  assert.equal(isServiceSession(tui), false, "user's own tab under the app-server daemon");
  assert.equal(isServiceSession({ agent: "codex", source: "cli", originator: "codex_cli_rs" }), false, "older TUI");
  assert.equal(isServiceSession({ agent: "codex", source: "vscode", originator: "Claude Code" }), true, "companion");
  assert.equal(isServiceSession({ agent: "codex", source: "exec", originator: "codex_exec" }), true, "rescue task");
  assert.equal(isServiceSession({ agent: "codex", source: "subagent", originator: "codex-tui" }), true, "sub-agent of a TUI session");
});

test("isServiceSession flags headless claude runs, keeps interactive front-ends", () => {
  assert.equal(isServiceSession({ agent: "claude", source: "sdk-cli" }), true, "claude -p");
  assert.equal(isServiceSession({ agent: "claude", source: "sdk-py" }), true, "Agent SDK (python)");
  assert.equal(isServiceSession({ agent: "claude", source: "cli" }), false, "interactive terminal");
  assert.equal(isServiceSession({ agent: "claude", source: "claude-vscode" }), false, "IDE is interactive");
  assert.equal(isServiceSession({ agent: "claude", source: "" }), false, "old transcript, no entrypoint");
});

test("filterHistoryChats drops tool-spawned codex and counts them when hidden", () => {
  const chats = [
    { session_id: "a", agent: "claude" },
    { session_id: "b", agent: "codex", source: "cli" },
    { session_id: "c", agent: "codex", source: "exec" },
    { session_id: "d", agent: "codex", source: "vscode" },
    { session_id: "e", agent: "codex", source: "" },
  ];
  const { chats: kept, hidden } = filterHistoryChats(chats, /*showCodexTasks=*/false);
  assert.deepEqual(kept.map(c => c.session_id), ["a", "b", "e"], "keeps claude, cli, and unknown-source");
  assert.equal(hidden, 2, "counts the two tool-spawned ones");
});

test("filterHistoryChats keeps everything when revealed", () => {
  const chats = [
    { session_id: "a", agent: "claude" },
    { session_id: "c", agent: "codex", source: "exec" },
  ];
  const { chats: kept, hidden } = filterHistoryChats(chats, /*showCodexTasks=*/true);
  assert.equal(kept.length, 2);
  assert.equal(hidden, 0);
});
