// Watchfire — pure widget logic.
//
// Everything here is side-effect-free: takes plain JS values in, returns
// strings (HTML) or primitives. No DOM lookups, no network, no module-
// level mutable state. The thin DOM wiring lives in widget.js.
//
// Browser imports this directly (Edge --app loads it as ESM via
// `<script type="module">`). Node-side test runner imports the same
// file unchanged.

// --- Formatting helpers ----------------------------------------------------

export function shortPath(cwd) {
  if (!cwd) return "(unknown)";
  const parts = cwd.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}

export function fmtElapsed(seconds) {
  if (seconds < 60)        return `${Math.floor(seconds)}s`;
  if (seconds < 3600)      return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  if (seconds < 86_400)    return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function fmtLimit(n) {
  if (!n) return "";
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  return `${Math.round(n / 1000)}K`;
}

export function statusLabel(s) {
  return ({ working: "running", waiting_input: "waiting", done: "done", idle: "idle" })[s] || s;
}

export function pctClass(pct) {
  if (pct >= 80) return "danger";
  if (pct >= 50) return "warn";
  return "";
}

export function nameOrPrompt(s) {
  // Match Claude UI's session list: customTitle wins, else the FIRST prompt
  // (not the latest one — that's just the most recent message in the dialog).
  if (s.name) return s.name;
  const first = (s.first_prompt || "").trim();
  if (first) return first;
  const last = (s.last_prompt || "").trim();
  return last || (s.session_id || "").slice(0, 8);
}

export function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function escapeAttr(s) { return escape(s); }

// --- Grouping --------------------------------------------------------------

/** Group sessions by cwd. Returns [[cwd, list], ...] sorted by group's
 *  freshest session desc; lists inside are sorted by last_event_at desc. */
export function groupSessionsByCwd(sessionsArr) {
  const groups = new Map();
  for (const s of sessionsArr) {
    const k = s.cwd || "(unknown)";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => (b.last_event_at || 0) - (a.last_event_at || 0));
  }
  return [...groups.entries()].sort((a, b) =>
    (b[1][0]?.last_event_at || 0) - (a[1][0]?.last_event_at || 0));
}

// --- SVG marks (inlined) ---------------------------------------------------
// Anthropic / Claude — squiggle mark from uxwing.com (royalty-free).
export const SVG_ANTHROPIC = `
  <svg width="14" height="14" viewBox="0 0 512 509.64">
    <path fill="#fff" fill-rule="nonzero" d="M142.27 316.619l73.655-41.326 1.238-3.589-1.238-1.996-3.589-.001-12.31-.759-42.084-1.138-36.498-1.516-35.361-1.896-8.897-1.895-8.34-10.995.859-5.484 7.482-5.03 10.717.935 23.683 1.617 35.537 2.452 25.782 1.517 38.193 3.968h6.064l.86-2.451-2.073-1.517-1.618-1.517-36.776-24.922-39.81-26.338-20.852-15.166-11.273-7.683-5.687-7.204-2.451-15.721 10.237-11.273 13.75.935 3.513.936 13.928 10.716 29.749 23.027 38.848 28.612 5.687 4.727 2.275-1.617.278-1.138-2.553-4.271-21.13-38.193-22.546-38.848-10.035-16.101-2.654-9.655c-.935-3.968-1.617-7.304-1.617-11.374l11.652-15.823 6.445-2.073 15.545 2.073 6.547 5.687 9.655 22.092 15.646 34.78 24.265 47.291 7.103 14.028 3.791 12.992 1.416 3.968 2.449-.001v-2.275l1.997-26.641 3.69-32.707 3.589-42.084 1.239-11.854 5.863-14.206 11.652-7.683 9.099 4.348 7.482 10.716-1.036 6.926-4.449 28.915-8.72 45.294-5.687 30.331h3.313l3.792-3.791 15.342-20.372 25.782-32.227 11.374-12.789 13.27-14.129 8.517-6.724 16.1-.001 11.854 17.617-5.307 18.199-16.581 21.029-13.75 17.819-19.716 26.54-12.309 21.231 1.138 1.694 2.932-.278 44.536-9.479 24.062-4.347 28.714-4.928 12.992 6.066 1.416 6.167-5.106 12.613-30.71 7.583-36.018 7.204-53.636 12.689-.657.48.758.935 24.164 2.275 10.337.556h25.301l47.114 3.514 12.309 8.139 7.381 9.959-1.238 7.583-18.957 9.655-25.579-6.066-59.702-14.205-20.474-5.106-2.83-.001v1.694l17.061 16.682 31.266 28.233 39.152 36.397 1.997 8.999-5.03 7.102-5.307-.758-34.401-25.883-13.27-11.651-30.053-25.302-1.996-.001v2.654l6.926 10.136 36.574 54.975 1.895 16.859-2.653 5.485-9.479 3.311-10.414-1.895-21.408-30.054-22.092-33.844-17.819-30.331-2.173 1.238-10.515 113.261-4.929 5.788-11.374 4.348-9.478-7.204-5.03-11.652 5.03-23.027 6.066-30.052 4.928-23.886 4.449-29.674 2.654-9.858-.177-.657-2.173.278-22.37 30.71-34.021 45.977-26.919 28.815-6.445 2.553-11.173-5.789 1.037-10.337 6.243-9.2 37.257-47.392 22.47-29.371 14.508-16.961-.101-2.451h-.859l-98.954 64.251-17.618 2.275-7.583-7.103.936-11.652 3.589-3.791 29.749-20.474-.101.102.024.101z"/>
  </svg>`;

// OpenAI / ChatGPT — knot, 6× rotational symmetry. Inlined 6× to avoid <use>
// id collisions when multiple badges render in the same document.
const _OPENAI_BLADE = "M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.699 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.099 151.601-338.9 339-339.2z";
export const SVG_OPENAI = `
  <svg width="14" height="14" viewBox="0 0 2406 2406">
    <g fill="#fff">
      <path d="${_OPENAI_BLADE}"/>
      <path d="${_OPENAI_BLADE}" transform="rotate(60 1203 1203)"/>
      <path d="${_OPENAI_BLADE}" transform="rotate(120 1203 1203)"/>
      <path d="${_OPENAI_BLADE}" transform="rotate(180 1203 1203)"/>
      <path d="${_OPENAI_BLADE}" transform="rotate(240 1203 1203)"/>
      <path d="${_OPENAI_BLADE}" transform="rotate(300 1203 1203)"/>
    </g>
  </svg>`;

// --- HTML builders ---------------------------------------------------------
// All return strings; the wiring file mounts them via innerHTML.

export function renderRowHtml(s, now) {
  const isClaude = s.agent !== "codex";
  const badgeCls = isClaude ? "claude" : "codex";
  const logo = isClaude ? SVG_ANTHROPIC : SVG_OPENAI;
  const status = s.status || "idle";
  const elapsed = fmtElapsed(Math.max(0, now - (s.last_event_at || now)));
  const metaParts = status === "idle"
    ? `<span class="${status}">idle</span>`
    : `<span class="${status}">${statusLabel(status)}</span> · ${elapsed}`;
  const ctxBlock = (s.context_tokens != null && s.context_limit)
    ? `<div class="ctx">
         <div class="pct ${pctClass(100 * s.context_tokens / s.context_limit)}">${Math.round(100 * s.context_tokens / s.context_limit)}%</div>
         <div class="lim">[${fmtLimit(s.context_limit)}]</div>
       </div>`
    : `<div class="ctx"></div>`;
  return `
    <div class="row ${status === "waiting_input" ? "waiting" : ""}" data-id="${escapeAttr(s.session_id)}">
      <div class="badge ${badgeCls}">${logo}</div>
      <div class="dot ${status}"></div>
      <div class="body">
        <div class="name">${escape(nameOrPrompt(s))}</div>
        <div class="meta">${metaParts}</div>
      </div>
      ${ctxBlock}
    </div>`;
}

export function renderGroupHtml(cwd, list, now, opts = {}) {
  const collapsed   = opts.collapsed   ?? new Set();
  const chatsCounts = opts.chatsCounts ?? new Map();
  const pinnedCwd   = opts.pinnedCwd   ?? null;
  const isCollapsed = collapsed.has(cwd);
  const arrow = isCollapsed ? "▸" : "▾";
  // [N] = all chats this cwd has ever hosted. Falls back to active count
  // until the /chats response arrives.
  const count = chatsCounts.has(cwd) ? chatsCounts.get(cwd) : list.length;
  const openCls = pinnedCwd === cwd ? " open" : "";
  const rows = isCollapsed ? "" : list.map(s => renderRowHtml(s, now)).join("");
  return `
    <div class="group">
      <div class="group-header" data-cwd="${escapeAttr(cwd)}">
        <span class="g-toggle">${arrow} ${escape(shortPath(cwd))}</span>
        <span class="g-count${openCls}" data-cwd="${escapeAttr(cwd)}">[${count}]</span>
      </div>
      ${rows}
    </div>`;
}

export function renderListHtml(sessionsArr, now, opts = {}) {
  const groupList = groupSessionsByCwd(sessionsArr);
  if (groupList.length === 0) {
    return `<div class="empty">No active sessions.<br>Open Claude or Codex in a terminal.</div>`;
  }
  return groupList.map(([cwd, list]) => renderGroupHtml(cwd, list, now, opts)).join("");
}

export function renderMiniBarHtml(sessionsArr) {
  const waiting = [];
  let running = 0, done = 0;
  for (const s of sessionsArr) {
    const status = s.status || "idle";
    if (status === "waiting_input") waiting.push(s);
    else if (status === "working")  running++;
    else if (status === "done")     done++;
  }
  waiting.sort((a, b) => (b.last_event_at || 0) - (a.last_event_at || 0));

  const waitingHtml = waiting.length === 0
    ? `<span class="mini-empty">no waiting</span>`
    : waiting.map(s => `
        <span class="mini-waiting" data-id="${escapeAttr(s.session_id)}">
          <span class="dot waiting_input"></span>
          <span class="name">${escape(nameOrPrompt(s))}</span>
        </span>`).join("");

  const countsHtml = `
    <span class="mini-count${running === 0 ? " zero" : ""}">
      <span class="dot working"></span><span class="n">${running}</span>running
    </span>
    <span class="mini-count${done === 0 ? " zero" : ""}">
      <span class="dot done"></span><span class="n">${done}</span>done
    </span>`;

  return `
    <div class="mini-waiting-row">${waitingHtml}</div>
    <div class="mini-counts-row">${countsHtml}</div>`;
}

// --- History view ---------------------------------------------------------
// History is "every chat across every project, regardless of whether a
// session is currently running". No status colors — at this point we just
// care that a chat exists. Each row carries the agent badge for identity
// and the time-since-last-activity for ordering context.

/** Pure helper — "14m / 2h / 1d / 3w" style relative time. */
export function fmtAgo(seconds) {
  if (seconds < 60)         return `${Math.floor(seconds)}s`;
  if (seconds < 3600)       return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400)     return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86_400 * 7) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds < 86_400 * 30) return `${Math.floor(seconds / (86_400 * 7))}w`;
  return `${Math.floor(seconds / (86_400 * 30))}mo`;
}

function chatName(c) {
  return c.name || (c.first_prompt || "").trim() || (c.session_id || "").slice(0, 8);
}

function agentBadge(agent) {
  const isCodex = agent === "codex";
  const cls = isCodex ? "codex" : "claude";
  const logo = isCodex ? SVG_OPENAI : SVG_ANTHROPIC;
  return `<div class="badge ${cls}">${logo}</div>`;
}

/** History grouped by cwd; groups collapsed by default. Sorted by the
 *  freshest chat inside each group. */
export function renderHistoryByProjectHtml(chats, now, opts = {}) {
  const expanded = opts.expanded ?? new Set();   // cwds the user opened
  if (chats.length === 0) {
    return `<div class="empty">No chats on disk yet.</div>`;
  }
  // Group by cwd.
  const groups = new Map();
  for (const c of chats) {
    const k = c.cwd || "(unknown)";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  // Sort inside each group + groups by freshest.
  for (const arr of groups.values()) arr.sort((a, b) => b.last_modified - a.last_modified);
  const sorted = [...groups.entries()].sort((a, b) =>
    (b[1][0]?.last_modified || 0) - (a[1][0]?.last_modified || 0));

  return sorted.map(([cwd, list]) => {
    const isOpen = expanded.has(cwd);
    const arrow = isOpen ? "▾" : "▸";
    const topAgo = fmtAgo(now - (list[0].last_modified / 1000));
    const rows = isOpen
      ? list.map(c => renderHistoryChatRowHtml(c, now, /*showCwd=*/false)).join("")
      : "";
    return `
      <div class="hist-group">
        <div class="hist-group-header" data-cwd="${escapeAttr(cwd)}">
          <span class="hg-toggle">${arrow} ${escape(shortPath(cwd))}</span>
          <span class="hg-meta">[${list.length}] · ${topAgo}</span>
        </div>
        ${rows}
      </div>`;
  }).join("");
}

/** History grouped by time buckets (Today / Yesterday / Last 7 days / Older).
 *  Each row shows the project as a faint tag on the right. */
export function renderHistoryByTimeHtml(chats, now) {
  if (chats.length === 0) {
    return `<div class="empty">No chats on disk yet.</div>`;
  }
  const todayStart     = startOfDayMs(now);
  const yesterdayStart = todayStart - 86_400_000;
  const weekStart      = todayStart - 6 * 86_400_000;

  const buckets = { today: [], yesterday: [], week: [], older: [] };
  for (const c of chats) {
    const ms = c.last_modified;
    if      (ms >= todayStart)     buckets.today.push(c);
    else if (ms >= yesterdayStart) buckets.yesterday.push(c);
    else if (ms >= weekStart)      buckets.week.push(c);
    else                            buckets.older.push(c);
  }
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => b.last_modified - a.last_modified);
  }

  const sections = [
    ["Today",        buckets.today],
    ["Yesterday",    buckets.yesterday],
    ["Last 7 days",  buckets.week],
    ["Older",        buckets.older],
  ].filter(([_, list]) => list.length > 0);

  return sections.map(([label, list]) => `
    <div class="hist-bucket">
      <div class="hist-bucket-header">${label} <span class="hb-count">(${list.length})</span></div>
      ${list.map(c => renderHistoryChatRowHtml(c, now, /*showCwd=*/true)).join("")}
    </div>`).join("");
}

/** Today's midnight in epoch milliseconds, in the user's local timezone. */
function startOfDayMs(now) {
  const d = new Date(now * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function renderHistoryChatRowHtml(c, now, showCwd) {
  const ago = fmtAgo(now - (c.last_modified / 1000));
  const cwdTag = showCwd
    ? `<span class="hist-cwd">${escape(shortPath(c.cwd))}</span>`
    : "";
  const ctxBlock = (c.context_tokens != null && c.context_limit)
    ? `<div class="hist-ctx">
         <div class="pct ${pctClass(100 * c.context_tokens / c.context_limit)}">${Math.round(100 * c.context_tokens / c.context_limit)}%</div>
         <div class="lim">[${fmtLimit(c.context_limit)}]</div>
       </div>`
    : `<div class="hist-ctx"></div>`;
  return `
    <div class="hist-row" data-id="${escapeAttr(c.session_id)}" data-cwd="${escapeAttr(c.cwd)}">
      ${agentBadge(c.agent)}
      <div class="hist-body">
        <div class="name">${escape(chatName(c))}</div>
        ${cwdTag}
      </div>
      ${ctxBlock}
      <div class="hist-ago">${ago}</div>
    </div>`;
}

const POPUP_PALETTE = {
  working: "#ffd166", waiting_input: "#ef476f",
  done: "#06d6a0", idle: "#6c7a89",
};

export function renderChatsPopupHtml(active, archived, cwd) {
  // active: array of session objects (live state)
  // archived: array of {session_id, name, first_prompt} (from /chats)
  const head = `<div class="head">${escape(shortPath(cwd))}</div>`;
  const sub  = `<div class="cwd">${escape(cwd)}</div>`;
  if (active.length === 0 && archived.length === 0) {
    return head + sub + `<div class="msg">No chats yet.</div>`;
  }
  const activeRows = [...active]
    .sort((a, b) => (b.last_event_at || 0) - (a.last_event_at || 0))
    .map(s => {
      const status = s.status || "idle";
      const dot = POPUP_PALETTE[status] || POPUP_PALETTE.idle;
      const name = escape(s.name || (s.first_prompt || "").trim() || (s.session_id || "").slice(0, 8));
      return `<div class="chat-row">
        <span class="dot" style="background:${dot}"></span>
        <span class="name">${name}</span>
        <span class="state">${status}</span>
      </div>`;
    }).join("");
  const archivedRows = archived.map(c => {
    const name = escape(c.name || (c.first_prompt || "").trim() || (c.session_id || "").slice(0, 8));
    return `<div class="chat-row inactive">
      <span class="dot" style="background:#5a6a7a"></span>
      <span class="name">${name}</span>
      <span class="state">non active</span>
    </div>`;
  }).join("");
  return head + sub + activeRows + archivedRows;
}
