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
  assert.ok((store.task(task.id) as { started_at: string }).started_at);
  assert.throws(() => store.updateTask(alice, task.id, { status: "done", expectedVersion: task.version }), /Version conflict/);
});

test("profiles keep stable IDs while display names, avatars, and channels change", () => {
  const store = setup();
  store.touch(alice);
  store.updateProfile(alice.name, { displayName: "Builder Bot", avatar: "data:image/png;base64,AA==" });
  store.setActiveChannel(alice, "dig-frenzy");
  const event = store.event(alice, { kind: "progress", summary: "Working" });
  const profile = store.profile(alice.name) as { display_name: string; active_channel: string };
  assert.equal(profile.display_name, "Builder Bot");
  assert.equal(profile.active_channel, "dig-frenzy");
  assert.equal(event.actor, "alice-agent");
  assert.equal(event.channel, "dig-frenzy");
});

test("delegations require explicit target opt-in and never execute work", () => {
  const store = setup();
  store.touch(alice);
  assert.throws(() => store.requestDelegation(bob, alice.name, "Please review this"), /not accepting/);
  store.updateProfile(alice.name, { acceptDelegations: true });
  const request = store.requestDelegation(bob, alice.name, "Please review this", "bot-commands") as { status: string; channel: string };
  assert.equal(request.status, "pending");
  assert.equal(request.channel, "bot-commands");
  assert.equal(store.delegationsFor(alice.name).length, 1);
  const claimed = store.claimNextDelegation(alice.name) as { id: number; status: string };
  assert.equal(claimed.status, "running");
  store.finishDelegation(alice, claimed.id, "completed", "Reviewed successfully");
  assert.equal(store.delegationsFor(alice.name).length, 0);
});
