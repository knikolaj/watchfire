// History hides tool-spawned codex sessions (rescue `codex exec` / companion)
// by default, keyed on the transcript `source`. The user's own interactive
// codex ("cli") and all Claude chats stay visible.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isToolSpawnedCodex, filterHistoryChats } from "../../web/widget-pure.js";

test("isToolSpawnedCodex flags only non-cli codex sessions", () => {
  assert.equal(isToolSpawnedCodex({ agent: "codex", source: "exec" }), true, "rescue exec");
  assert.equal(isToolSpawnedCodex({ agent: "codex", source: "vscode" }), true, "companion");
  assert.equal(isToolSpawnedCodex({ agent: "codex", source: "subagent" }), true, "sub-agent thread");
  assert.equal(isToolSpawnedCodex({ agent: "codex", source: "cli" }), false, "interactive codex");
  assert.equal(isToolSpawnedCodex({ agent: "codex", source: "" }), false, "old rollout, no source");
  assert.equal(isToolSpawnedCodex({ agent: "codex" }), false, "source absent");
  assert.equal(isToolSpawnedCodex({ agent: "claude", source: "exec" }), false, "claude is never a codex task");
  assert.equal(isToolSpawnedCodex(null), false, "null-safe");
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
