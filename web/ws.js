// Thin WebSocket client with auto-reconnect.

export function connectWS({ onSnapshot, onUpsert, onRemove }) {
  let ws;
  function open() {
    ws = new WebSocket(`ws://${location.host}`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "snapshot")          onSnapshot(msg.sessions);
      else if (msg.type === "session_removed") onRemove(msg.session_id);
      else if (msg.session)                  onUpsert(msg.session);
    };
    ws.onclose = () => setTimeout(open, 1000);
    ws.onerror = () => {};
  }
  open();
}
