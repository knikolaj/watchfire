// Optional user config (~/.watchfire/config.json) + cwdRemap for resume.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { loadConfig, remapCwd } from "../../server/config.js";

async function tmpFile(label, contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `wf-${label}-`));
  const fp = path.join(dir, "config.json");
  await fs.writeFile(fp, contents);
  return fp;
}

test("loadConfig returns {} for a missing file", () => {
  assert.deepEqual(loadConfig("/no/such/config.json"), {});
});

test("loadConfig returns {} for malformed json", async () => {
  const fp = await tmpFile("cfg-bad", "{ not json");
  assert.deepEqual(loadConfig(fp), {});
});

test("loadConfig parses a valid config", async () => {
  const fp = await tmpFile("cfg-ok", JSON.stringify({ cwdRemap: { "/a": "/b" } }));
  assert.deepEqual(loadConfig(fp), { cwdRemap: { "/a": "/b" } });
});

const CFG = { cwdRemap: { "/mnt/c/Users/Old": "/home/u/chats" } };

test("remapCwd maps an exact match", () => {
  assert.equal(remapCwd("/mnt/c/Users/Old", CFG), "/home/u/chats");
});

test("remapCwd is case-insensitive on the drive prefix", () => {
  // watchfire lowercases the WSL drive; resume sends true-case — both must map.
  assert.equal(remapCwd("/mnt/c/users/old", CFG), "/home/u/chats");
});

test("remapCwd preserves a sub-path under the mapped folder", () => {
  assert.equal(remapCwd("/mnt/c/Users/Old/sub/dir", CFG), "/home/u/chats/sub/dir");
});

test("remapCwd leaves unmapped paths unchanged", () => {
  assert.equal(remapCwd("/home/u/projects/thing", CFG),
    "/home/u/projects/thing");
  // A folder that merely shares a name prefix but isn't the same segment.
  assert.equal(remapCwd("/mnt/c/Users/Old0", CFG), "/mnt/c/Users/Old0");
});

test("remapCwd is a no-op with no config / no cwdRemap", () => {
  assert.equal(remapCwd("/mnt/c/Users/Old", {}), "/mnt/c/Users/Old");
  assert.equal(remapCwd("/x", { cwdRemap: null }), "/x");
});

test("remapCwd longest key wins", () => {
  const cfg = { cwdRemap: { "/mnt/c": "/A", "/mnt/c/Users/Old": "/B" } };
  assert.equal(remapCwd("/mnt/c/Users/Old/x", cfg), "/B/x");
  assert.equal(remapCwd("/mnt/c/other", cfg), "/A/other");
});
