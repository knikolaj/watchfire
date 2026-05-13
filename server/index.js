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

import { listChatsForCwd, listAllChats } from "./chats.js";
import { prePruneBoot, pruneOrphanedSessions } from "./prune.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "web");
const STATE_DIR = path.join(os.homedir(), ".watchfire", "sessions");
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
  if (req.method === "GET" && req.url.startsWith("/chats-all")) {
    const url = new URL(req.url, "http://x");
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit")) || 500));
    const list = await listAllChats({ limit });
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

const removedBoot = await prePruneBoot(STATE_DIR);
if (removedBoot) console.log(`pruned ${removedBoot} pre-boot session(s)`);
const removedOrphans = await pruneOrphanedSessions(STATE_DIR);
if (removedOrphans) console.log(`pruned ${removedOrphans} orphan session(s)`);
// Re-check every 5 minutes so closed-but-not-rebooted sessions disappear
// without needing a server restart.
setInterval(async () => {
  const r = await pruneOrphanedSessions(STATE_DIR).catch(() => 0);
  if (r) console.log(`pruned ${r} orphan session(s)`);
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`watchfire: http://localhost:${PORT}`);
  console.log(`watching: ${STATE_DIR}`);
});
