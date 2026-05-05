// Watchfire local server.
// - Watches ~/.claude/orchestrator/sessions/*.json
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "web");
const STATE_DIR = path.join(os.homedir(), ".claude", "orchestrator", "sessions");
const PORT = Number(process.env.PORT) || 4173;

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => { buf += c; });
    req.on("end", () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

async function handleRequest(req, res) {
  if (req.method === "POST" && req.url === "/focus") {
    let body = {};
    try { body = await readBody(req); } catch {}
    // Prefer the user-set name (set via /rename — Claude pushes that to the
    // terminal title). Fallback to the last cwd segment ("23738",
    // "self-replication", …) — usually present in default WT tab titles.
    const lastCwd = body.cwd ? String(body.cwd).split("/").filter(Boolean).pop() : "";
    const tabName = body.name || lastCwd || "";
    const result = await focusWindowsTerminal(tabName);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(result));
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
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}

const server = http.createServer(handleRequest);

// --- WebSocket: push session state to browser ------------------------------

const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on("connection", async (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  // Send full snapshot on connect
  const snapshot = await readAllSessions();
  ws.send(JSON.stringify({ type: "snapshot", sessions: snapshot }));
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
  // Claude transcripts carry user-set names via /rename. Codex transcripts
  // don't have an analogous concept (as of CLI 0.117), so for codex we just
  // fall through to the last_prompt fallback below.
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
  // Fallback: short prefix of the last user prompt
  const p = (session.last_prompt || "").trim().replace(/\s+/g, " ");
  if (p) return p.slice(0, 30) + (p.length > 30 ? "…" : "");
  return "";
}

// --- Per-directory chat listing --------------------------------------------
//
// Claude Code stores each project's transcripts under
//   ~/.claude/projects/<flattened-cwd>/<session-id>.jsonl
// where <flattened-cwd> is the cwd path with `/` replaced by `-`. The folder
// name preserves the original case, but our session state files have a
// lowercased cwd (codex normalizes drive paths), so we match the directory
// case-insensitively.
//
// For each transcript we extract a custom title (from `/rename`) and the
// first user prompt — the same metadata Claude shows in its session list.

const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");

async function listChatsForCwd(cwd) {
  if (!cwd) return [];
  const targetKey = cwd.replace(/\//g, "-").toLowerCase();
  let entries;
  try {
    entries = await fs.readdir(CLAUDE_PROJECTS, { withFileTypes: true });
  } catch {
    return [];
  }
  const dir = entries.find(e => e.isDirectory() && e.name.toLowerCase() === targetKey);
  if (!dir) return [];
  const projDir = path.join(CLAUDE_PROJECTS, dir.name);
  let files;
  try {
    files = (await fs.readdir(projDir)).filter(f => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  // Read mtime + metadata for each transcript. Cap the result so very busy
  // projects don't return hundreds of entries.
  const out = await Promise.all(files.map(async (f) => {
    const fp = path.join(projDir, f);
    let stat;
    try { stat = await fs.stat(fp); } catch { return null; }
    const meta = await extractTranscriptMeta(fp);
    return {
      session_id: f.replace(/\.jsonl$/, ""),
      cwd,
      agent: "claude",
      name: meta.name || "",
      first_prompt: meta.first_prompt || "",
      last_modified: stat.mtimeMs,
    };
  }));
  return out
    .filter(Boolean)
    .sort((a, b) => b.last_modified - a.last_modified)
    .slice(0, 50);
}

async function extractTranscriptMeta(filePath) {
  let raw;
  try { raw = await fs.readFile(filePath, "utf-8"); } catch { return {}; }
  let custom = "";
  let firstPrompt = "";
  for (const line of raw.split("\n")) {
    if (!line || line[0] !== "{") continue;
    if (line.includes('"custom-title"')) {
      try { const o = JSON.parse(line); if (o.customTitle) custom = o.customTitle; } catch {}
    }
    if (!firstPrompt && line.includes('"user"')) {
      try {
        const o = JSON.parse(line);
        if (o.type === "user") {
          const m = o.message || {};
          if (typeof m.content === "string") firstPrompt = m.content;
          else if (Array.isArray(m.content)) {
            const t = m.content.find(b => b && b.type === "text");
            if (t) firstPrompt = t.text || "";
          }
        }
      } catch {}
    }
    if (custom && firstPrompt) break;
  }
  return { name: custom, first_prompt: firstPrompt.slice(0, 200) };
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

// --- Stale-session pruning -------------------------------------------------
//
// State files persist across reboots, but the Claude/Codex CLI processes that
// own them don't — every WSL process dies on shutdown without firing a Stop
// hook. Result: after a reboot the widget keeps showing yesterday's sessions
// forever. We use the kernel boot time as a hard cutoff: any state file
// whose last_event_at predates the current boot is by definition orphaned,
// because the process that wrote it can't possibly still exist.

function getSystemBootTimeSec() {
  try {
    const stat = fssync.readFileSync("/proc/stat", "utf-8");
    const m = stat.match(/^btime\s+(\d+)/m);
    if (m) return Number(m[1]);
  } catch { /* not Linux, or /proc/stat unreadable */ }
  return 0;
}

async function prunePreBootSessions() {
  const boot = getSystemBootTimeSec();
  if (!boot) return;
  fssync.mkdirSync(STATE_DIR, { recursive: true });
  let removed = 0;
  for (const f of (await fs.readdir(STATE_DIR)).filter(f => f.endsWith(".json"))) {
    const fp = path.join(STATE_DIR, f);
    try {
      const s = JSON.parse(await fs.readFile(fp, "utf-8"));
      if ((s.last_event_at || 0) < boot) {
        await fs.unlink(fp);
        removed++;
      }
    } catch { /* unreadable / malformed — leave it */ }
  }
  if (removed) console.log(`pruned ${removed} pre-boot session(s)`);
}

// Liveness check for a recorded session PID. /proc/<pid>/cmdline existing
// means *some* process has that pid; we additionally require it to look
// like a claude/codex CLI to defend against PID reuse (a long-dead session
// whose pid was recycled into an unrelated bash, for example).
function isClaudeProcessAlive(pid) {
  if (!pid) return null;   // unknown — caller should leave the file alone
  try {
    const cmd = fssync.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    return cmd.includes("claude") || cmd.includes("codex") || cmd.includes("node");
  } catch {
    return false;          // ENOENT → process is gone
  }
}

// Periodic sweep — catches sessions whose terminal was closed without a
// Stop hook firing (e.g. user closes the WT tab, kills the shell, etc).
async function pruneOrphanedSessions() {
  let removed = 0;
  const files = (await fs.readdir(STATE_DIR).catch(() => []))
    .filter(f => f.endsWith(".json"));
  for (const f of files) {
    const fp = path.join(STATE_DIR, f);
    try {
      const s = JSON.parse(await fs.readFile(fp, "utf-8"));
      // Skip files that predate the pid-tracking change (no pid field).
      if (!s.pid) continue;
      if (isClaudeProcessAlive(s.pid) === false) {
        await fs.unlink(fp);
        removed++;
      }
    } catch { /* ignore */ }
  }
  if (removed) console.log(`pruned ${removed} orphan session(s)`);
}

// --- Start -----------------------------------------------------------------

await prunePreBootSessions();
await pruneOrphanedSessions();
// Re-check every 5 minutes so closed-but-not-rebooted sessions disappear
// without needing a server restart.
setInterval(() => { pruneOrphanedSessions().catch(() => {}); }, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`watchfire: http://localhost:${PORT}`);
  console.log(`watching: ${STATE_DIR}`);
});
