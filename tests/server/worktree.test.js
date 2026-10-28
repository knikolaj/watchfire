// A linked git worktree maps back to its main checkout; anything else -> null.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { worktreeRoot } from "../../server/worktree.js";

test("worktreeRoot: linked worktree (and a subfolder of it) -> main checkout", () => {
  const files = { "/w/foo-t35/.git": "gitdir: /p/foo/.git/worktrees/foo-t35\n" };
  const read = (p) => (p in files ? files[p] : undefined);
  assert.equal(worktreeRoot("/w/foo-t35", read), "/p/foo");
  assert.equal(worktreeRoot("/w/foo-t35/src/lib", read), "/p/foo");
});

test("worktreeRoot: normal repo, submodule, no repo -> null", () => {
  const files = {
    "/p/foo/.git": null,                                       // a .git directory
    "/p/foo/sub/.git": "gitdir: ../.git/modules/sub\n",        // submodule, not a worktree
  };
  const read = (p) => (p in files ? files[p] : undefined);
  assert.equal(worktreeRoot("/p/foo", read), null);
  assert.equal(worktreeRoot("/p/foo/sub", read), null);
  assert.equal(worktreeRoot("/elsewhere", read), null);
  assert.equal(worktreeRoot("", read), null);
  assert.equal(worktreeRoot("relative/path", read), null);
});

test("worktreeRoot reads a real .git file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-wt-"));
  await fs.writeFile(path.join(dir, ".git"), "gitdir: /home/u/projects/x/.git/worktrees/x-t1\n");
  assert.equal(worktreeRoot(dir), "/home/u/projects/x");
});

test("scratchpadParentCwd: a task in a Claude session's scratchpad belongs to that session's project", async () => {
  const { scratchpadParentCwd } = await import("../../server/worktree.js");
  const id = "d00645fd-cf9a-4ba9-a3d3-822d209767dc";
  const cwd = `/tmp/claude-1000/-home-u-projects-home-assistant/${id}/scratchpad`;
  const files = {
    [`/s/${id}.json`]: JSON.stringify({ cwd: "/home/u/projects/home-assistant" }),
  };
  const opts = { stateDir: "/s", projectsDir: "/c", readFile: (p) => files[p] ?? null };
  assert.equal(scratchpadParentCwd(cwd, opts), "/home/u/projects/home-assistant", "from the state file");
  assert.equal(scratchpadParentCwd(`${cwd}/sub`, opts), "/home/u/projects/home-assistant", "deeper inside");

  // No state file: fall back to the parent's transcript.
  const tr = { [`/c/-home-u-projects-home-assistant/${id}.jsonl`]:
    `{"type":"x"}\n{"cwd":"/home/u/projects/home-assistant","type":"user"}\n` };
  assert.equal(scratchpadParentCwd(cwd, { stateDir: "/s", projectsDir: "/c", readFile: (p) => tr[p] ?? null }),
    "/home/u/projects/home-assistant", "from the transcript");

  assert.equal(scratchpadParentCwd("/home/u/projects/x", opts), null, "ordinary folder");
  assert.equal(scratchpadParentCwd(cwd, { stateDir: "/s", projectsDir: "/c", readFile: () => null }), null, "parent unknown");
});
