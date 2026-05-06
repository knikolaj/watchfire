// UC-1.2 / 1.3 / 1.4 — format helpers as seen in each row.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shortPath, fmtElapsed, fmtLimit, statusLabel,
  pctClass, nameOrPrompt, escape, escapeAttr,
} from "../../web/widget-pure.js";

// --- shortPath ------------------------------------------------------------

test("shortPath returns last two segments", () => {
  assert.equal(shortPath("/home/nj/projects/palisade/self-replication"),
               "palisade/self-replication");
  assert.equal(shortPath("/mnt/c/users/23738"), "users/23738");
});

test("shortPath handles short and missing paths", () => {
  assert.equal(shortPath(""), "(unknown)");
  assert.equal(shortPath(null), "(unknown)");
  assert.equal(shortPath("/single"), "single");
});

// --- fmtElapsed -----------------------------------------------------------

test("fmtElapsed across all unit thresholds", () => {
  assert.equal(fmtElapsed(0),     "0s");
  assert.equal(fmtElapsed(45),    "45s");
  assert.equal(fmtElapsed(60),    "1:00");
  assert.equal(fmtElapsed(83),    "1:23");
  assert.equal(fmtElapsed(3599),  "59:59");
  assert.equal(fmtElapsed(3600),  "1h");
  assert.equal(fmtElapsed(7200),  "2h");
  assert.equal(fmtElapsed(86_399), "23h");
  assert.equal(fmtElapsed(86_400), "1d");
  assert.equal(fmtElapsed(345_600), "4d");
});

// --- fmtLimit -------------------------------------------------------------

test("fmtLimit formats 1M / 256K / 0", () => {
  assert.equal(fmtLimit(1_000_000), "1M");
  assert.equal(fmtLimit(258_400),   "258K");
  assert.equal(fmtLimit(200_000),   "200K");
  assert.equal(fmtLimit(0),  "");
  assert.equal(fmtLimit(undefined), "");
});

// --- statusLabel ----------------------------------------------------------

test("statusLabel renames working→running, others passthrough", () => {
  assert.equal(statusLabel("working"),       "running");
  assert.equal(statusLabel("waiting_input"), "waiting");
  assert.equal(statusLabel("done"),          "done");
  assert.equal(statusLabel("idle"),          "idle");
  assert.equal(statusLabel("anything-else"), "anything-else");
});

// --- pctClass --------------------------------------------------------------

test("pctClass thresholds at 50 / 80", () => {
  assert.equal(pctClass(0),   "");
  assert.equal(pctClass(49),  "");
  assert.equal(pctClass(50),  "warn");
  assert.equal(pctClass(79),  "warn");
  assert.equal(pctClass(80),  "danger");
  assert.equal(pctClass(100), "danger");
});

// --- nameOrPrompt ---------------------------------------------------------

test("nameOrPrompt prefers customTitle name", () => {
  assert.equal(nameOrPrompt({ name: "v6", first_prompt: "x", session_id: "abc12345" }), "v6");
});

test("nameOrPrompt falls back to first_prompt when name is missing", () => {
  assert.equal(nameOrPrompt({ first_prompt: "first", last_prompt: "last", session_id: "abc12345" }), "first");
});

test("nameOrPrompt falls back to last_prompt when first is missing", () => {
  assert.equal(nameOrPrompt({ last_prompt: "ok", session_id: "abc12345" }), "ok");
});

test("nameOrPrompt falls back to session_id prefix as last resort", () => {
  assert.equal(nameOrPrompt({ session_id: "abc12345-rest" }), "abc12345");
});

test("nameOrPrompt trims whitespace-only prompts", () => {
  // "    " should NOT count as a prompt — fall through to the next option.
  assert.equal(nameOrPrompt({ first_prompt: "   ", last_prompt: "real", session_id: "x" }), "real");
});

// --- escape ---------------------------------------------------------------

test("escape replaces all html-active characters", () => {
  assert.equal(escape("<a>&\"'"), "&lt;a&gt;&amp;&quot;&#39;");
});

test("escape coerces null/undefined to empty string", () => {
  assert.equal(escape(null), "");
  assert.equal(escape(undefined), "");
  assert.equal(escapeAttr(null), "");
});
