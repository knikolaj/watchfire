// Watchfire — per-cwd chat listing.
//
// Walks both Claude (~/.claude/projects/<flattened-cwd>/*.jsonl) and
// Codex (~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl) transcript
// stores, returning a unified list for any cwd. Codex has no per-cwd
// flattening so we keep a 30-second in-memory index of cwd→transcripts;
// the index lookup is a Map.get, the rebuild is a recursive walk.
//
// Every function takes optional `opts.claudeDir` / `opts.codexDir` /
// `opts.codexCache` / `opts.codexTtlMs` so tests can point at tmp dirs
// and provide a fresh cache instead of mucking with the module-level
// default. Production callers leave them empty.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createReadStream } from "node:fs";
import readline from "node:readline";

const DEFAULT_CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");
const DEFAULT_CODEX_SESSIONS  = path.join(os.homedir(), ".codex",  "sessions");
export const CODEX_INDEX_TTL_MS = 30_000;

// Module-level cache used by production. Tests pass their own.
const _defaultCodexCache = { built: 0, byCwd: new Map() };

export async function listChatsForCwd(cwd, opts = {}) {
  if (!cwd) return [];
  const [claude, codex] = await Promise.all([
    listClaudeChatsForCwd(cwd, opts),
    listCodexChatsForCwd(cwd, opts),
  ]);
  return [...claude, ...codex]
    .sort((a, b) => b.last_modified - a.last_modified)
    .slice(0, 50);
}

export async function listClaudeChatsForCwd(cwd, opts = {}) {
  const claudeDir = opts.claudeDir ?? DEFAULT_CLAUDE_PROJECTS;
  const targetKey = cwd.replace(/\//g, "-").toLowerCase();
  let entries;
  try {
    entries = await fs.readdir(claudeDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dir = entries.find(e => e.isDirectory() && e.name.toLowerCase() === targetKey);
  if (!dir) return [];
  const projDir = path.join(claudeDir, dir.name);
  let files;
  try {
    files = (await fs.readdir(projDir)).filter(f => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out = await Promise.all(files.map(async (f) => {
    const fp = path.join(projDir, f);
    let stat;
    try { stat = await fs.stat(fp); } catch { return null; }
    const meta = await extractClaudeTranscriptMeta(fp);
    return {
      session_id: f.replace(/\.jsonl$/, ""),
      cwd,
      agent: "claude",
      name: meta.name || "",
      first_prompt: meta.first_prompt || "",
      last_modified: stat.mtimeMs,
    };
  }));
  return out.filter(Boolean);
}

export async function listCodexChatsForCwd(cwd, opts = {}) {
  const idx = await buildCodexIndex(opts);
  return idx.get(cwd.toLowerCase()) || [];
}

export async function buildCodexIndex(opts = {}) {
  const codexDir = opts.codexDir ?? DEFAULT_CODEX_SESSIONS;
  const cache    = opts.codexCache ?? _defaultCodexCache;
  const ttl      = opts.codexTtlMs ?? CODEX_INDEX_TTL_MS;
  if (cache.built && Date.now() - cache.built < ttl) return cache.byCwd;

  const byCwd = new Map();
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        const meta = await extractCodexTranscriptMeta(p);
        if (!meta || !meta.cwd) continue;
        const key = meta.cwd.toLowerCase();
        if (!byCwd.has(key)) byCwd.set(key, []);
        byCwd.get(key).push(meta);
      }
    }
  }
  await walk(codexDir);
  cache.built = Date.now();
  cache.byCwd = byCwd;
  return byCwd;
}

export async function extractClaudeTranscriptMeta(filePath) {
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

export async function extractCodexTranscriptMeta(filePath) {
  // session_id from filename: rollout-…-<UUID>.jsonl. Anchor to UUID
  // format so greedy [0-9a-f-]+ doesn't snag the timestamp prefix
  // ("16-43-37-…").
  const m = path.basename(filePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  );
  if (!m) return null;
  const session_id = m[1];

  let stat;
  try { stat = await fs.stat(filePath); } catch { return null; }

  // Stream line-by-line — session_meta carries the full Codex system
  // prompt and easily exceeds 64KB, so a fixed-byte slice would chop it
  // mid-string and break JSON.parse.
  let cwd = "";
  let firstPrompt = "";
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || line[0] !== "{") continue;
      if (!cwd && line.includes('"session_meta"')) {
        try {
          const o = JSON.parse(line);
          if (o.type === "session_meta" && o.payload && o.payload.cwd) {
            cwd = String(o.payload.cwd).trim();
          }
        } catch {}
      }
      // Older Codex versions stashed cwd inside the env-context user msg.
      if (!cwd && line.includes("<cwd>")) {
        const cm = line.match(/<cwd>([^<]+)<\/cwd>/);
        if (cm) cwd = cm[1].trim();
      }
      if (!firstPrompt && line.includes('"user_message"')) {
        try {
          const o = JSON.parse(line);
          if (o.type === "event_msg" && o.payload && o.payload.type === "user_message") {
            firstPrompt = (o.payload.message || "").trim();
          }
        } catch {}
      }
      if (cwd && firstPrompt) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (!cwd) return null;
  return {
    session_id,
    cwd,
    agent: "codex",
    name: "",
    first_prompt: firstPrompt.slice(0, 200),
    last_modified: stat.mtimeMs,
  };
}
