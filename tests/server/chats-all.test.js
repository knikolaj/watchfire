// listAllChats — the data source for the history tab.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { listAllChats } from "../../server/chats.js";

async function tmpDir(label) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `wf-${label}-`));
}

async function writeJsonl(filePath, lines) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}

function freshCache() { return { built: 0, byCwd: new Map() }; }

// Hermetic codexDir — empty tmp dir so the default ~/.codex/sessions never
// leaks real fixtures into tests.
async function emptyCodexDir() { return await tmpDir("ca-codex-empty"); }

test("listAllChats merges claude + codex from all cwds", async () => {
  const claudeDir = await tmpDir("ca-claude");
  const codexDir  = await tmpDir("ca-codex");

  // Claude project with one chat, embedding its real cwd in a user record.
  await writeJsonl(
    path.join(claudeDir, "-proj-a", "session-1.jsonl"),
    [{ type: "user", cwd: "/proj/A", message: { content: "hi from A" } }],
  );
  // Codex chat under date tree.
  await writeJsonl(
    path.join(codexDir, "2026", "01", "01",
              "rollout-019dffff-ffff-7fff-ffff-ffffffffffff.jsonl"),
    [{ type: "session_meta", payload: { cwd: "/proj/B" } },
     { type: "event_msg", payload: { type: "user_message", message: "hi from B" } }],
  );

  const out = await listAllChats({
    claudeDir, codexDir, codexCache: freshCache(),
  });
  assert.equal(out.length, 2);
  const agents = out.map(x => x.agent).sort();
  assert.deepEqual(agents, ["claude", "codex"]);
});

test("listAllChats reads cwd from the claude transcript itself, not the flattened dir name", async () => {
  // Reverse-flattening `-home-nj-projects-palisade-self-replication` to a
  // path loses the hyphen vs slash distinction. The transcript's `cwd`
  // field is the source of truth — `self-replication` (one segment), not
  // `self/replication` (two).
  const claudeDir = await tmpDir("ca-claude-cwd");
  await writeJsonl(
    path.join(claudeDir, "-home-nj-projects-palisade-self-replication", "s.jsonl"),
    [{ type: "user", cwd: "/home/nj/projects/palisade/self-replication",
       message: { content: "x" } }],
  );
  const out = await listAllChats({ claudeDir, codexDir: await emptyCodexDir(), codexCache: freshCache() });
  assert.equal(out.length, 1);
  assert.equal(out[0].cwd, "/home/nj/projects/palisade/self-replication");
});

test("listAllChats falls back to reverse-flattened name when transcript has no cwd field", async () => {
  // claude -p --no-session-persistence doesn't write a cwd to the
  // transcript. We must still place the chat somewhere — best-effort
  // reverse, even if hyphens get mistaken for path separators.
  const claudeDir = await tmpDir("ca-claude-noembed");
  await writeJsonl(
    path.join(claudeDir, "-tmp-thing", "s.jsonl"),
    [{ type: "permission-mode" }],
  );
  const out = await listAllChats({ claudeDir, codexDir: await emptyCodexDir(), codexCache: freshCache() });
  assert.equal(out.length, 1);
  assert.equal(out[0].cwd, "/tmp/thing");   // ambiguous, but predictable
});

test("listAllChats skips cron-sandbox project dirs (daily-summary, meeting-summaries)", async () => {
  const claudeDir = await tmpDir("ca-claude-cron");
  // Two cron-sandbox dirs and one real one.
  for (const dir of [
    "-home-nj--claude-daily-summary-2026-05",
    "-home-nj--claude-meeting-summaries-2026-05",
    "-home-nj-projects-real",
  ]) {
    await writeJsonl(
      path.join(claudeDir, dir, "s.jsonl"),
      [{ type: "user", cwd: "/whatever", message: { content: "x" } }],
    );
  }
  const out = await listAllChats({ claudeDir, codexDir: await emptyCodexDir(), codexCache: freshCache() });
  // Only the real project's chat should survive.
  assert.equal(out.length, 1);
});

test("listAllChats sorts by last_modified desc and respects opts.limit", async () => {
  const claudeDir = await tmpDir("ca-limit");
  // Three chats with explicit mtimes — we control the order.
  const writeOne = async (name, mtimeSec) => {
    const fp = path.join(claudeDir, "-p", `${name}.jsonl`);
    await writeJsonl(fp, [{ type: "user", cwd: "/p", message: { content: "x" } }]);
    await fs.utimes(fp, mtimeSec, mtimeSec);
  };
  await writeOne("oldest",  1_000_000_000);
  await writeOne("middle",  1_500_000_000);
  await writeOne("newest",  2_000_000_000);

  const all = await listAllChats({ claudeDir, codexDir: await emptyCodexDir(), codexCache: freshCache() });
  assert.deepEqual(all.map(x => x.session_id), ["newest", "middle", "oldest"]);

  const top2 = await listAllChats({ claudeDir, codexDir: await emptyCodexDir(), codexCache: freshCache(), limit: 2 });
  assert.deepEqual(top2.map(x => x.session_id), ["newest", "middle"]);
});
