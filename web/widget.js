// Watchfire widget — DOM wiring.
//
// Same WebSocket data feed as the iso map (web/main.js); different render.
// All formatting, grouping, and HTML production lives in widget-pure.js
// (covered by tests/widget/). This file owns the mutable state, the DOM
// element references, network calls, and event listeners.

import { connectWS } from "./ws.js";
import {
  escape,
  shortPath,
  nameOrPrompt,
  groupSessionsByCwd,
  renderListHtml,
  renderMiniBarHtml,
  renderChatsPopupHtml,
  renderHistoryByProjectHtml,
  renderHistoryByTimeHtml,
} from "./widget-pure.js";

const sessions = new Map();        // session_id -> session
const collapsed = new Set();        // cwd keys the user has collapsed
const chatsCounts  = new Map();     // cwd -> total chats on disk
const chatsCache   = new Map();     // cwd -> chat list (cached /chats response)
const chatsFetches = new Set();     // cwds with an in-flight /chats request
let pinnedCwd = null;               // cwd whose chats popup is currently pinned open

const scrollEl   = document.getElementById("scroll");
const tooltipEl  = document.getElementById("tooltip");
const miniBarEl  = document.getElementById("miniBar");
const modebarEl  = document.getElementById("modebar");
const historyEl  = document.getElementById("history");
const historyBodyEl = document.getElementById("historyBody");

// History view state — populated by /chats-all the first time mode=history
// is entered. Persisted-by-app: chats list itself is a fetch, expanded set
// + sort lives in memory + localStorage.
let historyChats = null;        // null = not loaded yet, array once loaded
let historyFetching = false;
const historyExpanded = new Set();

// --- Render ----------------------------------------------------------------

function render() {
  const now = Date.now() / 1000;
  const sessionsArr = [...sessions.values()];

  scrollEl.innerHTML = renderListHtml(sessionsArr, now,
    { collapsed, chatsCounts, pinnedCwd });
  miniBarEl.innerHTML = renderMiniBarHtml(sessionsArr);

  // Wire interactivity
  // Folder name area collapses; the [N] badge opens the all-chats popup.
  for (const t of scrollEl.querySelectorAll(".group-header .g-toggle")) {
    t.addEventListener("click", () => {
      const k = t.parentElement.dataset.cwd;
      collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k);
      render();
    });
  }
  for (const c of scrollEl.querySelectorAll(".group-header .g-count")) {
    c.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePinnedChats(c.dataset.cwd, c);
    });
  }
  for (const row of scrollEl.querySelectorAll(".row")) {
    const id = row.dataset.id;
    row.addEventListener("click", () => focusSession(sessions.get(id)));
    // Tooltip is anchored to the row (not the cursor) with a 5px gap so
    // it never covers the row you're hovering. mousemove is intentionally
    // not wired — we don't want it to track the cursor.
    row.addEventListener("mouseenter", (e) => showTip(sessions.get(id), e));
    row.addEventListener("mouseleave", () => {
      // Don't dismiss a pinned chats popup just because we left a row.
      if (!pinnedCwd) tooltipEl.style.display = "none";
    });
  }
  for (const el of miniBarEl.querySelectorAll(".mini-waiting")) {
    el.addEventListener("click", () => focusSession(sessions.get(el.dataset.id)));
  }

  // After mounting, kick off chat-count fetches for any cwd we don't know
  // yet — render() reruns when the response comes back so [N] updates.
  for (const [cwd] of groupSessionsByCwd(sessionsArr)) ensureChatsCount(cwd);
}

// --- All-chats popup -------------------------------------------------------

function ensureChatsCount(cwd) {
  if (chatsCounts.has(cwd) || chatsFetches.has(cwd)) return;
  chatsFetches.add(cwd);
  fetch(`/chats?cwd=${encodeURIComponent(cwd)}`)
    .then(r => r.ok ? r.json() : [])
    .then(list => {
      chatsCounts.set(cwd, list.length);
      chatsCache.set(cwd, list);
    })
    .catch(() => {})
    .finally(() => {
      chatsFetches.delete(cwd);
      render();
      // Re-paint the popup if it's pinned for this cwd — the archived
      // section was empty until /chats came back.
      if (pinnedCwd === cwd) {
        const anchor = [...scrollEl.querySelectorAll(".g-count")]
          .find(el => el.dataset.cwd === cwd);
        if (anchor) showAllChatsPopup(cwd, anchor);
      }
    });
}

function togglePinnedChats(cwd, anchorEl) {
  if (pinnedCwd === cwd) {
    pinnedCwd = null;
    tooltipEl.style.display = "none";
    render();
    return;
  }
  pinnedCwd = cwd;
  // Show synchronously with whatever's cached; .finally above re-paints
  // when the cache is replaced by a fresh fetch.
  showAllChatsPopup(cwd, anchorEl);
  chatsCounts.delete(cwd);
  chatsCache.delete(cwd);
  ensureChatsCount(cwd);
}

function showAllChatsPopup(cwd, anchorEl) {
  const active = [...sessions.values()]
    .filter(s => (s.cwd || "(unknown)") === cwd);
  const activeIds = new Set(active.map(s => s.session_id));
  const archived = (chatsCache.get(cwd) || []).filter(c => !activeIds.has(c.session_id));

  tooltipEl.style.visibility = "hidden";
  tooltipEl.style.display = "block";
  tooltipEl.innerHTML = renderChatsPopupHtml(active, archived, cwd);
  void tooltipEl.offsetHeight;
  positionTipAtRow(anchorEl);
  tooltipEl.style.visibility = "visible";
}

// Close pinned popup on click outside the popup (and outside any [N] badge,
// which has its own toggle handler).
document.addEventListener("click", (e) => {
  if (!pinnedCwd) return;
  if (tooltipEl.contains(e.target)) return;
  if (e.target.classList && e.target.classList.contains("g-count")) return;
  pinnedCwd = null;
  tooltipEl.style.display = "none";
  render();
});

// --- Mode switcher ---------------------------------------------------------
// Three mutually-exclusive modes drive which top-level panel is visible:
//   full    — the scrollable session list
//   mini    — the compact "who's waiting" strip
//   history — every chat ever, grouped by project or by time
// Persisted in localStorage. Migrates from the legacy `orchestrator.mini`
// flag (1 → mini, 0 → full) on first run.

const MODE_KEY        = "watchfire.mode";
const LEGACY_MINI_KEY = "orchestrator.mini";
const HSORT_KEY       = "watchfire.historySort";

function currentMode() {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === "full" || m === "mini" || m === "history") return m;
    // Legacy: orchestrator.mini=1 → mini
    if (localStorage.getItem(LEGACY_MINI_KEY) === "1") return "mini";
  } catch {}
  return "full";
}

function setMode(m) {
  document.body.classList.remove("mode-full", "mode-mini", "mode-history");
  document.body.classList.add(`mode-${m}`);
  for (const b of modebarEl.querySelectorAll(".mode-btn")) {
    b.classList.toggle("active", b.dataset.mode === m);
  }
  try { localStorage.setItem(MODE_KEY, m); } catch {}
  // window.resizeTo is blocked by Edge for windows it didn't open via JS
  // (the --app launch). No-op if blocked. Heights are just hints; user
  // can resize manually afterwards.
  try {
    if      (m === "mini")    window.resizeTo(window.outerWidth, 90);
    else if (m === "history") window.resizeTo(window.outerWidth, 600);
    else                       window.resizeTo(window.outerWidth, 480);
  } catch {}
  if (m === "history") loadHistory();
}

for (const b of modebarEl.querySelectorAll(".mode-btn")) {
  b.addEventListener("click", () => setMode(b.dataset.mode));
}
setMode(currentMode());

// --- History view ----------------------------------------------------------

function currentHistorySort() {
  try {
    const s = localStorage.getItem(HSORT_KEY);
    if (s === "project" || s === "time") return s;
  } catch {}
  return "project";
}

function setHistorySort(s) {
  try { localStorage.setItem(HSORT_KEY, s); } catch {}
  for (const b of historyEl.querySelectorAll(".hs-toggle")) {
    b.classList.toggle("active", b.dataset.sort === s);
  }
  renderHistory();
}

async function loadHistory() {
  if (historyChats !== null || historyFetching) {
    renderHistory();   // already have data — paint with what we've got
    return;
  }
  historyFetching = true;
  historyBodyEl.innerHTML = `<div class="empty">Loading history…</div>`;
  try {
    const r = await fetch("/chats-all");
    historyChats = r.ok ? await r.json() : [];
  } catch {
    historyChats = [];
  } finally {
    historyFetching = false;
    renderHistory();
  }
}

function renderHistory() {
  if (historyChats === null) return;   // not loaded yet
  const sort = currentHistorySort();
  const now = Date.now() / 1000;
  historyBodyEl.innerHTML = sort === "time"
    ? renderHistoryByTimeHtml(historyChats, now)
    : renderHistoryByProjectHtml(historyChats, now, { expanded: historyExpanded });

  for (const h of historyBodyEl.querySelectorAll(".hist-group-header")) {
    h.addEventListener("click", () => {
      const cwd = h.dataset.cwd;
      historyExpanded.has(cwd) ? historyExpanded.delete(cwd) : historyExpanded.add(cwd);
      renderHistory();
    });
  }
  for (const row of historyBodyEl.querySelectorAll(".hist-row")) {
    row.addEventListener("click", () => {
      // Best-effort: if this chat happens to be currently active, focus it.
      // For pure history entries we don't (yet) try to resume — just no-op.
      const id = row.dataset.id;
      const s = sessions.get(id);
      if (s) focusSession(s);
    });
  }
}

for (const b of historyEl.querySelectorAll(".hs-toggle")) {
  b.addEventListener("click", () => setHistorySort(b.dataset.sort));
}
// Initial toolbar highlight (history pane doesn't paint until first visit).
for (const b of historyEl.querySelectorAll(".hs-toggle")) {
  b.classList.toggle("active", b.dataset.sort === currentHistorySort());
}

// --- Tooltip ---------------------------------------------------------------

function showTip(s, e) {
  if (!s) return;
  // Don't replace a pinned chats popup with a row hover preview.
  if (pinnedCwd) return;
  // Sub-line shows only the model (everything else duplicates the row).
  const head = nameOrPrompt(s);
  const sub = s.model ? `<div class="sub">${escape(s.model)}</div>` : "";
  const prompt = s.last_prompt ? `<div class="lbl">last prompt:</div><div class="prompt">${escape(s.last_prompt).slice(0, 400)}</div>` : "";
  const target = e.currentTarget;
  // Hide while we swap content + measure — getBoundingClientRect right
  // after innerHTML can otherwise return the *previous* content's height
  // because Edge batches layout. visibility:hidden keeps the element in
  // flow so layout is computable; void offsetHeight forces a sync flush.
  tooltipEl.style.visibility = "hidden";
  tooltipEl.style.display = "block";
  tooltipEl.innerHTML = `<div class="head">${escape(head)}</div>${sub}${prompt}<div class="cwd">${escape(s.cwd || "")}</div>`;
  void tooltipEl.offsetHeight;
  positionTipAtRow(target);
  tooltipEl.style.visibility = "visible";
}

function positionTipAtRow(rowEl) {
  // Place the tooltip above the row with a 5px gap. If above would clip
  // the top of the viewport, place below. Centered horizontally on the
  // row, clamped to viewport margins.
  const GAP = 5;
  const MARGIN = 8;
  const ww = window.innerWidth, wh = window.innerHeight;
  const row = rowEl.getBoundingClientRect();
  const tip = tooltipEl.getBoundingClientRect();
  const w = tip.width, h = tip.height;

  let x = row.left + row.width / 2 - w / 2;
  if (x + w > ww - MARGIN) x = ww - MARGIN - w;
  if (x < MARGIN)          x = MARGIN;

  let y = row.top - h - GAP;
  if (y < MARGIN) {
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

// --- Wiring ----------------------------------------------------------------

// Invalidate cached chat counts for a cwd whenever its session list shifts
// (a new chat → archive count goes up; an unlink → goes down). Forces a
// fresh /chats fetch on the next render.
function invalidateChats(cwd) {
  if (!cwd) return;
  chatsCounts.delete(cwd);
  chatsCache.delete(cwd);
}

connectWS({
  onSnapshot: (list) => {
    sessions.clear();
    chatsCounts.clear();
    chatsCache.clear();
    for (const s of list) sessions.set(s.session_id, s);
    render();
  },
  onUpsert: (s) => {
    sessions.set(s.session_id, s);
    invalidateChats(s.cwd || "(unknown)");
    render();
  },
  onRemove: (id) => {
    const old = sessions.get(id);
    sessions.delete(id);
    if (old) invalidateChats(old.cwd || "(unknown)");
    render();
  },
});

// Re-render every 5s so the "running · 0:08" elapsed timer ticks visibly.
setInterval(render, 5000);
