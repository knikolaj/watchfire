// Self-check: live interactive sessions with no state file are reported;
// stale registry entries, headless runs and tool-started Codex are not.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { findUnseenSessions } from "../../server/audit.js";

const NOW = 1_800_000_000_000;
const OLD = NOW - 60 * 60 * 1000;
const U = (n) => `01a00000-0000-7000-8000-00000000000${n}`;
const rollout = (id) => `/h/.codex/sessions/2026/10/12/rollout-2026-10-12T01-33-42-${id}.jsonl`;

async function stateDirWith(...ids) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-audit-"));
  for (const id of ids) await fs.writeFile(path.join(dir, `${id}.json`), "{}");
  return dir;
}

const claude = (pid, sessionId, extra = {}) => ({
  pid, sessionId, cwd: "/p/x", startedAt: OLD, procStart: String(pid * 10),
  kind: "interactive", entrypoint: "cli", ...extra,
});

function run(dir, { registry = [], rollouts = {}, starts } = {}) {
  return findUnseenSessions(dir, {
    now: NOW,
    listClaudeRegistry: () => registry,
    procStartOf: (pid) => (starts ? starts[pid] ?? null : String(pid * 10)),
    listCodexRollouts: () => Object.keys(rollouts),
    readRolloutMeta: (f) => rollouts[f],
  });
}

test("everything shown -> nothing reported", async () => {
  const dir = await stateDirWith("c1", U(1));
  const r = await run(dir, {
    registry: [claude(10, "c1")],
    rollouts: { [rollout(U(1))]: { originator: "codex-tui", source: "vscode", cwd: "/p/y" } },
  });
  assert.deepEqual(r, { live: 2, unseen: [] });
});

test("live claude and codex sessions without a state file are reported", async () => {
  const dir = await stateDirWith();
  const r = await run(dir, {
    registry: [claude(10, "c1")],
    rollouts: { [rollout(U(1))]: { originator: "codex-tui", source: "vscode", cwd: "/p/y" } },
  });
  assert.deepEqual(r.unseen, [
    { agent: "claude", session_id: "c1", cwd: "/p/x", pid: 10 },
    { agent: "codex", session_id: U(1), cwd: "/p/y" },
  ]);
});

test("stale registry entries are ignored: process gone, or pid reused", async () => {
  const dir = await stateDirWith();
  const r = await run(dir, {
    registry: [claude(10, "gone"), claude(11, "reused")],
    starts: { 11: "999" },   // pid 11 exists but is a different process now
  });
  assert.deepEqual(r, { live: 0, unseen: [] });
});

test("headless claude, brand-new sessions and tool-started codex are not expected", async () => {
  const dir = await stateDirWith();
  const r = await run(dir, {
    registry: [
      claude(10, "bot", { entrypoint: "sdk-py" }),
      claude(11, "bg", { kind: "background" }),
      claude(12, "young", { startedAt: NOW - 5000 }),
    ],
    rollouts: {
      [rollout(U(1))]: { originator: "codex_exec", source: "exec" },
      [rollout(U(2))]: { originator: "Claude Code", source: "vscode" },
      [rollout(U(3))]: { originator: "codex-tui", source: { subagent: {} } },
    },
  });
  assert.deepEqual(r, { live: 0, unseen: [] });
});

test("listOpenSessions: verified claude entries + held rollouts, with their herdr pane", async () => {
  const { listOpenSessions } = await import("../../server/audit.js");
  const list = listOpenSessions({
    listClaudeRegistry: () => [claude(10, "c-herdr"), claude(11, "c-stale"), claude(12, "c-wt")],
    procStartOf: (pid) => ({ 10: "100", 11: "999", 12: "120" })[pid],
    listCodexRollouts: () => [rollout(U(1)), rollout(U(2)), "/not/a/rollout.txt"],
    listCodexClients: () => [
      { pid: 20, cmdline: `codex resume ${U(1)}` },   // resumed inside herdr
      { pid: 21, cmdline: "codex" },                   // fresh: id unknown
    ],
    herdrPaneOf: (pid) => ({ 10: "w1:p1", 20: "w1:p2", 21: "w1:p3" })[pid] ?? null,
  });
  const byId = Object.fromEntries(list.map(s => [s.session_id, s.herdr_pane_id]));
  assert.deepEqual(byId, { "c-herdr": "w1:p1", "c-wt": null, [U(1)]: "w1:p2", [U(2)]: null });
});
