// Watchfire — optional user config, read from ~/.watchfire/config.json
// (override the path with $WATCHFIRE_CONFIG, mainly for tests).
//
// Nothing here is required; a missing or malformed file just means "no
// config". The only field so far is `cwdRemap`: a map of old working
// directory -> new one, applied when RESUMING a past session so a chat that
// originally ran in a now-abandoned folder re-opens in its new home instead.
// Resume is global-by-session-id (Claude finds the session regardless of cwd,
// Codex stores sessions centrally), so the cwd only decides where the resumed
// session operates — safe to redirect.
//
// This keeps personal paths OUT of the repo: the code is generic, the actual
// mapping lives in the user's own ~/.watchfire/config.json. Example:
//   { "cwdRemap": { "/mnt/c/Users/<you>": "/home/<you>/chats" } }

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function configPath() {
  return process.env.WATCHFIRE_CONFIG
    || path.join(os.homedir(), ".watchfire", "config.json");
}

/** Load and parse the config. Returns {} on any missing/unreadable/invalid
 *  file — config is always optional. */
export function loadConfig(file = configPath()) {
  let raw;
  try { raw = fs.readFileSync(file, "utf-8"); } catch { return {}; }
  try {
    const c = JSON.parse(raw);
    return (c && typeof c === "object") ? c : {};
  } catch { return {}; }
}

/** Apply cwdRemap to a working directory. A remap key matches when `cwd`
 *  equals it or sits under it (prefix + "/"), compared case-insensitively so
 *  the WSL drive case (/mnt/c/Users vs /mnt/c/users) doesn't matter. The
 *  matched prefix is swapped for the target; any sub-path is preserved.
 *  Unmapped cwds pass through unchanged. The longest matching key wins. */
export function remapCwd(cwd, config = loadConfig()) {
  const map = config && config.cwdRemap;
  if (!cwd || !map || typeof map !== "object") return cwd;
  const lc = cwd.toLowerCase();
  let best = null;
  for (const [from, to] of Object.entries(map)) {
    if (typeof to !== "string" || !from) continue;
    const f = from.toLowerCase();
    if (lc === f || lc.startsWith(f.replace(/\/+$/, "") + "/")) {
      if (!best || from.length > best.from.length) best = { from, to };
    }
  }
  if (!best) return cwd;
  const rest = cwd.slice(best.from.replace(/\/+$/, "").length); // includes leading "/" or ""
  return best.to.replace(/\/+$/, "") + rest;
}
