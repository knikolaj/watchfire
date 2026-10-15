// Watchfire — self-check: is every live interactive session on the widget?
//
// The widget only knows what hooks/emit_state.py wrote, so a session whose
// hook never fired (or whose state file was pruned by mistake) is silently
// absent. This compares the state dir against two sources the hook has no
// part in:
//   • Claude Code's own registry — ~/.claude/sessions/<pid>.json, one file per
//     running CLI, naming the session it currently shows;
//   • the rollout files a running `codex` process holds open — one per session
//     it is serving.
// It only reports; nothing is created or deleted here.
//
// Dependencies (registry reader, /proc readers) come in through opts so tests
// run without a real /proc.

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";

// A session this young may simply not have had its first hook land yet.
const START_GRACE_MS = 2 * 60 * 1000;
const CODEX_INTERACTIVE_ORIGINATORS = new Set(["codex-tui", "codex_cli_rs"]);
const ROLLOUT_RE = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

function _listClaudeRegistry(dir = path.join(os.homedir(), ".claude", "sessions")) {
  let names;
  try { names = fssync.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try { out.push(JSON.parse(fssync.readFileSync(path.join(dir, n), "utf-8"))); }
    catch { /* half-written or foreign file */ }
  }
  return out;
}

/** Start time of `pid` in clock ticks since boot (field 22 of /proc/<pid>/stat),
 *  as a string; null if the process is gone. Pids get reused, so "the pid
 *  exists" is not proof the registry entry is still that process — the start
 *  time is. */
function _procStartOf(pid) {
  try {
    const stat = fssync.readFileSync(`/proc/${pid}/stat`, "utf-8");
    // comm (field 2) may contain spaces and parentheses; count from the last ")".
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}

/** Rollout files held open by any running `codex` process. */
function _listCodexRollouts() {
  const out = new Set();
  let pids;
  try { pids = fssync.readdirSync("/proc").filter(n => /^\d+$/.test(n)); } catch { return []; }
  for (const pid of pids) {
    try {
      if (fssync.readFileSync(`/proc/${pid}/comm`, "utf-8").trim() !== "codex") continue;
      for (const fd of fssync.readdirSync(`/proc/${pid}/fd`)) {
        try {
          const target = fssync.readlinkSync(`/proc/${pid}/fd/${fd}`);
          if (ROLLOUT_RE.test(target)) out.add(target);
        } catch { /* fd closed meanwhile */ }
      }
    } catch { /* process exited, or not ours to read */ }
  }
  return [...out];
}

/** { originator, source, cwd } from a rollout's first line (session_meta). */
function _readRolloutMeta(file) {
  try {
    const fd = fssync.openSync(file, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fssync.readSync(fd, buf, 0, buf.length, 0);
      const first = buf.toString("utf-8", 0, n).split("\n")[0];
      const p = JSON.parse(first).payload || {};
      return { originator: p.originator, source: p.source, cwd: p.cwd };
    } finally { fssync.closeSync(fd); }
  } catch { return null; }
}

/** HERDR_PANE_ID from a process's environment: set when it runs inside a
 *  herdr pane. null otherwise, or if the process is gone. */
function _herdrPaneOf(pid) {
  try {
    const env = fssync.readFileSync(`/proc/${pid}/environ`, "utf-8").split("\0");
    const kv = env.find(v => v.startsWith("HERDR_PANE_ID="));
    return kv ? kv.slice("HERDR_PANE_ID=".length) || null : null;
  } catch { return null; }
}

const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/;

/** Codex terminal clients (`codex`, `codex resume <id>`) — not the
 *  app-server host, which serves every tab and lives in no pane. */
function _listCodexClients() {
  const out = [];
  let pids;
  try { pids = fssync.readdirSync("/proc").filter(n => /^\d+$/.test(n)); } catch { return []; }
  for (const pid of pids) {
    try {
      if (fssync.readFileSync(`/proc/${pid}/comm`, "utf-8").trim() !== "codex") continue;
      const cmdline = fssync.readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").join(" ");
      if (!cmdline.includes("app-server")) out.push({ pid: Number(pid), cmdline });
    } catch { /* exited */ }
  }
  return out;
}

/** Every session some agent process has open right now, whether or not its
 *  hook has fired — Codex fires no hook on `resume` until the first message,
 *  so the state dir alone misses a freshly resumed session. Each entry says
 *  which herdr pane holds it, if any: [{ session_id, herdr_pane_id }].
 *  A Codex session started fresh (no id on its command line) can't be tied to
 *  its pane this way; it is listed without one. */
export function listOpenSessions(opts = {}) {
  const listClaudeRegistry = opts.listClaudeRegistry ?? _listClaudeRegistry;
  const procStartOf = opts.procStartOf ?? _procStartOf;
  const listCodexRollouts = opts.listCodexRollouts ?? _listCodexRollouts;
  const listCodexClients = opts.listCodexClients ?? _listCodexClients;
  const herdrPaneOf = opts.herdrPaneOf ?? _herdrPaneOf;
  const open = new Map();   // session_id -> herdr pane id | null
  const rollouts = new Map();   // codex session_id -> its rollout file
  const pids = new Map();       // claude session_id -> its CLI pid
  for (const e of listClaudeRegistry()) {
    if (e && e.pid && e.sessionId && e.procStart
        && procStartOf(e.pid) === String(e.procStart)) {
      open.set(e.sessionId, herdrPaneOf(e.pid));
      pids.set(e.sessionId, e.pid);
    }
  }
  for (const file of listCodexRollouts()) {
    const m = ROLLOUT_RE.exec(file);
    if (m) rollouts.set(m[1], file);
    if (m && !open.has(m[1])) open.set(m[1], null);
  }
  for (const c of listCodexClients()) {
    const m = UUID_RE.exec(c.cmdline);
    const pane = m && herdrPaneOf(c.pid);
    if (m && pane && open.has(m[1])) open.set(m[1], pane);
  }
  return [...open].map(([session_id, herdr_pane_id]) => ({
    session_id, herdr_pane_id,
    ...(rollouts.has(session_id) ? { rollout: rollouts.get(session_id) } : {}),
    ...(pids.has(session_id) ? { pid: pids.get(session_id) } : {}),
  }));
}

/** Live interactive sessions that have no state file. Returns
 *  { live, unseen: [{ agent, session_id, cwd, pid? }] } where `live` is how
 *  many sessions were checked. */
export async function findUnseenSessions(stateDir, opts = {}) {
  const listClaudeRegistry = opts.listClaudeRegistry ?? _listClaudeRegistry;
  const procStartOf = opts.procStartOf ?? _procStartOf;
  const listCodexRollouts = opts.listCodexRollouts ?? _listCodexRollouts;
  const readRolloutMeta = opts.readRolloutMeta ?? _readRolloutMeta;
  const now = opts.now ?? Date.now();

  const shown = new Set(
    (await fs.readdir(stateDir).catch(() => []))
      .filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)));
  const unseen = [];
  let live = 0;

  for (const e of listClaudeRegistry()) {
    if (!e || !e.pid || !e.sessionId || !e.procStart) continue;
    // Headless runs are kept off the widget on purpose (see emit_state.py).
    if (e.kind && e.kind !== "interactive") continue;
    if (String(e.entrypoint || "").startsWith("sdk")) continue;
    if (procStartOf(e.pid) !== String(e.procStart)) continue;   // stale entry
    if (now - (e.startedAt || 0) < START_GRACE_MS) continue;
    live++;
    if (!shown.has(e.sessionId)) {
      unseen.push({ agent: "claude", session_id: e.sessionId, cwd: e.cwd || "", pid: e.pid });
    }
  }

  for (const file of listCodexRollouts()) {
    const m = ROLLOUT_RE.exec(file);
    if (!m) continue;
    const meta = readRolloutMeta(file);
    if (!meta) continue;
    // Same rule as the widget's isServiceSession: sub-agent threads and
    // tool-started sessions are not the user's tabs.
    if (meta.source && typeof meta.source === "object") continue;
    if (meta.source === "subagent") continue;
    if (meta.originator && !CODEX_INTERACTIVE_ORIGINATORS.has(meta.originator)) continue;
    live++;
    if (!shown.has(m[1])) unseen.push({ agent: "codex", session_id: m[1], cwd: meta.cwd || "" });
  }

  return { live, unseen };
}
