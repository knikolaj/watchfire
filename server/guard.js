// Request guards for the local server.
//
// The server can open Windows Terminal tabs and launch agents (/resume), switch
// tabs (/focus) and streams live session state over WebSocket. None of that has
// authentication, so it must only ever be reachable by pages the server itself
// served. Three layers:
//
// 1. Bind to loopback (see index.js) — nothing on the network reaches the port,
//    in any WSL networking mode. Under `networkingMode=mirrored` a wildcard bind
//    would put the port on every Wi-Fi the laptop joins.
// 2. Host check — defeats DNS rebinding: a page on attacker.example that
//    re-resolves to 127.0.0.1 still sends `Host: attacker.example:4173`.
// 3. Origin check — defeats cross-site requests from any tab in the browser.
//    Browsers send Origin on cross-origin fetches and on every WebSocket
//    handshake; WebSockets are not covered by CORS, so without this any site
//    could read the live session stream. A request with no Origin comes from a
//    non-browser client (curl, the CLI) and is allowed — it already has local
//    access. `Origin: null` (sandboxed iframe, file://) is rejected.

export const HOST = "127.0.0.1";

export function allowedHosts(port) {
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
}

export function allowedOrigins(port) {
  return new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
}

export function isAllowedRequest(headers, port) {
  if (!allowedHosts(port).has(headers.host)) return false;
  const origin = headers.origin;
  return origin === undefined || allowedOrigins(port).has(origin);
}

// Claude and Codex session ids are both UUIDs (Codex uses v7, same shape). The
// id is passed to wt.exe, which re-splits its command line on `;` and drops
// quoting — so anything but a strict UUID must never get that far.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(id) {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}
