// Watchfire — stale-session pruning.
//
// Two strategies, each with a different signal of "this session can't
// possibly still be alive":
//   • prePruneBoot — last_event_at predates the kernel boot time, so
//     the writing process certainly died at shutdown. Runs once at
//     server startup. Linux-only via /proc/stat.
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

/** Delete state files whose `last_event_at` is older than the kernel
 *  boot time. Returns the number of files removed. */
export async function prePruneBoot(stateDir, opts = {}) {
  const bootTime = opts.bootTime ?? getSystemBootTimeSec();
  if (!bootTime) return 0;
  fssync.mkdirSync(stateDir, { recursive: true });
  let removed = 0;
  const files = (await fs.readdir(stateDir)).filter(f => f.endsWith(".json"));
  for (const f of files) {
    const fp = path.join(stateDir, f);
    try {
      const s = JSON.parse(await fs.readFile(fp, "utf-8"));
      if ((s.last_event_at || 0) < bootTime) {
        await fs.unlink(fp);
        removed++;
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
  let removed = 0;
  const files = (await fs.readdir(stateDir).catch(() => []))
    .filter(f => f.endsWith(".json"));
  for (const f of files) {
    const fp = path.join(stateDir, f);
    try {
      const s = JSON.parse(await fs.readFile(fp, "utf-8"));
      if (!s.pid) continue;
      if (isAlive(s.pid) === false) {
        await fs.unlink(fp);
        removed++;
      }
    } catch { /* ignore */ }
  }
  return removed;
}
