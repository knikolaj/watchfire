// Resume into herdr: workspace choice, the exact CLI calls, and that only the
// agent + session id ever reach `pane run` (which types into a shell).

import { test } from "node:test";
import assert from "node:assert/strict";

import { pickWorkspace, resumeInHerdr, herdrBin } from "../../server/herdr.js";

const WS = [
  { workspace_id: "w1", label: "flyt" },
  { workspace_id: "w2", label: "digest" },
];
const PANES = [
  { workspace_id: "w1", pane_id: "w1:p1", cwd: "/p/flyt", foreground_cwd: "/p/flyt/sub" },
  { workspace_id: "w2", pane_id: "w2:p1", cwd: "/p/other", foreground_cwd: "/p/other" },
];
const ID = "01a136e8-b951-7d62-b521-346d4f2196b1";

test("pickWorkspace: pane cwd first, then label, else none", () => {
  assert.equal(pickWorkspace(WS, PANES, "/p/other"), "w2", "by pane cwd");
  assert.equal(pickWorkspace(WS, PANES, "/p/flyt/sub"), "w1", "by foreground cwd");
  assert.equal(pickWorkspace(WS, PANES, "/x/digest"), "w2", "by label");
  assert.equal(pickWorkspace(WS, PANES, "/p/new"), null);
  assert.equal(pickWorkspace(WS, PANES, ""), null);
});

function fakeHerdr(created) {
  const calls = [];
  const exec = async (bin, args) => {
    calls.push(args);
    if (args[0] === "workspace" && args[1] === "list") return { workspaces: WS };
    if (args[0] === "pane" && args[1] === "list") return { panes: PANES };
    if (args[1] === "create") return { root_pane: { pane_id: created } };
    return {};
  };
  return { calls, exec };
}

test("existing project: new tab in its workspace, then the resume command", async () => {
  const { calls, exec } = fakeHerdr("w2:p9");
  const r = await resumeInHerdr(
    { agent: "codex", cwd: "/p/other", sessionId: ID, name: "it's; rm -rf ~" },
    { bin: "herdr", exec });
  assert.deepEqual(r, { ok: true, pane_id: "w2:p9" });
  assert.deepEqual(calls.slice(2), [
    ["tab", "create", "--workspace", "w2", "--cwd", "/p/other", "--label", "it's; rm -rf ~", "--focus"],
    ["workspace", "focus", "w2"],
    ["pane", "run", "w2:p9", "codex", "resume", ID],
  ]);
});

test("unknown project: a new workspace named after the folder", async () => {
  const { calls, exec } = fakeHerdr("w3:p1");
  const r = await resumeInHerdr(
    { agent: "claude", cwd: "/p/new proj", sessionId: ID, name: "" },
    { bin: "herdr", exec });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.slice(2), [
    ["workspace", "create", "--cwd", "/p/new proj", "--label", "new proj", "--focus"],
    ["pane", "run", "w3:p1", "claude", "--resume", ID],
  ]);
});

test("errors are reported, not thrown", async () => {
  assert.deepEqual(await resumeInHerdr({ agent: "claude", sessionId: ID }, { bin: null }),
    { ok: false, err: "herdr_not_installed" });
  const r = await resumeInHerdr({ agent: "claude", sessionId: ID },
    { bin: "herdr", exec: async () => { throw new Error("server not running"); } });
  assert.deepEqual(r, { ok: false, err: "herdr_failed", msg: "server not running" });
});

test("herdrBin: env override, then PATH, then ~/.local/bin", () => {
  assert.equal(herdrBin({ HERDR_BIN: "/opt/h" }, () => false), "/opt/h");
  assert.equal(herdrBin({ PATH: "/a:/b" }, (p) => p === "/b/herdr"), "/b/herdr");
  assert.match(herdrBin({ PATH: "" }, (p) => p.endsWith("/.local/bin/herdr")), /\.local\/bin\/herdr$/);
  assert.equal(herdrBin({ PATH: "/a" }, () => false), null);
});

test("focusInHerdr focuses the agent by pane id; errors are reported", async () => {
  const { focusInHerdr } = await import("../../server/herdr.js");
  const calls = [];
  assert.deepEqual(await focusInHerdr("w1:p3", { bin: "herdr", exec: async (b, a) => { calls.push(a); return {}; } }), { ok: true });
  assert.deepEqual(calls, [["agent", "focus", "w1:p3"]]);
  const r = await focusInHerdr("w9:p9", { bin: "herdr", exec: async () => { throw new Error("no such pane"); } });
  assert.deepEqual(r, { ok: false, err: "herdr_failed", msg: "no such pane" });
});

test("matchPanesByTitle: name + folder, one-to-one only", async () => {
  const { matchPanesByTitle } = await import("../../server/herdr.js");
  const agent = (pane_id, title, cwd = "/p/flyt") =>
    ({ agent: "codex", pane_id, cwd, foreground_cwd: cwd, terminal_title_stripped: title });
  const s = (session_id, name, cwd = "/p/flyt") => ({ session_id, agent: "codex", cwd, name });

  const m = matchPanesByTitle(
    [s("a", "Strava Import"), s("b", "WHOOP"), s("c", "Twin"), s("d", "Twin"), s("e", "")],
    [agent("w1:p1", "Strava Import | GPT-6.1-Sol"),
     agent("w1:p2", "WHOOP | GPT-6.1-Sol", "/p/other"),   // same name, other folder
     agent("w1:p3", "Twin | GPT-6.1-Sol"),                 // two sessions named Twin
     agent("w1:p4", "Strava Importer | GPT-6.1-Sol"),      // prefix of another name
     { agent: "claude", pane_id: "w1:p5", cwd: "/p/flyt", terminal_title_stripped: "WHOOP" }]);
  assert.deepEqual([...m], [["a", "w1:p1"]]);
});

test("listHerdrAgents: [] when herdr is missing or fails", async () => {
  const { listHerdrAgents } = await import("../../server/herdr.js");
  assert.deepEqual(await listHerdrAgents({ bin: null }), []);
  assert.deepEqual(await listHerdrAgents({ bin: "h", exec: async () => { throw new Error("x"); } }), []);
  assert.deepEqual(await listHerdrAgents({ bin: "h", exec: async () => ({ agents: [{ pane_id: "w1:p1" }] }) }),
    [{ pane_id: "w1:p1" }]);
});

test("matchPanesByThreadId: the session UUID in the pane title is an exact match", async () => {
  const { matchPanesByThreadId } = await import("../../server/herdr.js");
  const m = matchPanesByThreadId([ID, "01a12cf7-21a8-7a91-b295-483f2e73097a"], [
    { agent: "codex", pane_id: "w1:p2", terminal_title_stripped: `Strava Import | GPT-6.1-Sol | ${ID}` },
    { agent: "codex", pane_id: "w1:p3", terminal_title_stripped: "untitled | GPT-6.1-Sol" },
    { agent: "codex", pane_id: "w1:p4", terminal_title_stripped: "x | 99999999-9999-7999-8999-999999999999" },
    // As Codex really shows it: first 29 characters + "...".
    { agent: "codex", pane_id: "w1:p5", terminal_title_stripped: "WHOOP | GPT-6.1-Sol | 01a12cf7-21a8-7a91-b295-483f2..." },
  ]);
  assert.deepEqual([...m], [[ID, "w1:p2"], ["01a12cf7-21a8-7a91-b295-483f2e73097a", "w1:p5"]]);
});

test("matchPanesByThreadId skips a prefix shared by two open sessions", async () => {
  const { matchPanesByThreadId } = await import("../../server/herdr.js");
  const a = "01a12cf7-21a8-7a91-b295-483f2e73097a", b = "01a12cf7-21a8-7a91-b295-483f2fffffff";
  const m = matchPanesByThreadId([a, b],
    [{ agent: "codex", pane_id: "w1:p1", terminal_title_stripped: "x | 01a12cf7-21a8-7a91-b295-483f2..." }]);
  assert.equal(m.size, 0);
});
