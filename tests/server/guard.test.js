import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedRequest, isValidSessionId } from "../../server/guard.js";

const P = 4173;

test("same-origin browser request is allowed", () => {
  assert.ok(isAllowedRequest({ host: "localhost:4173", origin: "http://localhost:4173" }, P));
  assert.ok(isAllowedRequest({ host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173" }, P));
});

test("non-browser client without Origin is allowed", () => {
  assert.ok(isAllowedRequest({ host: "localhost:4173" }, P));
});

test("cross-site Origin is rejected", () => {
  assert.equal(isAllowedRequest({ host: "localhost:4173", origin: "https://evil.example" }, P), false);
  assert.equal(isAllowedRequest({ host: "localhost:4173", origin: "null" }, P), false);
  assert.equal(isAllowedRequest({ host: "localhost:4173", origin: "http://localhost:9999" }, P), false);
});

test("DNS-rebinding Host is rejected even without Origin", () => {
  assert.equal(isAllowedRequest({ host: "evil.example:4173" }, P), false);
  assert.equal(isAllowedRequest({ host: "192.168.1.20:4173" }, P), false);
  assert.equal(isAllowedRequest({}, P), false);
});

test("session ids: UUIDs pass, anything else fails", () => {
  assert.ok(isValidSessionId("058e9982-7355-4a48-8178-330e46ddc97a"));       // claude, v4
  assert.ok(isValidSessionId("019d1234-5678-7abc-9def-0123456789ab"));       // codex, v7
  for (const bad of ["", "abc", "x ; nt cmd.exe", "058e9982-7355-4a48-8178-330e46ddc97a;calc",
                     "058e9982-7355-4a48-8178-330e46ddc97a ", undefined, null, 42]) {
    assert.equal(isValidSessionId(bad), false, String(bad));
  }
});
