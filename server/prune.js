// Watchfire — stale-session pruning.
//
// Two strategies, each with a different signal of "this session can't
// possibly still be alive":
//   • prePruneBoot — the state file was written during an earlier boot,
//     so the writing process certainly died at shutdown. Runs once at
//     server startup. Linux-only via /proc.
//   • pruneOrphanedSessions — recorded pid is gone (or has been
//     recycled into something that isn't a claude/codex CLI). Runs
//     every 5 minutes from the server, plus once at startup.
//
// Functions take their dependencies (boot time, liveness check, fs
// readers) as opts so tests can supply a tmp state dir + a fake liveness
// function without touching /proc.

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";

export function getSystemBootTimeSec(procStatPath = "/proc/stat") {
  try {
    const stat = fssync.readFileSync(procStatPath, "utf-8");
    const m = stat.match(/^btime\s+(\d+)/m);
    if (m) return Number(m[1]);
  } catch { /* not Linux, or /proc/stat unreadable */ }
  return 0;
}

/** Identity of the current boot: a random id the kernel generates at start-up.
 *  Unlike btime it does not move while the machine sleeps. */
export function getBootId(bootIdPath = "/proc/sys/kernel/random/boot_id") {
  try { return fssync.readFileSync(bootIdPath, "utf-8").trim(); }
  catch { return ""; }
}

/** Liveness check for a recorded session PID. Returns:
 *  - true  → process exists and looks like a claude/codex CLI
 *  - false → process is gone, OR pid is reused by something unrelated
 *  - null  → no pid was passed (caller should treat the file as legacy
 *            and leave it alone)
 *  Defaults to /proc/<pid>/cmdline; tests can inject `readCmdline`. */
export function isClaudeProcessAlive(pid, readCmdline = _defaultReadCmdline) {
  if (!pid) return null;
  const cmd = readCmdline(pid);
  if (cmd === null) return false;
  return cmd.includes("claude") || cmd.includes("codex") || cmd.includes("node");
}

function _defaultReadCmdline(pid) {
  try { return fssync.readFileSync(`/proc/${pid}/cmdline`, "utf-8"); }
  catch { return null; }
}

/** Is `pid` a host that serves *several* agent sessions at once? Codex can run
 *  every session inside one `codex app-server` daemon — the terminal tabs are
 *  thin clients — so the hook, walking up from itself, records the daemon's pid
 *  for all of them. For such a pid, "one pid = one tab" no longer holds. */
export function isSessionHost(pid, readCmdline = _defaultReadCmdline) {
  const cmd = pid ? readCmdline(pid) : null;
  return !!cmd && cmd.includes("app-server");
}

/** Does `pid` hold `file` open? A session host keeps the rollout of every
 *  session it is serving open, which is the per-session liveness signal a
 *  shared, always-alive pid can't give. */
export function holdsFileOpen(pid, file, readFdTargets = _defaultReadFdTargets) {
  if (!pid || !file) return false;
  return readFdTargets(pid).includes(file);
}

function _defaultReadFdTargets(pid) {
  try {
    const dir = `/proc/${pid}/fd`;
    return fssync.readdirSync(dir).map(fd => {
      try { return fssync.readlinkSync(`${dir}/${fd}`); } catch { return ""; }
    });
  } catch { return []; }
}

// Codex creates a session's rollout only with its first turn (observed: session
// start 02:13:01, rollout born 02:13:22 with task_started), so a fresh tab has
// nothing open yet. Give it a minute: an untouched new tab drops off the widget
// after that and comes back with its first message — a fair trade for closed
// tabs disappearing promptly.
const HOST_SESSION_GRACE_SEC = 60;

/** Delete state files left over from an earlier boot. Returns the number of
 *  files removed.
 *
 *  The hook stamps each state file with the kernel's boot id; a different id
 *  means a different boot. Comparing `last_event_at` with btime — the old
 *  rule, still used for files without a stamp — is not safe on its own: under
 *  WSL btime is derived from a clock that stops while the host sleeps, so it
 *  creeps forward by every nap, and a server restart then deleted live
 *  sessions that had merely been quiet since before the "boot". */
export async function prePruneBoot(stateDir, opts = {}) {
  const bootTime = opts.bootTime ?? getSystemBootTimeSec();
  const bootId = opts.bootId ?? getBootId();
  const onRemove = opts.onRemove ?? (() => {});
  if (!bootTime && !bootId) return 0;
  fssync.mkdirSync(stateDir, { recursive: true });
  let removed = 0;
  const files = (await fs.readdir(stateDir)).filter(f => f.endsWith(".json"));
  for (const f of files) {
    const fp = path.join(stateDir, f);
    try {
      const s = JSON.parse(await fs.readFile(fp, "utf-8"));
      const stale = s.boot_id && bootId
        ? s.boot_id !== bootId
        : !!bootTime && (s.last_event_at || 0) < bootTime;
      if (stale) {
        await fs.unlink(fp);
        removed++;
        onRemove(s, "written before this boot");
      }
    } catch { /* unreadable / malformed — leave it */ }
  }
  return removed;
}

/** Delete state files whose recorded pid is dead (or has been reused
 *  by a non-agent process). Files without a `pid` field are skipped —
 *  prePruneBoot covers those at startup. Returns the number removed. */
export async function pruneOrphanedSessions(stateDir, opts = {}) {
  const isAlive = opts.isAlive ?? isClaudeProcessAlive;
  const isHost = opts.isHost ?? isSessionHost;
  const holdsOpen = opts.holdsOpen ?? holdsFileOpen;
  const now = opts.now ?? Date.now() / 1000;
  const onRemove = opts.onRemove ?? (() => {});
  const cwdExists = opts.cwdExists ?? ((p) => fssync.existsSync(p));
  let removed = 0;
  const files = (await fs.readdir(stateDir).catch(() => []))
    .filter(f => f.endsWith(".json"));
  for (const f of files) {
    const fp = path.join(stateDir, f);
    try {
      const s = JSON.parse(await fs.readFile(fp, "utf-8"));
      if (!s.pid) continue;
      const alive = isAlive(s.pid);
      // A session host outlives the tabs it serves; the session is gone once
      // the host no longer holds its rollout open (past the start-up grace).
      const closedOnHost = alive !== false && isHost(s.pid)
        && now - (s.last_event_at || 0) > HOST_SESSION_GRACE_SEC
        && !holdsOpen(s.pid, s.transcript_path);
      // Its folder is gone — typically a finished task whose git worktree was
      // removed. Nothing to go back to (resume needs the folder), yet a
      // Codex host can keep the thread loaded for hours. Never while it is
      // still working or waiting for you.
      const folderGone = s.cwd && path.isAbsolute(s.cwd) && !cwdExists(s.cwd)
        && s.status !== "working" && s.status !== "waiting_input";
      if (alive === false || closedOnHost || folderGone) {
        await fs.unlink(fp);
        removed++;
        onRemove(s, alive === false
          ? `process ${s.pid} is gone`
          : closedOnHost ? `host ${s.pid} no longer holds its transcript open`
          : `its folder ${s.cwd} no longer exists`);
      }
    } catch { /* ignore */ }
  }
  return removed;
}

/** Delete state files that have been *superseded on their terminal*: when
 *  several state files share the same pid, only the most-recently-active one
 *  is the session currently running in that tab — the others are abandoned.
 *
 *  This is what `claude /resume` leaves behind: the resume-picker starts a
 *  throwaway nameless session (SessionStart -> idle), then the picked session
 *  continues under a NEW session_id on the SAME pid. The stub's pid stays
 *  alive (same process), so pruneOrphanedSessions never removes it, and the
 *  widget shows a phantom nameless row per resume. One tab = one live session,
 *  so keep the freshest per pid and drop the rest. Returns the number removed.
 *
 *  Exception: a session host (see isSessionHost) legitimately carries many
 *  sessions on one pid — pruning those groups deleted every Codex session but
 *  the freshest. Their lifetime is handled by pruneOrphanedSessions instead. */
export async function pruneSupersededSessions(stateDir, opts = {}) {
  const isHost = opts.isHost ?? isSessionHost;
  const onRemove = opts.onRemove ?? (() => {});
  const files = (await fs.readdir(stateDir).catch(() => []))
    .filter(f => f.endsWith(".json"));
  // Group readable state files by pid.
  const byPid = new Map();
  for (const f of files) {
    const fp = path.join(stateDir, f);
    try {
      const s = JSON.parse(await fs.readFile(fp, "utf-8"));
      if (!s.pid) continue;
      (byPid.get(s.pid) ?? byPid.set(s.pid, []).get(s.pid)).push({ fp, s, at: s.last_event_at || 0 });
    } catch { /* unreadable — leave it */ }
  }
  let removed = 0;
  for (const [pid, group] of byPid) {
    if (group.length < 2) continue;
    // Several live sessions on one session host is normal, not a stale stub.
    if (isHost(pid)) continue;
    // Keep the freshest by last_event_at; delete the older siblings.
    group.sort((a, b) => b.at - a.at);
    for (const { fp, s } of group.slice(1)) {
      try {
        await fs.unlink(fp);
        removed++;
        onRemove(s, `superseded by a newer session on process ${pid}`);
      } catch { /* ignore */ }
    }
  }
  return removed;
}
