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
} from "./widget-pure.js";

const sessions = new Map();        // session_id -> session
const collapsed = new Set();        // cwd keys the user has collapsed
const chatsCounts  = new Map();     // cwd -> total chats on disk
const chatsCache   = new Map();     // cwd -> chat list (cached /chats response)
const chatsFetches = new Set();     // cwds with an in-flight /chats request
let pinnedCwd = null;               // cwd whose chats popup is currently pinned open

const scrollEl  = document.getElementById("scroll");
const tooltipEl = document.getElementById("tooltip");
const miniBarEl = document.getElementById("miniBar");
const toggleEl  = document.getElementById("toggle");

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

// --- Mini bar toggle -------------------------------------------------------

const MINI_KEY = "orchestrator.mini";   // legacy key — keep for migration
function setMini(on) {
  document.body.classList.toggle("mini", on);
  toggleEl.textContent = on ? "▢" : "–";
  toggleEl.title = on ? "Expand" : "Collapse to mini bar";
  try { localStorage.setItem(MINI_KEY, on ? "1" : "0"); } catch {}
  // window.resizeTo() is blocked by Edge for windows it didn't open via JS
  // (the --app launch). No-op if blocked.
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
