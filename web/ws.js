// Thin WebSocket client with auto-reconnect + a wake-up watchdog.
//
// A plain onclose->setTimeout reconnect is not enough here: the widget is a
// background, always-on-top Edge --app window that never holds focus, and
// Chromium/Edge throttle (or fully freeze) JS timers in such windows. After the
// server restarts — e.g. the machine reboots and the server comes back a moment
// later — the socket closes, but the queued reconnect timer may never fire, so
// the window silently sticks on its last frame (the "widget frozen after
// reboot" bug).
//
// The watchdog re-checks the connection on every signal that the page just woke
// up (regaining focus, becoming visible, the network coming back online) plus a
// slow interval as a floor, and reopens only when the socket is not already
// live — so it heals on its own the moment you glance at it, without ever
// stacking duplicate sockets.

export function connectWS({ onSnapshot, onUpsert, onRemove }) {
  let ws = null;
  let reconnectTimer = null;

  const isLive = () =>
    ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN);

  function open() {
    if (isLive()) return; // already connecting/open — don't stack sockets
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    ws = new WebSocket(`ws://${location.host}`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "snapshot")             onSnapshot(msg.sessions);
      else if (msg.type === "session_removed") onRemove(msg.session_id);
      else if (msg.session)                    onUpsert(msg.session);
    };
    ws.onclose = () => { reconnectTimer = setTimeout(open, 1000); };
    ws.onerror = () => {}; // close fires after error; reconnect is handled there
  }

  // Reopen if the socket died while the window was suspended and its reconnect
  // timer never got to run.
  const kick = () => { if (!isLive()) open(); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
  window.addEventListener("focus", kick);
  window.addEventListener("online", kick);
  setInterval(kick, 5000);

  open();
}
