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
