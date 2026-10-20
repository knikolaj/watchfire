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
  filterHistoryChats,
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
const historyEl  = document.getElementById("history");
const historyBodyEl = document.getElementById("historyBody");
const codexToggleEl = document.getElementById("codexToggle");

// History view state — populated by /chats-all when mode=history is entered
// and refreshed while it stays open. Persisted-by-app: chats list itself is a fetch, expanded set
// + sort lives in memory + localStorage.
let historyChats = null;        // null = not loaded yet, array once loaded
let historyFetching = false;
// Sessions an agent process has open (server-side check, not just hooks) and
// resumes clicked but not open yet (id -> give-up time, ms).
let openIds = new Set();
let herdrIds = new Set();   // open sessions that sit in a herdr pane
const pendingResumes = new Map();
const PENDING_MS = 2 * 60 * 1000;
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
const HCODEX_KEY      = "watchfire.showCodexTasks";   // reveal tool-spawned codex

function currentShowCodexTasks() {
  try { return localStorage.getItem(HCODEX_KEY) === "1"; } catch { return false; }
}

function setShowCodexTasks(on) {
  try { localStorage.setItem(HCODEX_KEY, on ? "1" : "0"); } catch {}
  renderHistory();
}

function currentMode() {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === "full" || m === "mini" || m === "history") return m;
    // Legacy: orchestrator.mini=1 → mini
    if (localStorage.getItem(LEGACY_MINI_KEY) === "1") return "mini";
  } catch {}
  return "full";
}

const PRE_MINI_KEY = "watchfire.modeBeforeMini";

// Header tabs: Actual = the open-sessions list (mode full); By project / By
// time = History with that sort. Mini is a window size, toggled separately.
function syncTabs() {
  const m = document.body.classList.contains("mode-history") ? currentHistorySort() : "actual";
  for (const b of document.querySelectorAll(".topbar .tab")) {
    b.classList.toggle("active", b.dataset.tab === m);
  }
  syncToolbarSep();
}

function setMode(m) {
  if (m === "mini") {
    try { localStorage.setItem(PRE_MINI_KEY, currentMode() === "mini" ? "full" : currentMode()); } catch {}
  }
  document.body.classList.remove("mode-full", "mode-mini", "mode-history");
  document.body.classList.add(`mode-${m}`);
  try { localStorage.setItem(MODE_KEY, m); } catch {}
  syncTabs();
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

for (const b of document.querySelectorAll(".topbar .tab")) {
  b.addEventListener("click", () => {
    if (b.dataset.tab === "actual") return setMode("full");
    setHistorySort(b.dataset.tab);
    if (currentMode() !== "history") setMode("history");
  });
}
document.getElementById("miniBtn")?.addEventListener("click", () => setMode("mini"));
document.getElementById("expandBtn")?.addEventListener("click", () => {
  let back = "full";
  try { back = localStorage.getItem(PRE_MINI_KEY) === "history" ? "history" : "full"; } catch {}
  setMode(back);
});
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
  syncTabs();
  renderHistory();
}

// The list is a snapshot of the transcripts on disk, so it goes stale: fetched
// only once, a widget left open for days showed nothing newer than the day it
// was opened. Paint what we have at once, then refetch — on every entry into
// History and every couple of minutes while it stays open.
const HISTORY_REFRESH_MS = 2 * 60 * 1000;

async function loadHistory() {
  renderHistory();   // paint cached data (no-op before the first load)
  if (historyFetching) return;
  historyFetching = true;
  if (historyChats === null) {
    historyBodyEl.innerHTML = `<div class="empty">Loading history…</div>`;
  }
  try {
    const [r] = await Promise.all([fetch("/chats-all"), refreshOpenIds()]);
    if (r.ok) historyChats = await r.json();
    else historyChats ??= [];
  } catch {
    historyChats ??= [];   // keep the last good list if the refetch fails
  } finally {
    historyFetching = false;
    renderHistory();
  }
}
setInterval(() => { if (currentMode() === "history") loadHistory(); }, HISTORY_REFRESH_MS);

async function refreshOpenIds() {
  try {
    const r = await fetch("/open-sessions");
    if (r.ok) {
      const list = await r.json();
      openIds = new Set(list.map(s => s.session_id));
      herdrIds = new Set(list.filter(s => s.herdr_pane_id).map(s => s.session_id));
    }
  } catch { /* keep the last answer */ }
}

// After a resume click: poll until the session is open (or we give up), so the
// row turns live without waiting for the 2-minute refresh.
let pendingPoll = null;
function markPending(id) {
  pendingResumes.set(id, Date.now() + PENDING_MS);
  renderHistory();
  if (pendingPoll) return;
  pendingPoll = setInterval(async () => {
    await refreshOpenIds();
    renderHistory();
    if (pendingResumes.size === 0) { clearInterval(pendingPoll); pendingPoll = null; }
  }, 3000);
}

function renderHistory() {
  if (historyChats === null) return;   // not loaded yet
  const sort = currentHistorySort();
  const now = Date.now() / 1000;
  // Which chats have a live window: hook state, plus what the server sees open.
  const liveIds = new Set([...sessions.keys(), ...openIds]);
  for (const [id, until] of pendingResumes) {
    if (liveIds.has(id) || Date.now() > until) pendingResumes.delete(id);
  }
  const pendingIds = new Set(pendingResumes.keys());
  // Claude sessions also carry their pane in hook state.
  const inHerdr = new Set([...herdrIds,
    ...[...sessions.values()].filter(s => s.herdr_pane_id).map(s => s.session_id)]);
  // Hide tool-spawned codex sessions (rescue/companion) unless revealed.
  const showCodex = currentShowCodexTasks();
  const { chats, hidden } = filterHistoryChats(historyChats, showCodex);
  updateCodexToggle(hidden, showCodex);
  historyBodyEl.innerHTML = sort === "time"
    ? renderHistoryByTimeHtml(chats, now, liveIds, pendingIds, inHerdr)
    : renderHistoryByProjectHtml(chats, now, { expanded: historyExpanded, liveIds, pendingIds, herdrIds: inHerdr });

  for (const h of historyBodyEl.querySelectorAll(".hist-group-header")) {
    h.addEventListener("click", () => {
      const cwd = h.dataset.cwd;
      historyExpanded.has(cwd) ? historyExpanded.delete(cwd) : historyExpanded.add(cwd);
      renderHistory();
    });
  }
  // Only the micro-icon is clickable — a click anywhere on the row would be too
  // easy to trigger by accident (and would spawn a terminal).
  for (const icon of historyBodyEl.querySelectorAll(".hist-status")) {
    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      const row = icon.closest(".hist-row");
      // Live session (terminal open) → focus its tab. Closed → resume it.
      const id = row.dataset.id;
      const s = sessions.get(id);
      if (s) { focusSession(s); return; }
      // Open, but its hook hasn't reported yet (fresh Codex resume): focus by
      // what the row knows instead of opening it a second time.
      if (liveIds.has(id)) {
        focusSession({ session_id: id, cwd: row.dataset.cwd, name: row.dataset.name });
        return;
      }
      if (pendingResumes.has(id)) return;   // already on its way
      markPending(id);
      resumeSession({
        session_id: id,
        agent: row.dataset.agent,
        cwd: row.dataset.resumeCwd || "",
        name: row.dataset.name || "",
      });
    });
  }
  // Open in herdr: focus it (the server switches herdr to its pane).
  for (const icon of historyBodyEl.querySelectorAll(".hist-herdr.live")) {
    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      const row = icon.closest(".hist-row");
      focusSession(sessions.get(row.dataset.id)
        ?? { session_id: row.dataset.id, cwd: row.dataset.cwd, name: row.dataset.name });
    });
  }
  for (const icon of historyBodyEl.querySelectorAll(".hist-herdr.resume")) {
    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      const row = icon.closest(".hist-row");
      if (pendingResumes.has(row.dataset.id)) return;   // already on its way
      markPending(row.dataset.id);
      resumeSession({
        session_id: row.dataset.id,
        agent: row.dataset.agent,
        cwd: row.dataset.resumeCwd || "",
        name: row.dataset.name || "",
      }, "/resume-herdr");
    });
  }
}

// Reflect current reveal state + hidden count on the ⚙ codex toggle. Hide the
// button entirely when nothing is hidden and reveal is off — no noise when
// there are no tool-spawned sessions to reveal.
function updateCodexToggle(hidden, showCodex) {
  if (!codexToggleEl) return;
  codexToggleEl.classList.toggle("active", showCodex);
  codexToggleEl.textContent = "🤖";
  codexToggleEl.hidden = !showCodex && hidden === 0;
  syncToolbarSep();
}

// The bar between ⚠ and 🤖 only when both are showing (🤖 is History-only).
function syncToolbarSep() {
  const sep = document.getElementById("tbSep");
  const warn = document.getElementById("auditWarn");
  const robot = codexToggleEl && !codexToggleEl.hidden
    && document.body.classList.contains("mode-history");
  if (sep) sep.hidden = !(warn && !warn.hidden && robot);
}

if (codexToggleEl) {
  codexToggleEl.addEventListener("click", () => setShowCodexTasks(!currentShowCodexTasks()));
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

// --- Focus / Resume (delegate to server endpoints) -------------------------

// Dead history entry → open a fresh Windows Terminal tab that re-opens the
// past Claude/Codex conversation (claude --resume / codex resume).
function resumeSession({ session_id, agent, cwd, name }, where = "/resume") {
  if (!session_id) return;
  fetch(where, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id, agent, cwd, name }),
  }).catch(() => {});
}

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

// Hourly self-check result from the server: sessions that are running but
// missing here. Shown as a small mark so a silent gap doesn't stay silent.
// The mark lives in two places — the header, and next to the expand button
// in mini mode (which has no header).
function renderAudit(unseen) {
  const title = "Running, but missing from the session list:\n"
    + unseen.map(u => `${u.agent} · ${shortPath(u.cwd || "")} · ${String(u.session_id).slice(0, 8)}`).join("\n");
  for (const id of ["auditWarn", "auditWarnMini"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.hidden = unseen.length === 0;
    el.textContent = `⚠ ${unseen.length}`;
    el.title = title;
  }
  syncToolbarSep();
}

connectWS({
  onAudit: renderAudit,
  onSnapshot: (list) => {
    sessions.clear();
    chatsCounts.clear();
    chatsCache.clear();
    for (const s of list) sessions.set(s.session_id, s);
    render();
    renderHistory();   // liveIds membership reset — refresh the live/dead dots
  },
  onUpsert: (s) => {
    // Only a change in *which* sessions are live flips a History dot; a plain
    // status update of an existing session doesn't, so skip the re-render then.
    const isNew = !sessions.has(s.session_id);
    sessions.set(s.session_id, s);
    invalidateChats(s.cwd || "(unknown)");
    render();
    if (isNew) renderHistory();
  },
  onRemove: (id) => {
    const old = sessions.get(id);
    sessions.delete(id);
    if (old) invalidateChats(old.cwd || "(unknown)");
    render();
    renderHistory();   // a chat died → flip its History dot to the ↻ resume icon
  },
});

// Re-render every 5s so the "running · 0:08" elapsed timer ticks visibly.
setInterval(render, 5000);
