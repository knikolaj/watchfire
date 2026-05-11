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

// Mirror of MODEL_LIMITS in hooks/emit_state.py. Used when a Claude
// transcript carries `usage` but no explicit context_limit (the
// model_context_window field is codex-only). Longest-prefix match so
// claude-opus-4-7 wins over claude-opus-4.
const MODEL_LIMITS = {
  "claude-opus-4-7":   1_000_000,
  "claude-opus-4-6":   1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5":    200_000,
  "claude-opus-4":       200_000,
  "claude-sonnet-4":     200_000,
  "gpt-5":               400_000,
};
const MODEL_KEYS_BY_LEN = Object.keys(MODEL_LIMITS).sort((a, b) => b.length - a.length);

export function modelLimit(model) {
  if (!model) return 200_000;
  for (const k of MODEL_KEYS_BY_LEN) if (model.startsWith(k)) return MODEL_LIMITS[k];
  return 200_000;
}

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

/** Every transcript from every project. Used by the history tab — the
 *  "what have I ever done with these agents" view, independent of which
 *  sessions are currently running.
 *
 *  Returns at most `limit` chats sorted by last_modified desc. Each entry
 *  carries `{ session_id, cwd, agent, name, first_prompt, last_modified }`
 *  so the client can group/sort however it wants. */
export async function listAllChats(opts = {}) {
  const limit = opts.limit ?? 500;
  const [claude, codex] = await Promise.all([
    listAllClaudeChats(opts),
    listAllCodexChats(opts),
  ]);
  return [...claude, ...codex]
    .sort((a, b) => b.last_modified - a.last_modified)
    .slice(0, limit);
}

async function listAllClaudeChats(opts = {}) {
  const claudeDir = opts.claudeDir ?? DEFAULT_CLAUDE_PROJECTS;
  let entries;
  try {
    entries = await fs.readdir(claudeDir, { withFileTypes: true });
  } catch {
    return [];
  }
  // Skip cron-sandbox projects (daily-summary, fireflies-sync). They're
  // the same kind of background runs the hook filters at runtime — they
  // shouldn't bloat the history either.
  const projDirs = entries.filter(e => e.isDirectory()
    && !e.name.includes("claude-daily-summary")
    && !e.name.includes("claude-meeting-summaries"));
  const out = [];
  for (const dir of projDirs) {
    // Reverse-flattening the dir name is ambiguous (claude flattens both
    // `/` and `-` into `-`). Fall back to it only if the transcript itself
    // doesn't carry the cwd inside its records.
    const fallbackCwd = "/" + dir.name.replace(/^-/, "").replace(/-/g, "/");
    const projDir = path.join(claudeDir, dir.name);
    let files;
    try {
      files = (await fs.readdir(projDir)).filter(f => f.endsWith(".jsonl"));
    } catch { continue; }
    for (const f of files) {
      const fp = path.join(projDir, f);
      let stat;
      try { stat = await fs.stat(fp); } catch { continue; }
      const meta = await extractClaudeTranscriptMeta(fp);
      const cwd = (meta.cwd || fallbackCwd).toLowerCase();
      const row = {
        session_id: f.replace(/\.jsonl$/, ""),
        cwd,
        agent: "claude",
        name: meta.name || "",
        first_prompt: meta.first_prompt || "",
        last_modified: stat.mtimeMs,
      };
      if (meta.context_tokens != null && meta.context_limit) {
        row.context_tokens = meta.context_tokens;
        row.context_limit  = meta.context_limit;
      }
      out.push(row);
    }
  }
  return out;
}

async function listAllCodexChats(opts = {}) {
  const idx = await buildCodexIndex(opts);
  const out = [];
  for (const chats of idx.values()) {
    for (const c of chats) {
      out.push({ ...c, cwd: c.cwd.toLowerCase() });
    }
  }
  return out;
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
  let cwd = "";
  // Context % comes from the LAST assistant message's `usage` block
  // (= what the model just had in its window). Track the most recent we
  // see; can't break early because we want the freshest one.
  let lastUsage = null;
  let lastModel = "";
  for (const line of raw.split("\n")) {
    if (!line || line[0] !== "{") continue;
    if (line.includes('"custom-title"')) {
      try { const o = JSON.parse(line); if (o.customTitle) custom = o.customTitle; } catch {}
    }
    if (!firstPrompt && line.includes('"user"')) {
      try {
        const o = JSON.parse(line);
        if (o.type === "user") {
          // user entries carry the cwd directly — reliable source of truth,
          // since reverse-flattening the project dir name loses the
          // distinction between `/` and `-`.
          if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
          const m = o.message || {};
          if (typeof m.content === "string") firstPrompt = m.content;
          else if (Array.isArray(m.content)) {
            const t = m.content.find(b => b && b.type === "text");
            if (t) firstPrompt = t.text || "";
          }
        }
      } catch {}
    }
    if (line.includes('"usage"')) {
      try {
        const o = JSON.parse(line);
        const msg = o.message || {};
        if (o.type === "assistant" && msg.usage) {
          lastUsage = msg.usage;
          if (msg.model) lastModel = msg.model;
        }
      } catch {}
    }
  }
  const out = { name: custom, first_prompt: firstPrompt.slice(0, 200), cwd };
  if (lastUsage) {
    out.context_tokens =
        (Number(lastUsage.input_tokens) || 0)
      + (Number(lastUsage.cache_creation_input_tokens) || 0)
      + (Number(lastUsage.cache_read_input_tokens) || 0);
    out.context_limit = modelLimit(lastModel);
  }
  return out;
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
  let lastTokenInfo = null;        // last event_msg.token_count.info we see
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
      // Track token_count for context %. Can't break early — we want the
      // LAST one (current context fullness), so scan to end.
      if (line.includes('"token_count"')) {
        try {
          const o = JSON.parse(line);
          if (o.type === "event_msg" && o.payload && o.payload.type === "token_count" && o.payload.info) {
            lastTokenInfo = o.payload.info;
          }
        } catch {}
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (!cwd) return null;
  const out = {
    session_id,
    cwd,
    agent: "codex",
    name: "",
    first_prompt: firstPrompt.slice(0, 200),
    last_modified: stat.mtimeMs,
  };
  if (lastTokenInfo) {
    const used = lastTokenInfo.last_token_usage?.input_tokens;
    const limit = lastTokenInfo.model_context_window;
    if (used != null && limit) {
      out.context_tokens = Number(used);
      out.context_limit = Number(limit);
    }
  }
  return out;
}
