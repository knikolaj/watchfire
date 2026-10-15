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
