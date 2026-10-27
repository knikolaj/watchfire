// Watchfire — which project does a git worktree belong to?
//
// Tools that run agents in parallel (e.g. Codex companion tasks) give each
// task its own git worktree, often outside the project (~/worktrees/foo-t35).
// Grouped by cwd, every worktree shows up as a separate "project". A linked
// worktree's `.git` is a file — "gitdir: <main>/.git/worktrees/<name>" — so
// the main checkout is one read away.

import fssync from "node:fs";
import path from "node:path";

const cache = new Map();   // cwd -> project root | null

/** Main checkout of the worktree containing `cwd`; null when `cwd` is not in a
 *  linked worktree (a normal repo, no repo, or unreadable). */
export function worktreeRoot(cwd, readGitFile = _readGitFile) {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  if (cache.has(cwd) && readGitFile === _readGitFile) return cache.get(cwd);
  let root = null;
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    const git = readGitFile(path.join(dir, ".git"));
    if (git !== undefined) {   // found the nearest .git (file or directory)
      const m = /^gitdir:\s*(.+?)\/\.git\/worktrees\/[^/\n]+\s*$/m.exec(git || "");
      root = m ? m[1] : null;
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (readGitFile === _readGitFile) cache.set(cwd, root);
  return root;
}

/** Contents of a `.git` file; null for a `.git` directory; undefined if absent. */
function _readGitFile(p) {
  try {
    const st = fssync.statSync(p);
    return st.isDirectory() ? null : fssync.readFileSync(p, "utf-8");
  } catch { return undefined; }
}
