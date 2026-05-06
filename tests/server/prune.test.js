// UC-3.1 (boot prune) + UC-3.2 (closed-terminal prune).
//
// Both prune functions accept their dependencies via opts so we can
// drive them from tests with a tmp state dir, a fixed boot-time, and a
// fake liveness function — no real /proc or kernel involvement.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  prePruneBoot,
  pruneOrphanedSessions,
  isClaudeProcessAlive,
  getSystemBootTimeSec,
} from "../../server/prune.js";

async function tmpDir(label) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `wf-${label}-`));
}

async function writeState(dir, name, body) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(body));
}

async function listSessionIds(dir) {
  return (await fs.readdir(dir)).filter(f => f.endsWith(".json"))
    .map(f => f.slice(0, -5)).sort();
}

// --- prePruneBoot ----------------------------------------------------------

test("prePruneBoot deletes files whose last_event_at is < bootTime", async () => {
  const dir = await tmpDir("prune-boot");
  const boot = 1_000_000;
  await writeState(dir, "old",   { last_event_at: boot - 100 });
  await writeState(dir, "new",   { last_event_at: boot + 50  });
  await writeState(dir, "zero",  { last_event_at: 0          });
  await writeState(dir, "fresh", { last_event_at: boot + 999 });

  const removed = await prePruneBoot(dir, { bootTime: boot });
  assert.equal(removed, 2);
  assert.deepEqual(await listSessionIds(dir), ["fresh", "new"]);
});

test("prePruneBoot does nothing when bootTime is 0 (non-Linux)", async () => {
  const dir = await tmpDir("prune-no-boot");
  await writeState(dir, "anything", { last_event_at: 1 });
  const removed = await prePruneBoot(dir, { bootTime: 0 });
  assert.equal(removed, 0);
  assert.equal((await listSessionIds(dir)).length, 1);
});

test("prePruneBoot skips malformed json files", async () => {
  const dir = await tmpDir("prune-malformed");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "bad.json"), "not json {");
  await writeState(dir, "good", { last_event_at: 0 });
  const removed = await prePruneBoot(dir, { bootTime: 999 });
  assert.equal(removed, 1);                                  // good was old
  assert.deepEqual(await listSessionIds(dir), ["bad"]);     // malformed left alone
});

// --- isClaudeProcessAlive --------------------------------------------------

test("isClaudeProcessAlive — alive claude/codex/node returns true", () => {
  const fakeRead = (pid) => {
    if (pid === 1) return "claude --resume";
    if (pid === 2) return "node /path/to/codex";
    if (pid === 3) return "/path/codex";
    return null;
  };
  assert.equal(isClaudeProcessAlive(1, fakeRead), true);
  assert.equal(isClaudeProcessAlive(2, fakeRead), true);
  assert.equal(isClaudeProcessAlive(3, fakeRead), true);
});

test("isClaudeProcessAlive — pid not found returns false", () => {
  const fakeRead = () => null;
  assert.equal(isClaudeProcessAlive(99999, fakeRead), false);
});

test("isClaudeProcessAlive — pid reused by unrelated process returns false", () => {
  // PID exists but cmdline is bash, not claude/codex/node — must NOT
  // be treated as a live agent (defends against PID reuse).
  const fakeRead = () => "/usr/bin/bash";
  assert.equal(isClaudeProcessAlive(1234, fakeRead), false);
});

test("isClaudeProcessAlive — null pid returns null (legacy file marker)", () => {
  assert.equal(isClaudeProcessAlive(null), null);
  assert.equal(isClaudeProcessAlive(undefined), null);
  assert.equal(isClaudeProcessAlive(0), null);
});

// --- pruneOrphanedSessions -------------------------------------------------

test("pruneOrphanedSessions removes files whose pid is dead", async () => {
  const dir = await tmpDir("prune-orphan");
  await writeState(dir, "alive",   { pid: 100 });
  await writeState(dir, "dead",    { pid: 200 });
  await writeState(dir, "reused",  { pid: 300 });
  await writeState(dir, "no-pid",  { /* no pid — legacy file */ });

  const isAlive = (pid) => {
    if (pid === 100) return true;
    if (pid === 200) return false;
    if (pid === 300) return false;     // pid reused by something else
    return null;
  };

  const removed = await pruneOrphanedSessions(dir, { isAlive });
  assert.equal(removed, 2);
  assert.deepEqual(await listSessionIds(dir), ["alive", "no-pid"]);
});

test("pruneOrphanedSessions ignores malformed json files", async () => {
  const dir = await tmpDir("prune-orphan-bad");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "bad.json"), "{");
  const removed = await pruneOrphanedSessions(dir, { isAlive: () => true });
  assert.equal(removed, 0);
});

test("pruneOrphanedSessions handles missing state dir gracefully", async () => {
  const removed = await pruneOrphanedSessions("/no/such/dir", { isAlive: () => true });
  assert.equal(removed, 0);
});

// --- getSystemBootTimeSec --------------------------------------------------

test("getSystemBootTimeSec parses /proc/stat btime line", async () => {
  // Build a synthetic /proc/stat-like file.
  const dir = await tmpDir("proc-stat");
  const fp = path.join(dir, "stat");
  await fs.writeFile(fp,
    "cpu  1 2 3 4 5\n" +
    "intr 100 200\n" +
    "btime 1700000000\n" +
    "processes 12345\n"
  );
  assert.equal(getSystemBootTimeSec(fp), 1_700_000_000);
});

test("getSystemBootTimeSec returns 0 when file is missing", () => {
  assert.equal(getSystemBootTimeSec("/no/such/file"), 0);
});
