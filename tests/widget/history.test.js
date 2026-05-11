// History view rendering — "by project" and "by time" sorts.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fmtAgo,
  renderHistoryByProjectHtml,
  renderHistoryByTimeHtml,
} from "../../web/widget-pure.js";

const NOW = 1_700_000_000;
const MS = (sec) => sec * 1000;

function c(over = {}) {
  return {
    session_id: over.session_id ?? "id",
    cwd:        over.cwd ?? "/p",
    agent:      over.agent ?? "claude",
    name:       over.name ?? "",
    first_prompt: over.first_prompt ?? "",
    last_modified: over.last_modified ?? MS(NOW - 60),
    ...over,
  };
}

// --- fmtAgo ---------------------------------------------------------------

test("fmtAgo across thresholds", () => {
  assert.equal(fmtAgo(30),                "30s");
  assert.equal(fmtAgo(60),                "1m");
  assert.equal(fmtAgo(60 * 30),           "30m");
  assert.equal(fmtAgo(3600),              "1h");
  assert.equal(fmtAgo(3600 * 2.5),        "2h");
  assert.equal(fmtAgo(86_400),            "1d");
  assert.equal(fmtAgo(86_400 * 3),        "3d");
  assert.equal(fmtAgo(86_400 * 7),        "1w");
  assert.equal(fmtAgo(86_400 * 14),       "2w");
  assert.equal(fmtAgo(86_400 * 30),       "1mo");
  assert.equal(fmtAgo(86_400 * 90),       "3mo");
});

// --- renderHistoryByProjectHtml -------------------------------------------

test("renderHistoryByProjectHtml shows empty placeholder when chats=[]", () => {
  const html = renderHistoryByProjectHtml([], NOW);
  assert.match(html, /No chats on disk yet/);
});

test("renderHistoryByProjectHtml groups by cwd, sorts groups by freshest", () => {
  const html = renderHistoryByProjectHtml([
    c({ session_id: "old", cwd: "/old-project",   last_modified: MS(NOW - 86_400 * 7) }),
    c({ session_id: "new", cwd: "/fresh-project", last_modified: MS(NOW - 60) }),
  ], NOW);
  const iFresh = html.indexOf("fresh-project");
  const iOld   = html.indexOf("old-project");
  assert.ok(iFresh < iOld, "fresh project should be listed first");
});

test("renderHistoryByProjectHtml collapses by default; expands when cwd in expanded set", () => {
  const collapsed = renderHistoryByProjectHtml(
    [c({ name: "Secret Chat" })], NOW,
  );
  assert.match(collapsed, /▸/);              // collapsed arrow
  assert.doesNotMatch(collapsed, /Secret Chat/); // row not rendered

  const expanded = renderHistoryByProjectHtml(
    [c({ name: "Secret Chat", cwd: "/p" })], NOW,
    { expanded: new Set(["/p"]) },
  );
  assert.match(expanded, /▾/);
  assert.match(expanded, /Secret Chat/);
});

test("renderHistoryByProjectHtml shows [N] and time-since-latest in group header", () => {
  const html = renderHistoryByProjectHtml([
    c({ cwd: "/p", last_modified: MS(NOW - 60) }),
    c({ cwd: "/p", last_modified: MS(NOW - 120), session_id: "older" }),
  ], NOW);
  assert.match(html, /\[2\]/);
  assert.match(html, /1m/);   // 60 seconds ago in fmtAgo terms
});

test("renderHistoryByProjectHtml omits status — only badge + name + ago", () => {
  // No status dot, no green/red/yellow color anywhere.
  const html = renderHistoryByProjectHtml([
    c({ name: "x", cwd: "/p" }),
  ], NOW, { expanded: new Set(["/p"]) });
  assert.doesNotMatch(html, /dot waiting_input/);
  assert.doesNotMatch(html, /dot working/);
  assert.doesNotMatch(html, /dot done/);
  // But agent badge is present:
  assert.match(html, /badge (claude|codex)/);
});

test("renderHistoryByProjectHtml shows context % when both tokens and limit are present", () => {
  const html = renderHistoryByProjectHtml(
    [c({ cwd: "/p", name: "x",
         context_tokens: 410_000, context_limit: 1_000_000 })],
    NOW,
    { expanded: new Set(["/p"]) },
  );
  assert.match(html, /41%/);
  assert.match(html, /\[1M\]/);
});

test("renderHistoryByProjectHtml omits context block when tokens/limit absent", () => {
  // Empty `.hist-ctx` div is fine — it just keeps the grid column happy.
  const html = renderHistoryByProjectHtml(
    [c({ cwd: "/p", name: "x" })],
    NOW,
    { expanded: new Set(["/p"]) },
  );
  assert.doesNotMatch(html, /\d+%/);
  // [N] group count is fine; we just don't want a [1M]/[256K] context-limit tag.
  assert.doesNotMatch(html, /\[\d+(M|K)\]/);
});

// --- renderHistoryByTimeHtml ----------------------------------------------

test("renderHistoryByTimeHtml buckets into Today / Yesterday / Last 7 / Older", () => {
  // Bucket math is wall-clock local: midnight defines the bucket edges.
  // Compute the same midnight the renderer will, then place chats safely
  // inside each calendar bucket — TZ-independent.
  const todayStart = new Date(NOW * 1000);
  todayStart.setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  const ts = todayStart.getTime();
  const html = renderHistoryByTimeHtml([
    c({ name: "rightnow",  last_modified: ts + dayMs / 4 }),       // today, mid-morning
    c({ name: "yesterday", last_modified: ts - dayMs / 4 * 3 }),   // yesterday, evening
    c({ name: "lastweek",  last_modified: ts - dayMs * 4 }),       // 4 days ago
    c({ name: "ancient",   last_modified: ts - dayMs * 60 }),      // 2 months ago
  ], NOW);
  assert.match(html, /Today/);
  assert.match(html, /Yesterday/);
  assert.match(html, /Last 7 days/);
  assert.match(html, /Older/);
});

test("renderHistoryByTimeHtml skips empty buckets", () => {
  // Only today's chats — no Yesterday/Last 7/Older sections.
  const html = renderHistoryByTimeHtml([
    c({ name: "fresh", last_modified: MS(NOW - 60) }),
  ], NOW);
  assert.match(html, /Today/);
  assert.doesNotMatch(html, /Yesterday/);
  assert.doesNotMatch(html, /Last 7 days/);
  assert.doesNotMatch(html, /Older/);
});

test("renderHistoryByTimeHtml shows project tag inline next to each row", () => {
  // "by time" view shows shortPath(cwd) so the user knows which project
  // each chat belonged to without scrolling back to a group header.
  const html = renderHistoryByTimeHtml([
    c({ name: "n", cwd: "/home/nj/projects/palisade/self-replication",
        last_modified: MS(NOW - 60) }),
  ], NOW);
  assert.match(html, /palisade\/self-replication/);
});
