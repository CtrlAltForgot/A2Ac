import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("team missions stay scoped to their project channel", () => {
  const store = setup();
  store.setActiveChannel(alice, "dig-frenzy");
  const mission = store.createTask(alice, { title: "Ship the mining loop", assignee: "team" }) as { assignee: string; channel: string };
  assert.equal(mission.assignee, "team");
  assert.equal(mission.channel, "dig-frenzy");
  assert.equal(store.tasks("dig-frenzy").length, 1);
  assert.equal(store.tasks("general").length, 0);
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

test("initial event reads return the newest bounded channel context", () => {
  const store = setup();
  for (let index = 1; index <= 5; index++) store.event(alice, { channel: "project", kind: "message", summary: `message ${index}` });
  const recent = store.events("project", 0, 2) as { summary: string }[];
  assert.deepEqual(recent.map((event) => event.summary), ["message 4", "message 5"]);
});

test("channel inbox tracks unanswered human posts without duplicating message text", () => {
  const store = setup();
  const human = { name: "alice", role: "human" as const };
  const post = store.event(human, { channel: "project", kind: "message", summary: "Can anyone review this?" }) as { id:number };
  assert.deepEqual(store.unansweredHumanEventIds("project"), [post.id]);
  store.event(alice, { channel: "project", kind: "message", summary: "I can review it.", parentId:post.id });
  assert.deepEqual(store.unansweredHumanEventIds("project"), []);
});

test("ambient chat is opt-in and coalesces a channel burst", () => {
  const store = setup();
  const human = { name: "alice", role: "human" as const };
  store.updateProfile(alice.name, { ambientChat:true });
  store.queueAmbientReply(human,alice.name,{id:101,channel:"project",summary:"What do you think?"});
  store.queueAmbientReply(human,alice.name,{id:102,channel:"project",summary:"Could you check the image too?"});
  const pending=store.delegationsFor(alice.name) as {source_event_id:number;request_type:string}[];
  assert.equal(pending.length,1);
  assert.equal(pending[0].source_event_id,102);
  assert.equal(pending[0].request_type,"ambient");
  assert.equal((store.claimNextDelegation(alice.name) as {source_event_id:number}).source_event_id,102);
});

test("one ambient message is assigned to only one opted-in agent", () => {
  const store = setup();
  const human = { name: "owner", role: "human" as const };
  store.updateProfile(alice.name, { ambientChat:true });
  store.updateProfile(bob.name, { ambientChat:true });
  assert.ok(store.queueAmbientReply(human,alice.name,{id:201,channel:"general",summary:"Anyone around?"}));
  assert.equal(store.queueAmbientReply(human,bob.name,{id:201,channel:"general",summary:"Anyone around?"}),null);
  assert.equal(store.delegationsFor(alice.name).length,1);
  assert.equal(store.delegationsFor(bob.name).length,0);
});

test("rapid ambient follow-ups queue behind the same running agent", () => {
  const store=setup(),human={name:"owner",role:"human" as const};
  store.updateProfile(alice.name,{ambientChat:true});
  store.queueAmbientReply(human,alice.name,{id:301,channel:"general",summary:"First thought"});
  assert.equal((store.claimNextDelegation(alice.name) as {source_event_id:number}).source_event_id,301);
  assert.equal(store.activeAmbientAgent("general"),alice.name);
  store.queueAmbientReply(human,alice.name,{id:302,channel:"general",summary:"and one more detail"});
  const followUp=store.claimNextAmbient(alice.name,"general") as {source_event_id:number;request:string};
  assert.equal(followUp.source_event_id,302);
  assert.match(followUp.request,/one more detail/);
});

test("team wake waits for a busy agent and becomes claimable when idle", () => {
  const store = setup();
  const owner = { name: "owner", role: "human" as const };
  store.updateProfile(alice.name, { acceptDelegations:true });
  const task=store.createTask(owner,{title:"Ship together",assignee:"team",channel:"project"}) as {id:number};
  store.updateActivity(alice,{channel:"other-project",title:"Existing work",status:"working"});
  store.requestDelegation(owner,alice.name,"Join the team mission","project",{requestType:"team",taskId:task.id});
  assert.equal(store.claimNextDelegation(alice.name),null);
  assert.equal(store.delegationsFor(alice.name).length,0);
  store.updateActivity(alice,{channel:"other-project",title:"Existing work",status:"completed"});
  assert.equal(store.delegationsFor(alice.name).length,1);
  assert.equal((store.claimNextDelegation(alice.name) as {task_id:number}).task_id,task.id);
});

test("finishing a team task cancels queued wakes", () => {
  const store = setup();
  const owner = { name: "owner", role: "human" as const };
  store.updateProfile(alice.name, { acceptDelegations:true });
  const task=store.createTask(owner,{title:"Short mission",assignee:"team",channel:"project"}) as {id:number};
  store.updateActivity(alice,{channel:"project",title:"Busy",status:"working"});
  store.requestDelegation(owner,alice.name,"Join later","project",{requestType:"team",taskId:task.id});
  store.updateTask(owner,task.id,{status:"done"});
  assert.equal(store.delegationsFor(alice.name).length,0);
  store.updateActivity(alice,{channel:"project",title:"Busy",status:"completed"});
  assert.equal(store.claimNextDelegation(alice.name),null);
});

test("temporary attachments can be renewed and expired bytes are deleted", () => {
  const store=setup(),storedName="temporary-upload";
  writeFileSync(join(store.uploadsDir,storedName),"artifact");
  const item=store.createAttachment(alice,{id:"11111111-1111-4111-8111-111111111111",filename:"artifact.txt",mimeType:"text/plain",size:8,storedName}) as {expires_at:string};
  const renewed=store.renewAttachment(alice,"11111111-1111-4111-8111-111111111111",14) as {expires_at:string};
  assert.ok(renewed.expires_at>item.expires_at);
  store.db.prepare("UPDATE attachments SET expires_at=datetime('now','-1 minute') WHERE id=?").run("11111111-1111-4111-8111-111111111111");
  assert.equal(store.cleanupExpiredAttachments(),1);
  assert.equal(existsSync(join(store.uploadsDir,storedName)),false);
});
