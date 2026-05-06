// UC-2.2 / 2.3 — mini-bar contents.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderMiniBarHtml } from "../../web/widget-pure.js";

function s(over = {}) {
  return {
    session_id: over.session_id ?? "id",
    name: over.name ?? "",
    status: over.status,
    last_event_at: over.last_event_at ?? 0,
    ...over,
  };
}

test("renderMiniBarHtml shows 'no waiting' italic when no waiting sessions", () => {
  const html = renderMiniBarHtml([
    s({ session_id: "1", status: "working" }),
    s({ session_id: "2", status: "done" }),
  ]);
  assert.match(html, /class="mini-empty">no waiting</);
});

test("renderMiniBarHtml lists each waiting session by name", () => {
  const html = renderMiniBarHtml([
    s({ session_id: "1", status: "waiting_input", name: "v6-alt" }),
    s({ session_id: "2", status: "waiting_input", name: "Health: general" }),
  ]);
  assert.match(html, /v6-alt/);
  assert.match(html, /Health: general/);
});

test("renderMiniBarHtml carries session_id on each waiting chip", () => {
  const html = renderMiniBarHtml([
    s({ session_id: "the-id", status: "waiting_input", name: "x" }),
  ]);
  assert.match(html, /data-id="the-id"/);
});

test("renderMiniBarHtml shows running and done counts", () => {
  const html = renderMiniBarHtml([
    s({ session_id: "1", status: "working" }),
    s({ session_id: "2", status: "working" }),
    s({ session_id: "3", status: "done" }),
  ]);
  // .n contains the number; surrounding text is "running" / "done"
  assert.match(html, /<span class="n">2<\/span>running/);
  assert.match(html, /<span class="n">1<\/span>done/);
});

test("renderMiniBarHtml adds .zero to counts that are 0", () => {
  const html = renderMiniBarHtml([
    s({ session_id: "1", status: "working" }),
  ]);
  // running has 1 → no .zero; done has 0 → .zero
  assert.match(html, /class="mini-count\s*"/);    // running
  assert.match(html, /class="mini-count zero"/);  // done
});

test("renderMiniBarHtml does NOT surface idle sessions", () => {
  const html = renderMiniBarHtml([
    s({ session_id: "1", status: "idle", name: "ignored" }),
  ]);
  assert.doesNotMatch(html, /ignored/);
});

test("renderMiniBarHtml escapes html in waiting names", () => {
  const html = renderMiniBarHtml([
    s({ session_id: "1", status: "waiting_input", name: "<img>" }),
  ]);
  assert.doesNotMatch(html, /<img>/);
  assert.match(html, /&lt;img&gt;/);
});

test("renderMiniBarHtml sorts waiting sessions by recency desc", () => {
  const html = renderMiniBarHtml([
    s({ session_id: "older", status: "waiting_input", name: "old", last_event_at: 100 }),
    s({ session_id: "newer", status: "waiting_input", name: "new", last_event_at: 999 }),
  ]);
  // 'new' should appear before 'old' in the resulting HTML.
  const iNew = html.indexOf("new");
  const iOld = html.indexOf("old");
  assert.ok(iNew < iOld, `expected newer first; new@${iNew} old@${iOld}`);
});
