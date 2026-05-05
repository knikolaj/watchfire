// Watchfire widget — compact list view.
// Same WebSocket data feed as the iso map (web/main.js); different render.
//
// Sessions are grouped by cwd, sorted within and across groups by recency
// of `last_event_at` (most recent first).
//
// Tauri-friendly: no canvas, all DOM. Tauri's WebView will render this directly.

import { connectWS } from "./ws.js";

const sessions = new Map();   // session_id -> session
const collapsed = new Set();  // cwd keys the user has collapsed

const scrollEl = document.getElementById("scroll");
const tooltipEl = document.getElementById("tooltip");
const miniBarEl = document.getElementById("miniBar");
const toggleEl  = document.getElementById("toggle");

// --- SVG marks (inlined) ---------------------------------------------------
// Anthropic / Claude — squiggle mark from uxwing.com (royalty-free).
// Background path stripped (the badge container already provides Claude orange);
// fill overridden to white for visibility on any badge color.
const SVG_ANTHROPIC = `
  <svg width="14" height="14" viewBox="0 0 512 509.64">
    <path fill="#fff" fill-rule="nonzero" d="M142.27 316.619l73.655-41.326 1.238-3.589-1.238-1.996-3.589-.001-12.31-.759-42.084-1.138-36.498-1.516-35.361-1.896-8.897-1.895-8.34-10.995.859-5.484 7.482-5.03 10.717.935 23.683 1.617 35.537 2.452 25.782 1.517 38.193 3.968h6.064l.86-2.451-2.073-1.517-1.618-1.517-36.776-24.922-39.81-26.338-20.852-15.166-11.273-7.683-5.687-7.204-2.451-15.721 10.237-11.273 13.75.935 3.513.936 13.928 10.716 29.749 23.027 38.848 28.612 5.687 4.727 2.275-1.617.278-1.138-2.553-4.271-21.13-38.193-22.546-38.848-10.035-16.101-2.654-9.655c-.935-3.968-1.617-7.304-1.617-11.374l11.652-15.823 6.445-2.073 15.545 2.073 6.547 5.687 9.655 22.092 15.646 34.78 24.265 47.291 7.103 14.028 3.791 12.992 1.416 3.968 2.449-.001v-2.275l1.997-26.641 3.69-32.707 3.589-42.084 1.239-11.854 5.863-14.206 11.652-7.683 9.099 4.348 7.482 10.716-1.036 6.926-4.449 28.915-8.72 45.294-5.687 30.331h3.313l3.792-3.791 15.342-20.372 25.782-32.227 11.374-12.789 13.27-14.129 8.517-6.724 16.1-.001 11.854 17.617-5.307 18.199-16.581 21.029-13.75 17.819-19.716 26.54-12.309 21.231 1.138 1.694 2.932-.278 44.536-9.479 24.062-4.347 28.714-4.928 12.992 6.066 1.416 6.167-5.106 12.613-30.71 7.583-36.018 7.204-53.636 12.689-.657.48.758.935 24.164 2.275 10.337.556h25.301l47.114 3.514 12.309 8.139 7.381 9.959-1.238 7.583-18.957 9.655-25.579-6.066-59.702-14.205-20.474-5.106-2.83-.001v1.694l17.061 16.682 31.266 28.233 39.152 36.397 1.997 8.999-5.03 7.102-5.307-.758-34.401-25.883-13.27-11.651-30.053-25.302-1.996-.001v2.654l6.926 10.136 36.574 54.975 1.895 16.859-2.653 5.485-9.479 3.311-10.414-1.895-21.408-30.054-22.092-33.844-17.819-30.331-2.173 1.238-10.515 113.261-4.929 5.788-11.374 4.348-9.478-7.204-5.03-11.652 5.03-23.027 6.066-30.052 4.928-23.886 4.449-29.674 2.654-9.858-.177-.657-2.173.278-22.37 30.71-34.021 45.977-26.919 28.815-6.445 2.553-11.173-5.789 1.037-10.337 6.243-9.2 37.257-47.392 22.47-29.371 14.508-16.961-.101-2.451h-.859l-98.954 64.251-17.618 2.275-7.583-7.103.936-11.652 3.589-3.791 29.749-20.474-.101.102.024.101z"/>
  </svg>`;
// OpenAI / ChatGPT — official knot, 6× rotational symmetry. Path from
// Wikimedia Commons (File:ChatGPT_logo.svg). Inlined 6× to avoid <use> id
// collisions when multiple badges render in the same document.
const _OPENAI_BLADE = "M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.699 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.099 151.601-338.9 339-339.2z";
const SVG_OPENAI = `
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

// --- Formatting helpers ----------------------------------------------------

function shortPath(cwd) {
  if (!cwd) return "(unknown)";
  const parts = cwd.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}

function fmtElapsed(seconds) {
  if (seconds < 60)        return `${Math.floor(seconds)}s`;
  if (seconds < 3600)      return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  if (seconds < 86_400)    return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function fmtLimit(n) {
  if (!n) return "";
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  return `${Math.round(n / 1000)}K`;
}

function statusLabel(s) {
  return ({ working: "running", waiting_input: "waiting", done: "done", idle: "idle" })[s] || s;
}

function pctClass(pct) {
  if (pct >= 80) return "danger";
  if (pct >= 50) return "warn";
  return "";
}

function nameOrPrompt(s) {
  // Match Claude UI's session list: customTitle wins, else the FIRST prompt
  // (not the latest one — that's just the most recent message in the dialog).
  if (s.name) return s.name;
  const first = (s.first_prompt || "").trim();
  if (first) return first;
  const last = (s.last_prompt || "").trim();
  return last || (s.session_id || "").slice(0, 8);
}

// --- Render ----------------------------------------------------------------

function render() {
  const now = Date.now() / 1000;

  // Group by cwd.
  const groups = new Map();
  for (const s of sessions.values()) {
    const k = s.cwd || "(unknown)";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }

  // Sort within each group by last_event_at desc.
  for (const arr of groups.values()) {
    arr.sort((a, b) => (b.last_event_at || 0) - (a.last_event_at || 0));
  }

  // Sort groups by their most-recent session.
  const groupList = [...groups.entries()].sort((a, b) =>
    (b[1][0]?.last_event_at || 0) - (a[1][0]?.last_event_at || 0));

  if (groupList.length === 0) {
    scrollEl.innerHTML = `<div class="empty">No active sessions.<br>Open Claude or Codex in a terminal.</div>`;
    renderMiniBar();
    return;
  }

  scrollEl.innerHTML = groupList.map(([cwd, list]) => renderGroup(cwd, list, now)).join("");
  renderMiniBar();

  // Wire interactivity
  for (const head of scrollEl.querySelectorAll(".group-header")) {
    head.addEventListener("click", () => {
      const k = head.dataset.cwd;
      collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k);
      render();
    });
  }
  for (const row of scrollEl.querySelectorAll(".row")) {
    const id = row.dataset.id;
    row.addEventListener("click", () => focusSession(sessions.get(id)));
    // Tooltip is anchored to the row (not the cursor) with a 10px gap, so
    // it never covers the row you're hovering. mousemove is intentionally
    // not wired — we don't want it to track the cursor.
    row.addEventListener("mouseenter", (e) => showTip(sessions.get(id), e));
    row.addEventListener("mouseleave", () => { tooltipEl.style.display = "none"; });
  }
}

function renderGroup(cwd, list, now) {
  const isCollapsed = collapsed.has(cwd);
  const arrow = isCollapsed ? "▸" : "▾";
  const rows = isCollapsed ? "" : list.map(s => renderRow(s, now)).join("");
  return `
    <div class="group">
      <div class="group-header" data-cwd="${escapeAttr(cwd)}">${arrow} ${escape(shortPath(cwd))}</div>
      ${rows}
    </div>`;
}

function renderRow(s, now) {
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

// --- Mini bar (collapsed view) ---------------------------------------------

// Order matches user's mental model: waiting+done on the wrapping first line,
// running+idle on the second line. The flex-wrap container does the actual
// 2-per-line break based on element widths.
const MINI_ORDER = ["waiting_input", "done", "working", "idle"];
const STATUS_LABEL = { working: "running", waiting_input: "waiting", done: "done", idle: "idle" };

function renderMiniBar() {
  const counts = { working: 0, waiting_input: 0, done: 0, idle: 0 };
  for (const s of sessions.values()) counts[s.status || "idle"] = (counts[s.status || "idle"] || 0) + 1;
  miniBarEl.innerHTML = MINI_ORDER.map(st => {
    const n = counts[st] || 0;
    return `<span class="stat ${n === 0 ? "zero" : ""}">
      <span class="dot ${st}"></span><span class="n">${n}</span>${STATUS_LABEL[st]}
    </span>`;
  }).join("");
}

// Initial mode is full. Persist user's choice in localStorage so reloads keep it.
const MINI_KEY = "orchestrator.mini";
function setMini(on) {
  document.body.classList.toggle("mini", on);
  toggleEl.textContent = on ? "▢" : "–";
  toggleEl.title = on ? "Expand" : "Collapse to mini bar";
  try { localStorage.setItem(MINI_KEY, on ? "1" : "0"); } catch {}
  // Try to resize the host window — works in Edge --app mode for windows
  // opened with window-features. No-op if blocked.
  try {
    if (on) window.resizeTo(window.outerWidth, 90);
    else    window.resizeTo(window.outerWidth, 480);
  } catch {}
}
toggleEl.addEventListener("click", () => setMini(!document.body.classList.contains("mini")));
try { if (localStorage.getItem(MINI_KEY) === "1") setMini(true); } catch {}

// --- Tooltip ---------------------------------------------------------------

function showTip(s, e) {
  if (!s) return;
  // Sub-line shows only the model (everything else duplicates the row).
  const head = nameOrPrompt(s);
  const sub = s.model ? `<div class="sub">${escape(s.model)}</div>` : "";
  const prompt = s.last_prompt ? `<div class="lbl">last prompt:</div><div class="prompt">${escape(s.last_prompt).slice(0, 400)}</div>` : "";
  tooltipEl.innerHTML = `<div class="head">${escape(head)}</div>${sub}${prompt}<div class="cwd">${escape(s.cwd || "")}</div>`;
  tooltipEl.style.display = "block";
  positionTipAtRow(e.currentTarget);
}

function positionTipAtRow(rowEl) {
  // Position the tooltip so it never covers the row that triggered it.
  // 10px gap above (preferred) or below the row; horizontally centered on
  // the row, clamped to the viewport. Uses getBoundingClientRect — works
  // correctly under the body's `zoom: 1.15` (offsetWidth would not).
  const GAP = 5;
  const MARGIN = 8;
  const ww = window.innerWidth, wh = window.innerHeight;
  const row = rowEl.getBoundingClientRect();
  const tip = tooltipEl.getBoundingClientRect();
  const w = tip.width, h = tip.height;

  let x = row.left + row.width / 2 - w / 2;
  if (x + w > ww - MARGIN) x = ww - MARGIN - w;
  if (x < MARGIN)          x = MARGIN;

  // Prefer placing above the row.
  let y = row.top - h - GAP;
  if (y < MARGIN) {
    // Not enough room above → place below the row.
    y = row.bottom + GAP;
    if (y + h > wh - MARGIN) y = Math.max(MARGIN, wh - MARGIN - h);
  }

  tooltipEl.style.left = `${x}px`;
  tooltipEl.style.top  = `${y}px`;
}

// --- Focus (delegate to existing /focus endpoint) --------------------------

function focusSession(s) {
  if (!s) return;
  fetch("/focus", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: s.session_id,
      cwd: s.cwd,
      name: s.name,
    }),
  }).catch(() => {});
}

// --- Utils -----------------------------------------------------------------

function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escape(s); }

// --- Wiring ----------------------------------------------------------------

// Note: window.resizeTo() is blocked by Edge for windows it didn't open via
// JS (i.e., the --app launch). Initial sizing is handled in start_widget.ps1
// using the session count passed by `orch widget`.

connectWS({
  onSnapshot: (list) => {
    sessions.clear();
    for (const s of list) sessions.set(s.session_id, s);
    render();
  },
  onUpsert: (s) => { sessions.set(s.session_id, s); render(); },
  onRemove: (id) => { sessions.delete(id); render(); },
});

// Re-render every 5s so the "running · 0:08" elapsed timer ticks visibly.
setInterval(render, 5000);
