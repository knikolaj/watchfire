// Watchfire — which project does a git worktree belong to?
//
// Tools that run agents in parallel (e.g. Codex companion tasks) give each
// task its own git worktree, often outside the project (~/worktrees/foo-t35).
// Grouped by cwd, every worktree shows up as a separate "project". A linked
// worktree's `.git` is a file — "gitdir: <main>/.git/worktrees/<name>" — so
// the main checkout is one read away.

import fssync from "node:fs";
import path from "node:path";
import os from "node:os";

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

// Claude Code gives each session a scratch folder,
//   <tmp>/claude-<uid>/<encoded project>/<session uuid>/scratchpad
// and tasks it hands off (e.g. a Codex review) often run there. The parent
// session's id is right in the path, so its folder is the project.
const SCRATCHPAD_RE = /\/claude-\d+\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/scratchpad(?:\/|$)/;
const parentCache = new Map();   // parent session id -> its cwd | null

/** Folder of the Claude session whose scratchpad holds `cwd`; null otherwise.
 *  Looks at the parent's watchfire state file, then its transcript. */
export function scratchpadParentCwd(cwd, opts = {}) {
  const m = SCRATCHPAD_RE.exec(cwd || "");
  if (!m) return null;
  const id = m[1];
  const useCache = !opts.readFile;
  if (useCache && parentCache.has(id)) return parentCache.get(id);
  const read = opts.readFile ?? ((p) => { try { return fssync.readFileSync(p, "utf-8"); } catch { return null; } });
  const stateDir = opts.stateDir ?? path.join(os.homedir(), ".watchfire", "sessions");
  const projectsDir = opts.projectsDir ?? path.join(os.homedir(), ".claude", "projects");
  let parent = null;
  try { parent = JSON.parse(read(path.join(stateDir, `${id}.json`)) || "null")?.cwd || null; } catch {}
  if (!parent) {
    // <projects>/<encoded>/<id>.jsonl — the encoded dir is the path segment
    // right before the id; its lines carry "cwd".
    const encoded = cwd.slice(0, m.index + m[0].length).split("/").slice(-3)[0];
    const text = read(path.join(projectsDir, encoded, `${id}.jsonl`)) || "";
    const c = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text.slice(0, 200_000));
    if (c) { try { parent = JSON.parse(`"${c[1]}"`); } catch {} }
  }
  if (useCache && parent) parentCache.set(id, parent);
  return parent;
}

/** The project a session's folder belongs to when it isn't the folder
 *  itself: a git worktree's main checkout, or the folder of the Claude
 *  session whose scratchpad it runs in. null when the folder is its own. */
export function projectRootOf(cwd) {
  return worktreeRoot(cwd) || scratchpadParentCwd(cwd);
}
