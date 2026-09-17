// Reconnect watchdog — a suspended background widget window must heal itself.
//
// The window is a never-focused, always-on-top Edge --app view whose JS timers
// the browser can freeze. If the socket dies while frozen, the queued
// setTimeout reconnect may never fire; the watchdog must reopen on the next
// wake-up signal (focus / visibility / online) — and never stack sockets.

import { test } from "node:test";
import assert from "node:assert/strict";

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = FakeWS.CONNECTING;
    this.onmessage = this.onclose = this.onerror = null;
    FakeWS.instances.push(this);
  }
  _open() { this.readyState = FakeWS.OPEN; }
  _close() { this.readyState = FakeWS.CLOSED; if (this.onclose) this.onclose(); }
}

function makeBus(extra = {}) {
  const handlers = {};
  return {
    addEventListener: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
    _fire: (ev) => (handlers[ev] || []).forEach((f) => f()),
    ...extra,
  };
}

// Install fake globals, run body, always restore so sibling tests stay clean.
async function withEnv(body) {
  const saved = {
    WebSocket: globalThis.WebSocket,
    location: globalThis.location,
    document: globalThis.document,
    window: globalThis.window,
    setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  FakeWS.instances = [];
  const docBus = makeBus({ hidden: false });
  const winBus = makeBus();
  const timers = [];
  globalThis.WebSocket = FakeWS;
  globalThis.location = { host: "localhost:4173" };
  globalThis.document = docBus;
  globalThis.window = winBus;
  // Capture timer callbacks instead of firing them: models a frozen window and
  // keeps the assertions synchronous.
  globalThis.setInterval = (fn) => { timers.push(fn); return timers.length; };
  globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  globalThis.clearTimeout = () => {};
  try {
    // Bust the module cache so each test gets fresh closure state.
    const { connectWS } = await import(`../../web/ws.js?bust=${Math.random()}`);
    await body({ connectWS, docBus, winBus, timers });
  } finally {
    Object.assign(globalThis, saved);
  }
}

test("watchdog reopens a dead socket on focus, without stacking sockets", async () => {
  await withEnv(async ({ connectWS, winBus }) => {
    connectWS({ onSnapshot() {}, onUpsert() {}, onRemove() {} });

    assert.equal(FakeWS.instances.length, 1, "one socket at startup");
    const first = FakeWS.instances[0];
    first._open();

    // Server restarts: socket closes. Its reconnect timer is queued but (frozen
    // window) never fires, so no new socket appears on its own.
    first._close();
    assert.equal(FakeWS.instances.length, 1, "no reconnect while frozen");

    // Window regains focus -> watchdog opens a fresh socket.
    winBus._fire("focus");
    assert.equal(FakeWS.instances.length, 2, "focus heals the connection");

    // Focus again while the new socket is live -> no duplicate.
    FakeWS.instances[1]._open();
    winBus._fire("focus");
    assert.equal(FakeWS.instances.length, 2, "live socket is not duplicated");
  });
});

test("visibilitychange only reconnects when the page is actually visible", async () => {
  await withEnv(async ({ connectWS, docBus }) => {
    connectWS({ onSnapshot() {}, onUpsert() {}, onRemove() {} });
    FakeWS.instances[0]._open();
    FakeWS.instances[0]._close();

    docBus.hidden = true;
    docBus._fire("visibilitychange");
    assert.equal(FakeWS.instances.length, 1, "still hidden: no reconnect");

    docBus.hidden = false;
    docBus._fire("visibilitychange");
    assert.equal(FakeWS.instances.length, 2, "became visible: reconnect");
  });
});

test("snapshot / upsert / remove messages are routed by type", async () => {
  await withEnv(async ({ connectWS }) => {
    const seen = { snap: null, up: null, rm: null };
    connectWS({
      onSnapshot: (s) => { seen.snap = s; },
      onUpsert: (s) => { seen.up = s; },
      onRemove: (id) => { seen.rm = id; },
    });
    const ws = FakeWS.instances[0];
    ws.onmessage({ data: JSON.stringify({ type: "snapshot", sessions: [1, 2] }) });
    ws.onmessage({ data: JSON.stringify({ type: "session_removed", session_id: "x" }) });
    ws.onmessage({ data: JSON.stringify({ session: { session_id: "y" } }) });
    assert.deepEqual(seen.snap, [1, 2]);
    assert.equal(seen.rm, "x");
    assert.deepEqual(seen.up, { session_id: "y" });
  });
});
