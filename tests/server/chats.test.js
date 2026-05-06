// UC-1.8 — `[N]` popup data: every chat that's ever lived in a cwd,
// from both Claude (per-cwd flattened dir) and Codex (date-tree).
//
// Tests build tmp `claude/projects/` and `codex/sessions/` trees, point
// the chats module at them via opts, assert the merged result.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  listChatsForCwd,
  listClaudeChatsForCwd,
  listCodexChatsForCwd,
  buildCodexIndex,
  extractClaudeTranscriptMeta,
  extractCodexTranscriptMeta,
} from "../../server/chats.js";

// --- helpers ---------------------------------------------------------------

async function tmpDir(label) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `wf-${label}-`));
}

async function writeJsonl(filePath, lines) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}

function freshCache() {
  return { built: 0, byCwd: new Map() };
}

// --- Claude side -----------------------------------------------------------

test("listClaudeChatsForCwd returns one entry per .jsonl, with name + first_prompt", async () => {
  const claudeDir = await tmpDir("claude");
  const cwd = "/mnt/c/users/test";
  // Project dir name is cwd with `/` → `-`. Real on-disk Claude preserves
  // the cwd's case, but our state files lowercase it. Match insensitively.
  const projDir = path.join(claudeDir, "-mnt-c-Users-test");
  await writeJsonl(path.join(projDir, "session-aaa.jsonl"), [
    { type: "user",          message: { content: "first prompt aaa" } },
    { type: "custom-title",  customTitle: "Renamed AAA" },
  ]);
  await writeJsonl(path.join(projDir, "session-bbb.jsonl"), [
    { type: "user", message: { content: "first prompt bbb" } },
  ]);

  const out = await listClaudeChatsForCwd(cwd, { claudeDir });
  out.sort((a, b) => a.session_id.localeCompare(b.session_id));
  assert.equal(out.length, 2);
  assert.equal(out[0].session_id, "session-aaa");
  assert.equal(out[0].name, "Renamed AAA");
  assert.equal(out[0].first_prompt, "first prompt aaa");
  assert.equal(out[1].name, "");
  assert.equal(out[1].first_prompt, "first prompt bbb");
  for (const x of out) assert.equal(x.agent, "claude");
});

test("listClaudeChatsForCwd returns [] for unknown cwd", async () => {
  const claudeDir = await tmpDir("claude");
  const out = await listClaudeChatsForCwd("/no/such/cwd", { claudeDir });
  assert.deepEqual(out, []);
});

test("extractClaudeTranscriptMeta picks text out of block-array content", async () => {
  const dir = await tmpDir("claude-meta");
  const fp = path.join(dir, "t.jsonl");
  await writeJsonl(fp, [
    { type: "user", message: { content: [
      { type: "image_ref", ref: "x" },
      { type: "text", text: "actual prompt" },
    ]}},
  ]);
  const meta = await extractClaudeTranscriptMeta(fp);
  assert.equal(meta.first_prompt, "actual prompt");
});

// --- Codex side ------------------------------------------------------------

test("extractCodexTranscriptMeta uses session_meta.payload.cwd", async () => {
  const dir = await tmpDir("codex-meta");
  const fp = path.join(dir, "rollout-2026-01-01T00-00-00-019d1234-5678-7abc-9def-0123456789ab.jsonl");
  await writeJsonl(fp, [
    { type: "session_meta",  payload: { cwd: "/home/nj/proj" } },
    { type: "response_item", payload: { type: "message", role: "user",
        content: [{ type: "input_text", text: "<environment_context><cwd>/home/nj/proj</cwd></environment_context>" }] } },
    { type: "event_msg", payload: { type: "user_message", message: "real first prompt" } },
  ]);
  const meta = await extractCodexTranscriptMeta(fp);
  assert.equal(meta.cwd, "/home/nj/proj");
  assert.equal(meta.first_prompt, "real first prompt");
  assert.equal(meta.session_id, "019d1234-5678-7abc-9def-0123456789ab");
  assert.equal(meta.agent, "codex");
});

test("extractCodexTranscriptMeta falls back to <cwd> tag when session_meta lacks one", async () => {
  // Older Codex versions only put the cwd inside the env-context msg.
  const dir = await tmpDir("codex-meta-old");
  const fp = path.join(dir, "rollout-019d1234-5678-7abc-9def-0123456789ab.jsonl");
  await writeJsonl(fp, [
    { type: "response_item", payload: { type: "message", role: "user",
        content: [{ type: "input_text", text: "<environment_context><cwd>/legacy/cwd</cwd></environment_context>" }] } },
    { type: "event_msg", payload: { type: "user_message", message: "hi" } },
  ]);
  const meta = await extractCodexTranscriptMeta(fp);
  assert.equal(meta.cwd, "/legacy/cwd");
});

test("extractCodexTranscriptMeta UUID regex doesn't snag the timestamp prefix", async () => {
  // Filename has a long ISO timestamp before the UUID. A naive
  // [0-9a-f-]+ regex would grab "33-01-019d…" instead of just the UUID.
  const dir = await tmpDir("codex-uuid");
  const fp = path.join(dir, "rollout-2026-04-30T14-33-01-019ddece-b19a-7173-9692-9cf40b97c985.jsonl");
  await writeJsonl(fp, [
    { type: "session_meta", payload: { cwd: "/x" } },
  ]);
  const meta = await extractCodexTranscriptMeta(fp);
  assert.equal(meta.session_id, "019ddece-b19a-7173-9692-9cf40b97c985");
});

test("buildCodexIndex walks the date tree and groups by cwd", async () => {
  const codexDir = await tmpDir("codex-tree");
  const day = path.join(codexDir, "2026", "04", "30");
  await writeJsonl(path.join(day, "rollout-aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl"), [
    { type: "session_meta", payload: { cwd: "/proj/A" } },
    { type: "event_msg", payload: { type: "user_message", message: "in A" } },
  ]);
  await writeJsonl(path.join(day, "rollout-bbbbbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb.jsonl"), [
    { type: "session_meta", payload: { cwd: "/proj/B" } },
  ]);
  await writeJsonl(path.join(day, "rollout-cccccccc-cccc-7ccc-cccc-cccccccccccc.jsonl"), [
    { type: "session_meta", payload: { cwd: "/proj/A" } },
  ]);

  const cache = freshCache();
  const idx = await buildCodexIndex({ codexDir, codexCache: cache });
  assert.equal(idx.get("/proj/a").length, 2);
  assert.equal(idx.get("/proj/b").length, 1);
});

test("buildCodexIndex caches results within TTL", async () => {
  const codexDir = await tmpDir("codex-cache");
  const day = path.join(codexDir, "2026", "04", "30");
  const fp = path.join(day, "rollout-11111111-1111-7111-1111-111111111111.jsonl");
  await writeJsonl(fp, [{ type: "session_meta", payload: { cwd: "/x" } }]);

  const cache = freshCache();
  const first = await buildCodexIndex({ codexDir, codexCache: cache });
  assert.equal(first.get("/x").length, 1);

  // Add a 2nd file. With cache valid, it must NOT show up.
  await writeJsonl(
    path.join(day, "rollout-22222222-2222-7222-2222-222222222222.jsonl"),
    [{ type: "session_meta", payload: { cwd: "/x" } }],
  );
  const second = await buildCodexIndex({ codexDir, codexCache: cache });
  assert.equal(second.get("/x").length, 1);  // still 1 — cache hit

  // Force expiry: ttl=1ms, then re-call — now sees the new file.
  await new Promise(r => setTimeout(r, 5));
  const third = await buildCodexIndex({ codexDir, codexCache: cache, codexTtlMs: 1 });
  assert.equal(third.get("/x").length, 2);
});

// --- Merge -----------------------------------------------------------------

test("listChatsForCwd merges claude + codex, sorted by mtime desc", async () => {
  const claudeDir = await tmpDir("claude-merge");
  const codexDir  = await tmpDir("codex-merge");
  const cwd = "/proj/x";

  await writeJsonl(
    path.join(claudeDir, "-proj-x", "session-claude.jsonl"),
    [{ type: "user", message: { content: "C" } }],
  );
  await writeJsonl(
    path.join(codexDir, "2026", "01", "01",
              "rollout-019dffff-ffff-7fff-ffff-ffffffffffff.jsonl"),
    [{ type: "session_meta", payload: { cwd } },
     { type: "event_msg", payload: { type: "user_message", message: "X" } }],
  );

  const out = await listChatsForCwd(cwd, {
    claudeDir, codexDir, codexCache: freshCache(),
  });
  assert.equal(out.length, 2);
  const agents = out.map(x => x.agent).sort();
  assert.deepEqual(agents, ["claude", "codex"]);
  // Sorted by last_modified desc:
  assert.ok(out[0].last_modified >= out[1].last_modified);
});

test("listChatsForCwd returns [] for empty cwd", async () => {
  const out = await listChatsForCwd("");
  assert.deepEqual(out, []);
});
