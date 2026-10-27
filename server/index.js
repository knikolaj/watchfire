// Watchfire local server.
// - Watches ~/.watchfire/sessions/*.json
// - Serves the static web/ directory
// - Pushes session state changes to browser clients over WebSocket
//
// No build step. Run with: npm install && npm start

import http from "node:http";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import { WebSocketServer } from "ws";

import { listChatsForCwd, listAllChats, extractCodexTranscriptMeta } from "./chats.js";
import { prePruneBoot, pruneOrphanedSessions, pruneSupersededSessions } from "./prune.js";
import { findUnseenSessions, listOpenSessions } from "./audit.js";
import { worktreeRoot } from "./worktree.js";
import {
  resumeInHerdr, focusInHerdr, listHerdrAgents, listHerdrPanes, herdrPanePids,
  placeByPanePids, matchPanesByTitle, matchPanesByThreadId,
} from "./herdr.js";
import { remapCwd } from "./config.js";
import { HOST, isAllowedRequest, isValidSessionId } from "./guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "web");
const STATE_DIR = path.join(os.homedir(), ".watchfire", "sessions");
const PORT = Number(process.env.PORT) || 4173;

// Every line of server.log carries local wall-clock time — without it "why did
// that session vanish yesterday evening" cannot be answered from the log.
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
for (const level of ["log", "error"]) {
  const orig = console[level].bind(console);
  console[level] = (...args) => orig(`[${stamp()}]`, ...args);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".wav":  "audio/wav",
};

// --- Static file server + JSON endpoints -----------------------------------

const FOCUS_SCRIPT = path.join(__dirname, "focus_window.ps1");
const RESUME_SCRIPT = path.join(__dirname, "..", "scripts", "resume_session.sh");

function focusWindowsTerminal(tabName) {
  return new Promise((resolve) => {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", FOCUS_SCRIPT];
    if (tabName) args.push("-TabName", tabName);
    const ps = spawn("powershell.exe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    ps.stdout.on("data", (d) => { out += d.toString(); });
    ps.on("error", () => resolve({ ok: false, err: "spawn_failed" }));
    ps.on("close", (code) => resolve({ ok: code === 0, out: out.trim(), code }));
  });
}

// Re-open a past session in a fresh Windows Terminal tab: wt launches a WSL
// login shell that runs resume_session.sh, which cd's to the session's cwd and
// exec's `claude --resume <id>` / `codex resume <id>`. agent/cwd/id go through
// as positional args — the only multi-word token wt sees is the fixed
// `exec "$0" "$@"`, so paths/ids are never re-parsed by a shell. That does not
// cover wt.exe itself, which splits its command line on `;`: cwd and name are
// base64 for that reason, and the id is gated to a strict UUID in /resume.
function resumeSession({ agent, cwd, sessionId, name }) {
  return new Promise((resolve) => {
    // wt drops quoting around sub-command args, so a value with spaces (a cwd
    // like "C:\Users\John Doe", a session name like "Fable Health") would split
    // into multiple args. base64 the free-text values — no spaces/quotes to
    // mangle — and let the helper decode them.
    const b64 = (s) => Buffer.from(String(s || ""), "utf8").toString("base64");
    const tail = [
      "nt", "wsl.exe", "-e", "bash", "-lic",
      'exec "$0" "$@"', RESUME_SCRIPT, agent, b64(cwd), sessionId, b64(name),
    ];

    // A clean spawn says nothing about whether a tab actually opened: wt.exe
    // hands the command to a running Terminal and exits, so it can fail *after*
    // spawning and we'd never know. Treating spawn as success is why a failed
    // resume looks like the click doing nothing at all. Watch the exit code and
    // log the output instead.
    const run = (args) => new Promise((done) => {
      const p = spawn("wt.exe", args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
      let out = "", settled = false;
      const finish = (r) => { if (!settled) { settled = true; done(r); } };
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { out += d; });
      p.on("error", (e) => finish({ ok: false, err: "spawn_failed", msg: e.message }));
      p.on("close", (code) => finish(
        code === 0 ? { ok: true } : { ok: false, err: `wt_exit_${code}`, msg: out.trim() }));
      // With no Terminal window open, wt.exe *becomes* the new window and never
      // exits — that is success, not a hang, so stop waiting and report ok.
      setTimeout(() => { p.unref(); finish({ ok: true }); }, 3000);
    });

    // -w last: add a tab to the most-recently-used Terminal window instead of
    // spawning a fresh one. If that fails — nothing to attach to, or Terminal
    // refuses the hand-off — fall back to letting wt open its own window.
    run(["-w", "last", ...tail]).then(async (r) => {
      if (r.ok) return resolve({ ok: true });
      console.error(`[resume] wt -w last failed (${r.err})${r.msg ? `: ${r.msg}` : ""} — retrying in a new window`);
      const f = await run(tail);
      if (!f.ok) console.error(`[resume] fallback failed (${f.err})${f.msg ? `: ${f.msg}` : ""}`);
      resolve(f.ok ? { ok: true } : { ok: false, err: f.err });
    });
  });
}

async function readState(id) {
  try { return JSON.parse(await fs.readFile(path.join(STATE_DIR, `${id}.json`), "utf-8")); }
  catch { return null; }
}

// Name + folder of a Codex session straight from its rollout, for sessions the
// hook hasn't reported yet (Codex fires none on `resume` until the first
// message). Rollouts run to tens of MB, so cache by path + mtime.
const rolloutMetaCache = new Map();   // path -> { mtimeMs, meta }
async function rolloutMeta(file) {
  let st;
  try { st = await fs.stat(file); } catch { return null; }
  const hit = rolloutMetaCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.meta;
  const meta = await extractCodexTranscriptMeta(file).catch(() => null);
  rolloutMetaCache.set(file, { mtimeMs: st.mtimeMs, meta });
  return meta;
}

/** listOpenSessions, plus herdr panes found by title for Codex sessions the
 *  process check couldn't place (a fresh `codex` — see matchPanesByTitle). */
function cmdlineOf(pid) {
  try { return fssync.readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").join(" "); }
  catch { return ""; }
}

async function openSessionsWithHerdr() {
  const open = listOpenSessions();
  const panes = await listHerdrPanes();
  // HERDR_PANE_ID from a process's environment goes stale when its pane is
  // moved (the pane gets a new id); keep it only if that pane still exists.
  const paneIds = new Set(panes.map(p => p.pane_id));
  for (const s of open) if (s.herdr_pane_id && !paneIds.has(s.herdr_pane_id)) s.herdr_pane_id = null;
  if (!panes.length) return open;
  // Best signal: the processes herdr itself reports in each pane.
  const panePids = new Map(await Promise.all(
    panes.map(async p => [p.pane_id, await herdrPanePids(p.pane_id)])));
  const byPid = placeByPanePids(open, panePids, cmdlineOf);
  for (const s of open) if (byPid.has(s.session_id)) s.herdr_pane_id = byPid.get(s.session_id);

  let unplaced = open.filter(s => !s.herdr_pane_id);
  if (!unplaced.length) return open;
  const claimed = new Set(open.map(s => s.herdr_pane_id).filter(Boolean));
  let agents = (await listHerdrAgents()).filter(a => !claimed.has(a.pane_id));
  if (!agents.length) return open;
  // Exact first: the session id in the pane title (Codex "thread-id" title item).
  const exact = matchPanesByThreadId(unplaced.map(s => s.session_id), agents);
  for (const s of open) if (exact.has(s.session_id)) s.herdr_pane_id = exact.get(s.session_id);
  const taken = new Set(exact.values());
  agents = agents.filter(a => !taken.has(a.pane_id));
  unplaced = unplaced.filter(s => !exact.has(s.session_id));
  if (!agents.length || !unplaced.length) return open;
  // Fallback for tabs without the id in their title: name + folder.
  const meta = await Promise.all(unplaced.map(async (s) => {
    const st = await readState(s.session_id);
    if (st?.name || !s.rollout) return st;
    return (await rolloutMeta(s.rollout)) ?? st;
  }));
  const found = matchPanesByTitle(unplaced.map((s, i) => ({
    session_id: s.session_id, agent: meta[i]?.agent, cwd: meta[i]?.cwd, name: meta[i]?.name,
  })), agents);
  for (const s of open) if (found.has(s.session_id)) s.herdr_pane_id = found.get(s.session_id);
  return open;
}

/** The herdr pane holding session `id`, if any: what the running processes say,
 *  else what the hook recorded. */
async function herdrPaneFor(id) {
  if (!isValidSessionId(id)) return null;
  const open = (await openSessionsWithHerdr()).find(s => s.session_id === id);
  if (open?.herdr_pane_id) return open.herdr_pane_id;
  const s = await readState(id);
  return typeof s?.herdr_pane_id === "string" ? s.herdr_pane_id : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => { buf += c; });
    req.on("end", () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

async function handleRequest(req, res) {
  // Reject cross-site and DNS-rebinding requests before any handler runs —
  // see guard.js.
  if (!isAllowedRequest(req.headers, PORT)) {
    res.writeHead(403); return res.end("forbidden");
  }
  if (req.method === "POST" && req.url === "/focus") {
    let body = {};
    try { body = await readBody(req); } catch {}
    // Prefer the user-set name (set via /rename — Claude pushes that to the
    // terminal title). Fallback to the last cwd segment ("alice",
    // "my-project", …) — usually present in default WT tab titles.
    const lastCwd = body.cwd ? String(body.cwd).split("/").filter(Boolean).pop() : "";
    const tabName = body.name || lastCwd || "";
    // A session living in a herdr pane: switch herdr to that pane, then bring
    // its terminal window forward. Anything else: the Windows Terminal tab.
    const pane = await herdrPaneFor(String(body.session_id || ""));
    let result;
    if (pane) {
      result = await focusInHerdr(pane);
      if (result.ok) focusWindowsTerminal("herdr");
      else console.error(`[focus-herdr] ${body.session_id} pane ${pane}: ${result.err}${result.msg ? `: ${result.msg}` : ""}`);
    }
    if (!result || !result.ok) result = await focusWindowsTerminal(tabName);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(result));
  }
  if (req.method === "POST" && (req.url === "/resume" || req.url === "/resume-herdr")) {
    let body = {};
    try { body = await readBody(req); } catch {}
    const agent = body.agent === "codex" ? "codex" : "claude";
    const sessionId = String(body.session_id || "").trim();
    // Redirect the resume cwd via the user's optional cwdRemap (e.g. an old
    // general-chats folder that moved). Safe because resume finds the session
    // by id regardless of cwd; the cwd only sets where it re-opens.
    const cwd = remapCwd(String(body.cwd || "").trim());
    const name = String(body.name || "").trim();
    if (!sessionId) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, err: "missing session_id" }));
    }
    if (!isValidSessionId(sessionId)) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, err: "bad session_id" }));
    }
    let result;
    if (req.url === "/resume-herdr") {
      result = await resumeInHerdr({ agent, cwd, sessionId, name });
      if (result.ok) focusWindowsTerminal("");   // bring the terminal holding herdr forward
      else console.error(`[resume-herdr] ${sessionId}: ${result.err}${result.msg ? `: ${result.msg}` : ""}`);
    } else {
      result = await resumeSession({ agent, cwd, sessionId, name });
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(result));
  }
  if (req.method === "GET" && req.url === "/open-sessions") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(await openSessionsWithHerdr()));
  }
  if (req.method === "GET" && req.url.startsWith("/chats-all")) {
    const url = new URL(req.url, "http://x");
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit")) || 500));
    const list = (await listAllChats({ limit })).map(c => {
      const root = worktreeRoot(c.cwd_real || c.cwd);
      return root ? { ...c, project_root: root } : c;
    });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(list));
  }
  if (req.method === "GET" && req.url.startsWith("/chats")) {
    const url = new URL(req.url, "http://x");
    const cwd = url.searchParams.get("cwd") || "";
    const list = await listChatsForCwd(cwd);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(list));
  }
  // Static
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const safe = urlPath.replace(/\/+$/, "") || "/index.html";
  const filePath = path.join(WEB_DIR, safe === "/" ? "/index.html" : safe);
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403); return res.end("forbidden");
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
      // Edge --app windows cache aggressively; forbid caching outright so
      // every reload picks up fresh JS/CSS.
      "cache-control": "no-store, no-cache, must-revalidate",
      "pragma": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}

const server = http.createServer(handleRequest);

// --- WebSocket: push session state to browser ------------------------------

// verifyClient runs the same guard on the handshake: WebSockets are not covered
// by CORS, so without it any open tab could read the live session stream.
const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }) => isAllowedRequest(req.headers, PORT),
});
const clients = new Set();

wss.on("connection", async (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  // Send full snapshot on connect
  const snapshot = await readAllSessions();
  ws.send(JSON.stringify({ type: "snapshot", sessions: snapshot }));
  ws.send(JSON.stringify({ type: "audit", unseen: lastUnseen }));
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

// Codex lowercases the WSL drive path; Claude preserves case. Normalize both
// to lowercase /mnt/<drive>/<top> so they share a district.
function normalizeCwd(cwd) {
  if (!cwd || !cwd.startsWith("/mnt/")) return cwd;
  const parts = cwd.split("/");
  if (parts.length >= 4) {
    parts[2] = parts[2].toLowerCase();
    parts[3] = parts[3].toLowerCase();
    return parts.join("/");
  }
  return cwd;
}

async function readSessionFile(file) {
  try {
    const raw = await fs.readFile(file, "utf-8");
    const session = JSON.parse(raw);
    session.cwd = normalizeCwd(session.cwd);
    session.name = await resolveSessionName(session);
    // A git worktree is shown inside its project, not as a project of its own.
    const root = worktreeRoot(session.cwd);
    if (root) session.project_root = root;
    return session;
  } catch {
    return null;
  }
}

async function readAllSessions() {
  fssync.mkdirSync(STATE_DIR, { recursive: true });
  const files = (await fs.readdir(STATE_DIR)).filter(f => f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    const s = await readSessionFile(path.join(STATE_DIR, f));
    if (s) out.push(s);
  }
  return out;
}

// --- Session name resolution -----------------------------------------------
//
// Claude Code stores per-session metadata as JSONL lines in the transcript.
// User-set name (via `/rename`) appears as: {"type":"custom-title","customTitle":"..."}
// Auto-generated topic name appears as:    {"type":"agent-name","agentName":"..."}
// We take the last occurrence of either, preferring custom-title.
//
// Transcripts can grow large, so we cache by transcript path + mtime, and
// only re-parse when the file changes.

const nameCache = new Map();   // transcriptPath -> { mtimeMs, name }

async function resolveSessionName(session) {
  // An explicit name already on the state file is user intent — never
  // overwrite. The hook records customTitle (claude /rename) and
  // thread_name (codex /rename) here.
  if (session.name) return session.name;

  // For Claude only: also re-scan the transcript directly, in case the
  // state file is stale (e.g. /rename'd right after a hook event).
  const tp = session.transcript_path;
  if (tp && session.agent !== "codex") {
    let stat;
    try { stat = await fs.stat(tp); } catch { stat = null; }
    if (stat) {
      const cached = nameCache.get(tp);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.name) return cached.name;
      let name = "";
      try {
        const raw = await fs.readFile(tp, "utf-8");
        const lines = raw.split("\n");
        let custom = "", agent = "";
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          if (!line || line[0] !== "{") continue;
          if (!custom && line.includes('"custom-title"')) {
            try { const o = JSON.parse(line); if (o.customTitle) custom = o.customTitle; } catch {}
          }
          if (!agent && line.includes('"agent-name"')) {
            try { const o = JSON.parse(line); if (o.agentName) agent = o.agentName; } catch {}
          }
          if (custom && agent) break;
        }
        name = custom || agent || "";
      } catch {}
      nameCache.set(tp, { mtimeMs: stat.mtimeMs, name });
      if (name) return name;
    }
  }
  // Fallback chain: first_prompt is the closest analogue to a "session
  // title" (matches Claude UI's session list and the agent's mental model
  // of "what was I asked to do"). last_prompt is the very-fresh-session
  // fallback when first_prompt hasn't been extracted yet.
  const shorten = (s) => {
    const t = String(s || "").trim().replace(/\s+/g, " ");
    return t ? t.slice(0, 30) + (t.length > 30 ? "…" : "") : "";
  };
  return shorten(session.first_prompt) || shorten(session.last_prompt) || "";
}

// --- File watcher ----------------------------------------------------------
//
// chokidar v4 dropped glob support in `watch()` — must watch the directory
// directly and filter by extension here.

fssync.mkdirSync(STATE_DIR, { recursive: true });
const watcher = chokidar.watch(STATE_DIR, {
  ignoreInitial: true,
  depth: 0,
});

async function emitChange(file, kind) {
  if (!file.endsWith(".json")) return;
  const session = await readSessionFile(file);
  if (!session) return;
  console.log(`[${kind}] ${path.basename(file)} -> ${session.status}`);
  broadcast({ type: kind, session });
}

watcher
  .on("add",    (f) => emitChange(f, "session_added"))
  .on("change", (f) => emitChange(f, "session_changed"))
  .on("unlink", (f) => {
    if (!f.endsWith(".json")) return;
    const session_id = path.basename(f, ".json");
    console.log(`[session_removed] ${session_id}`);
    broadcast({ type: "session_removed", session_id });
  })
  .on("error", (err) => console.error("watcher error:", err));

// --- Start -----------------------------------------------------------------

// Say which session each prune removed and why, not just how many.
const logPrune = (kind) => (s, reason) =>
  console.log(`[prune:${kind}] ${s.agent || "?"} ${s.session_id} (${s.cwd || "?"}): ${reason}`);

await prePruneBoot(STATE_DIR, { onRemove: logPrune("boot") });
async function sweep() {
  await pruneOrphanedSessions(STATE_DIR, { onRemove: logPrune("orphan") }).catch(() => 0);
  await pruneSupersededSessions(STATE_DIR, { onRemove: logPrune("superseded") }).catch(() => 0);
}
await sweep();
// Re-check every 5 minutes so closed-but-not-rebooted sessions disappear
// without needing a server restart.
setInterval(sweep, 5 * 60 * 1000);

// Self-check, hourly: a live interactive session that is not on the widget is
// a bug somewhere between the agent's hook and here. Log it and let the widget
// show a warning mark (see server/audit.js).
let lastUnseen = [];
async function audit() {
  try {
    const { live, unseen } = await findUnseenSessions(STATE_DIR);
    for (const u of unseen) {
      console.log(`[audit] not shown: ${u.agent} ${u.session_id} (${u.cwd || "?"})${u.pid ? ` pid ${u.pid}` : ""}`);
    }
    if (!unseen.length) console.log(`[audit] ok: ${live} live session(s), all shown`);
    lastUnseen = unseen;
    broadcast({ type: "audit", unseen });
  } catch (err) {
    console.error("[audit] failed:", err.message);
  }
}
setTimeout(audit, 3 * 60 * 1000);   // after start-up, once the tabs are back
setInterval(audit, 60 * 60 * 1000);

// Loopback only: WSL still forwards it to Windows' localhost (NAT relay, or
// natively under mirrored networking), but nothing on the LAN can reach it.
server.listen(PORT, HOST, () => {
  console.log(`watchfire: http://localhost:${PORT}  (bound to ${HOST})`);
  console.log(`watching: ${STATE_DIR}`);
});
