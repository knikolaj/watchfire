// UC-1.1 / 1.9 / 1.10 — list rendering.
//
// Pure-string assertions: we don't render to a DOM, just check the
// HTML output for marker classes and structure. That's enough to
// catch regressions in grouping, agent-badge classification, and
// the collapsed/[N]/pinned signals.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  groupSessionsByCwd,
  renderRowHtml,
  renderGroupHtml,
  renderListHtml,
} from "../../web/widget-pure.js";

const NOW = 1_700_000_000;

function s(over = {}) {
  return {
    session_id: over.session_id ?? "abc12345-1111-2222-3333-444444444444",
    cwd: over.cwd ?? "/test",
    agent: over.agent ?? "claude",
    name: over.name ?? "n",
    status: over.status ?? "working",
    last_event_at: over.last_event_at ?? NOW - 30,
    ...over,
  };
}

// --- groupSessionsByCwd ---------------------------------------------------

test("groupSessionsByCwd buckets sessions by cwd", () => {
  const groups = groupSessionsByCwd([
    s({ session_id: "1", cwd: "/a" }),
    s({ session_id: "2", cwd: "/b" }),
    s({ session_id: "3", cwd: "/a" }),
  ]);
  const cwds = groups.map(([cwd]) => cwd);
  assert.deepEqual(cwds.sort(), ["/a", "/b"]);
  const a = groups.find(([cwd]) => cwd === "/a")[1];
  assert.equal(a.length, 2);
});

test("groupSessionsByCwd sorts inside each group by last_event_at desc", () => {
  const [, list] = groupSessionsByCwd([
    s({ session_id: "old", last_event_at: 100 }),
    s({ session_id: "new", last_event_at: 999 }),
    s({ session_id: "mid", last_event_at: 500 }),
  ])[0];
  assert.deepEqual(list.map(x => x.session_id), ["new", "mid", "old"]);
});

test("groupSessionsByCwd sorts groups by their freshest session", () => {
  const groups = groupSessionsByCwd([
    s({ cwd: "/old", last_event_at: 100 }),
    s({ cwd: "/fresh", last_event_at: 999 }),
  ]);
  assert.equal(groups[0][0], "/fresh");
});

test("groupSessionsByCwd treats missing cwd as (unknown)", () => {
  const groups = groupSessionsByCwd([s({ cwd: undefined })]);
  assert.equal(groups[0][0], "(unknown)");
});

// --- renderRowHtml --------------------------------------------------------

test("renderRowHtml marks claude vs codex via badge class", () => {
  const claude = renderRowHtml(s({ agent: "claude" }), NOW);
  const codex  = renderRowHtml(s({ agent: "codex"  }), NOW);
  assert.match(claude, /badge claude/);
  assert.match(codex,  /badge codex/);
});

test("renderRowHtml adds .waiting class only for waiting_input status", () => {
  assert.match(renderRowHtml(s({ status: "waiting_input" }), NOW), /class="row\s+waiting"/);
  assert.doesNotMatch(renderRowHtml(s({ status: "working" }), NOW), /class="row\s+waiting"/);
});

test("renderRowHtml shows context % only when both tokens and limit are present", () => {
  const withCtx = renderRowHtml(s({ context_tokens: 410_000, context_limit: 1_000_000 }), NOW);
  assert.match(withCtx, /41%/);
  assert.match(withCtx, /\[1M\]/);
  const noCtx = renderRowHtml(s({ context_tokens: null, context_limit: null }), NOW);
  assert.doesNotMatch(noCtx, /\d%/);
});

test("renderRowHtml carries session_id in data-id attribute", () => {
  const html = renderRowHtml(s({ session_id: "the-id" }), NOW);
  assert.match(html, /data-id="the-id"/);
});

test("renderRowHtml escapes name containing HTML-active chars", () => {
  const html = renderRowHtml(s({ name: "<script>" }), NOW);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

// --- renderGroupHtml ------------------------------------------------------

test("renderGroupHtml shows expand arrow ▾ when not collapsed", () => {
  const html = renderGroupHtml("/test", [s()], NOW, { collapsed: new Set() });
  assert.match(html, /▾ test/);
  assert.match(html, /class="row/);     // row rendered
});

test("renderGroupHtml shows collapse arrow ▸ and hides rows when collapsed", () => {
  const html = renderGroupHtml("/test", [s()], NOW, { collapsed: new Set(["/test"]) });
  assert.match(html, /▸ test/);
  assert.doesNotMatch(html, /class="row/);
});

test("renderGroupHtml [N] count uses chatsCounts when available", () => {
  // Active list has 1 session, but chatsCounts says 7 — should render [7].
  const html = renderGroupHtml("/test", [s()], NOW,
    { chatsCounts: new Map([["/test", 7]]) });
  assert.match(html, /\[7\]/);
});

test("renderGroupHtml [N] count falls back to active list length", () => {
  const html = renderGroupHtml("/test", [s(), s({ session_id: "2" })], NOW, {});
  assert.match(html, /\[2\]/);
});

test("renderGroupHtml adds .open marker to [N] when this cwd is pinned", () => {
  const open = renderGroupHtml("/x", [s({ cwd: "/x" })], NOW, { pinnedCwd: "/x" });
  const dim  = renderGroupHtml("/y", [s({ cwd: "/y" })], NOW, { pinnedCwd: "/x" });
  assert.match(open, /g-count\s+open/);
  assert.doesNotMatch(dim, /g-count\s+open/);
});

// --- renderListHtml -------------------------------------------------------

test("renderListHtml shows empty placeholder when no sessions", () => {
  const html = renderListHtml([], NOW);
  assert.match(html, /No active sessions/);
});

test("renderListHtml renders each cwd group", () => {
  const html = renderListHtml([
    s({ cwd: "/a" }), s({ cwd: "/b" }),
  ], NOW);
  assert.match(html, /data-cwd="\/a"/);
  assert.match(html, /data-cwd="\/b"/);
});
