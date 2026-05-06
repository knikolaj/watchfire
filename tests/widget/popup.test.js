// UC-1.8 — chats popup HTML structure (active + non-active rows).

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderChatsPopupHtml } from "../../web/widget-pure.js";

const A = (over = {}) => ({
  session_id: over.session_id ?? "active-id",
  cwd: over.cwd ?? "/x",
  agent: over.agent ?? "claude",
  name: over.name ?? "",
  first_prompt: over.first_prompt ?? "",
  status: over.status ?? "working",
  last_event_at: over.last_event_at ?? 0,
});

const I = (over = {}) => ({
  session_id: over.session_id ?? "inactive-id",
  cwd: over.cwd ?? "/x",
  agent: over.agent ?? "claude",
  name: over.name ?? "",
  first_prompt: over.first_prompt ?? "",
});

test("renderChatsPopupHtml shows 'No chats yet' when both lists empty", () => {
  const html = renderChatsPopupHtml([], [], "/x");
  assert.match(html, /No chats yet/);
});

test("renderChatsPopupHtml emits both active and inactive rows", () => {
  const html = renderChatsPopupHtml(
    [A({ session_id: "1", name: "active-one", status: "working" })],
    [I({ session_id: "2", name: "non-active-one" })],
    "/proj",
  );
  assert.match(html, /chat-row(?!\s+inactive)[^"]*"/);  // an active row exists
  assert.match(html, /chat-row inactive/);
  assert.match(html, /active-one/);
  assert.match(html, /non-active-one/);
});

test("renderChatsPopupHtml labels inactive rows as 'non active'", () => {
  const html = renderChatsPopupHtml([], [I({ name: "x" })], "/p");
  assert.match(html, /non active/);
});

test("renderChatsPopupHtml uses status palette for active dot color", () => {
  const html = renderChatsPopupHtml(
    [A({ status: "waiting_input", name: "n" })],
    [],
    "/p",
  );
  // waiting_input → #ef476f
  assert.match(html, /background:#ef476f/);
});

test("renderChatsPopupHtml sorts active rows by last_event_at desc", () => {
  const html = renderChatsPopupHtml(
    [
      A({ session_id: "a", name: "old", last_event_at: 100 }),
      A({ session_id: "b", name: "new", last_event_at: 999 }),
    ],
    [], "/p",
  );
  const iNew = html.indexOf("new");
  const iOld = html.indexOf("old");
  assert.ok(iNew < iOld, `expected newer first; new@${iNew} old@${iOld}`);
});

test("renderChatsPopupHtml puts active rows before inactive", () => {
  const html = renderChatsPopupHtml(
    [A({ name: "alive" })],
    [I({ name: "dormant" })],
    "/p",
  );
  const iA = html.indexOf("alive");
  const iD = html.indexOf("dormant");
  assert.ok(iA < iD);
});

test("renderChatsPopupHtml falls back to first_prompt then session_id for names", () => {
  const html = renderChatsPopupHtml(
    [],
    [
      I({ session_id: "ses12345", name: "", first_prompt: "" }),
      I({ session_id: "y", name: "", first_prompt: "from prompt" }),
    ],
    "/p",
  );
  assert.match(html, /ses12345/);   // first chat — only session_id is non-empty
  assert.match(html, /from prompt/);
});

test("renderChatsPopupHtml escapes html in chat names", () => {
  const html = renderChatsPopupHtml(
    [A({ name: "<bad>" })],
    [I({ name: "<also-bad>" })],
    "/p",
  );
  assert.doesNotMatch(html, /<bad>/);
  assert.doesNotMatch(html, /<also-bad>/);
  assert.match(html, /&lt;bad&gt;/);
  assert.match(html, /&lt;also-bad&gt;/);
});
