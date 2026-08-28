import assert from "node:assert/strict";
import test from "node:test";
import { identifyKey, loadCredentials } from "../src/auth.js";

test("raw WebSocket tokens resolve without an Express request", () => {
  const credentials = loadCredentials("owner:human-key:human,agent:agent-key:agent");
  assert.deepEqual(identifyKey("agent-key", credentials), { name: "agent", role: "agent" });
  assert.equal(identifyKey("wrong-key", credentials), undefined);
});
