// Watchfire — resume a past session inside herdr (a terminal multiplexer for
// agents) instead of a bare Windows Terminal tab, so it lands in herdr's
// sidebar and comes back after a herdr restart.
//
// Driven entirely through the `herdr` CLI, which talks to the running herdr
// server over its socket and prints JSON. A session opens as a new tab in the
// workspace already showing its project (matched by pane cwd, then by label);
// with none, a new workspace is created for it.
//
// `herdr pane run` types its arguments into the pane's shell as one line,
// without quoting. Only the agent name and a UUID-validated session id go
// through it; cwd and label travel as separate argv entries of `tab create` /
// `workspace create`, which never reach a shell.

import { execFile } from "node:child_process";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";

/** Path of the herdr binary. The systemd unit's PATH is minimal and herdr
 *  installs per user into ~/.local/bin, so look there as well. */
export function herdrBin(env = process.env, exists = fssync.existsSync) {
  if (env.HERDR_BIN) return env.HERDR_BIN;
  const dirs = [...String(env.PATH || "").split(":").filter(Boolean),
    path.join(os.homedir(), ".local", "bin")];
  for (const d of dirs) {
    const p = path.join(d, "herdr");
    if (exists(p)) return p;
  }
  return null;
}

function _exec(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      // Some commands (`pane run`) answer with nothing at all on success.
      if (!stdout.trim()) return resolve({});
      try { resolve(JSON.parse(stdout).result ?? {}); }
      catch { reject(new Error(`unexpected herdr output: ${stdout.slice(0, 200)}`)); }
    });
  });
}

/** Switch herdr to the pane holding an agent (its workspace and tab too). */
export async function focusInHerdr(paneId, opts = {}) {
  const bin = opts.bin !== undefined ? opts.bin : herdrBin();
  const exec = opts.exec ?? _exec;
  if (!bin) return { ok: false, err: "herdr_not_installed" };
  try {
    await exec(bin, ["agent", "focus", paneId]);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: "herdr_failed", msg: e.message };
  }
}

/** Agents herdr sees in its panes; [] if herdr is absent or not running. */
export async function listHerdrAgents(opts = {}) {
  const bin = opts.bin !== undefined ? opts.bin : herdrBin();
  const exec = opts.exec ?? _exec;
  if (!bin) return [];
  try { return (await exec(bin, ["agent", "list"])).agents ?? []; }
  catch { return []; }
}

/** Panes herdr has right now: [{ pane_id, ... }]; [] if herdr isn't there. */
export async function listHerdrPanes(opts = {}) {
  const bin = opts.bin !== undefined ? opts.bin : herdrBin();
  const exec = opts.exec ?? _exec;
  if (!bin) return [];
  try { return (await exec(bin, ["pane", "list"])).panes ?? []; }
  catch { return []; }
}

/** Pids of the foreground processes in a herdr pane, as herdr reports them.
 *  Unlike HERDR_PANE_ID in a process's environment — fixed at launch — this
 *  follows the pane when it is moved and gets a new id. */
export async function herdrPanePids(paneId, opts = {}) {
  const bin = opts.bin !== undefined ? opts.bin : herdrBin();
  const exec = opts.exec ?? _exec;
  if (!bin) return [];
  try {
    const info = (await exec(bin, ["pane", "process-info", "--pane", paneId])).process_info ?? {};
    return (info.foreground_processes ?? []).map(p => p.pid).filter(Number.isInteger);
  } catch { return []; }
}

/** Sessions placed by the processes in each pane: a Claude CLI pid from its
 *  registry, or a client whose command line names a session id (`codex
 *  resume <id>`). panePids: Map pane -> [pid]; returns Map session_id -> pane. */
export function placeByPanePids(open, panePids, cmdlineOf) {
  const byPid = new Map(open.filter(s => s.pid).map(s => [s.pid, s.session_id]));
  const ids = new Set(open.map(s => s.session_id));
  const out = new Map();
  for (const [pane, pids] of panePids) {
    for (const pid of pids) {
      let sid = byPid.get(pid);
      if (!sid) {
        const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(cmdlineOf(pid) || "");
        if (m && ids.has(m[0])) sid = m[0];
      }
      if (sid) out.set(sid, pane);
    }
  }
  return out;
}

/** Pairing from the session id in the pane title: with `[tui] terminal_title`
 *  including "thread-id", Codex puts the id into its title, and it follows
 *  /new and /resume inside the tab. Codex cuts it to its first 29 characters
 *  plus "...", so match by prefix — 29 characters of a UUID are unique among
 *  open sessions in practice; an ambiguous prefix is skipped.
 *  Returns Map session_id -> pane. */
export function matchPanesByThreadId(sessionIds, agents) {
  const out = new Map();
  for (const a of agents) {
    if (a.agent !== "codex") continue;
    const title = String(a.terminal_title_stripped || a.terminal_title || "");
    for (const m of title.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f-]{4,17}/g)) {
      const hits = sessionIds.filter(id => id.startsWith(m[0]));
      if (hits.length === 1) out.set(hits[0], a.pane_id);
    }
  }
  return out;
}

/** Tie open Codex sessions to herdr panes by the pane title. A fresh `codex`
 *  carries no session id that would link its pane to its session (the id
 *  lives in the app-server daemon, outside any pane), but Codex titles its
 *  terminal "<thread name> | <model>" and herdr reports that title. Matched on
 *  name + folder, and only when the pairing is one-to-one — two same-named
 *  sessions in one project stay unmarked rather than guessed.
 *  sessions: [{ session_id, agent, cwd, name }]; returns Map session_id -> pane. */
export function matchPanesByTitle(sessions, agents) {
  const titled = (title, name) => title === name || title.startsWith(`${name} | `);
  const pairs = [];
  for (const a of agents) {
    if (a.agent !== "codex") continue;
    const title = String(a.terminal_title_stripped || a.terminal_title || "").trim();
    if (!title) continue;
    for (const s of sessions) {
      if (s.agent !== "codex" || !s.name) continue;
      if (s.cwd !== a.cwd && s.cwd !== a.foreground_cwd) continue;
      if (titled(title, s.name)) pairs.push([s.session_id, a.pane_id]);
    }
  }
  const count = (i, v) => pairs.filter(p => p[i] === v).length;
  return new Map(pairs.filter(([sid, pane]) => count(0, sid) === 1 && count(1, pane) === 1));
}

/** The workspace to open `cwd` in: the one with a pane already in that
 *  directory, else the one labelled with the directory's name. null = none. */
export function pickWorkspace(workspaces, panes, cwd) {
  if (!cwd) return null;
  const known = new Set(workspaces.map(w => w.workspace_id));
  const byPane = panes.find(p => known.has(p.workspace_id)
    && (p.foreground_cwd === cwd || p.cwd === cwd));
  if (byPane) return byPane.workspace_id;
  const base = path.basename(cwd);
  const byLabel = workspaces.find(w => w.label === base);
  return byLabel ? byLabel.workspace_id : null;
}

/** Open `claude --resume <id>` / `codex resume <id>` in a new herdr tab.
 *  Caller validates sessionId as a UUID. Resolves { ok, pane_id } or
 *  { ok: false, err }. */
export async function resumeInHerdr({ agent, cwd, sessionId, name }, opts = {}) {
  const bin = opts.bin !== undefined ? opts.bin : herdrBin();
  const exec = opts.exec ?? _exec;
  if (!bin) return { ok: false, err: "herdr_not_installed" };
  try {
    const { workspaces = [] } = await exec(bin, ["workspace", "list"]);
    const { panes = [] } = await exec(bin, ["pane", "list"]);
    const wsId = pickWorkspace(workspaces, panes, cwd);
    const where = cwd ? ["--cwd", cwd] : [];
    let created;
    if (wsId) {
      created = await exec(bin, ["tab", "create", "--workspace", wsId, ...where,
        ...(name ? ["--label", name] : []), "--focus"]);
      await exec(bin, ["workspace", "focus", wsId]);
    } else {
      created = await exec(bin, ["workspace", "create", ...where,
        "--label", cwd ? path.basename(cwd) : "watchfire", "--focus"]);
      // A new workspace's first tab is just "1"; name it after the session,
      // like the tabs added to an existing workspace. Cosmetic — never fatal.
      const tabId = created.tab?.tab_id ?? created.root_pane?.tab_id;
      if (name && tabId) await exec(bin, ["tab", "rename", tabId, name]).catch(() => {});
    }
    const paneId = created.root_pane?.pane_id;
    if (!paneId) return { ok: false, err: "no_pane_created" };
    const cmd = agent === "codex" ? ["codex", "resume", sessionId] : ["claude", "--resume", sessionId];
    await exec(bin, ["pane", "run", paneId, ...cmd]);
    return { ok: true, pane_id: paneId };
  } catch (e) {
    return { ok: false, err: "herdr_failed", msg: e.message };
  }
}
