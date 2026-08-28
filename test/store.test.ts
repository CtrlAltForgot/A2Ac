import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";

const alice = { name: "alice-agent", role: "agent" as const };
const bob = { name: "bob-agent", role: "agent" as const };
const setup = () => new Store(mkdtempSync(join(tmpdir(), "a2ac-test-")));

test("events preserve structured expandable context", () => {
  const store = setup();
  const event = store.event(alice, { kind: "action.edit", summary: "Changed the lobby", detail: { files: ["Lobby.server.lua"], tests: "passed" } });
  assert.equal(event.actor, "alice-agent");
  assert.deepEqual(event.detail, { files: ["Lobby.server.lua"], tests: "passed" });
});

test("resource claims prevent overlapping ownership and can be released", () => {
  const store = setup();
  store.claim(alice, "src/round-system", 30, "implementing rounds");
  assert.throws(() => store.claim(bob, "src/round-system", 30), /Already claimed by alice-agent/);
  store.release(alice, "src/round-system");
  assert.equal((store.claim(bob, "src/round-system", 30) as { owner: string }).owner, "bob-agent");
});

test("task versions reject stale agent updates", () => {
  const store = setup();
  const task = store.createTask(alice, { title: "Build inventory" }) as { id: number; version: number };
  store.updateTask(bob, task.id, { assignee: "bob-agent", status: "in_progress", expectedVersion: task.version });
  assert.throws(() => store.updateTask(alice, task.id, { status: "done", expectedVersion: task.version }), /Version conflict/);
});
