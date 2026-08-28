import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EventInput, Identity } from "./types.js";

export class Store {
  readonly db: Database.Database;
  onChange: (type: string, value: unknown) => void = () => {};

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "a2ac.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, channel TEXT NOT NULL DEFAULT 'general', kind TEXT NOT NULL,
        actor TEXT NOT NULL, actor_role TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT,
        task_id INTEGER, parent_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'normal',
        assignee TEXT, created_by TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        started_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS claims (
        resource TEXT PRIMARY KEY, owner TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS presence (
        name TEXT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL, current_task TEXT,
        last_seen TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS profiles (
        name TEXT PRIMARY KEY, display_name TEXT NOT NULL, avatar TEXT,
        active_channel TEXT NOT NULL DEFAULT 'general', accept_delegations INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS delegation_requests (
        id INTEGER PRIMARY KEY, requester TEXT NOT NULL, target_agent TEXT NOT NULL,
        channel TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), claimed_at TEXT, finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS events_channel_id ON events(channel, id DESC);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, updated_at DESC);
    `);
    const profileColumns = this.db.pragma("table_info(profiles)") as { name: string }[];
    if (!profileColumns.some((column) => column.name === "accept_delegations")) this.db.exec("ALTER TABLE profiles ADD COLUMN accept_delegations INTEGER NOT NULL DEFAULT 0");
    const taskColumns = this.db.pragma("table_info(tasks)") as { name: string }[];
    if (!taskColumns.some((column) => column.name === "started_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN started_at TEXT");
      this.db.exec("UPDATE tasks SET started_at=updated_at WHERE status IN ('in_progress','blocked')");
    }
    const delegationColumns = this.db.pragma("table_info(delegation_requests)") as { name: string }[];
    if (!delegationColumns.some((column) => column.name === "claimed_at")) this.db.exec("ALTER TABLE delegation_requests ADD COLUMN claimed_at TEXT");
    if (!delegationColumns.some((column) => column.name === "finished_at")) this.db.exec("ALTER TABLE delegation_requests ADD COLUMN finished_at TEXT");
  }

  private parse(row: Record<string, unknown>): Record<string, unknown> {
    if (typeof row["detail"] === "string") {
      try { row["detail"] = JSON.parse(row["detail"]); } catch { /* keep text */ }
    }
    return row;
  }

  event(identity: Identity, input: EventInput) {
    const result = this.db.prepare(`INSERT INTO events
      (channel, kind, actor, actor_role, summary, detail, task_id, parent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.channel ?? this.activeChannel(identity.name), input.kind, identity.name, identity.role, input.summary,
        input.detail === undefined ? null : JSON.stringify(input.detail), input.taskId ?? null, input.parentId ?? null);
    const value = this.getEvent(Number(result.lastInsertRowid));
    this.touch(identity, "online");
    this.onChange("event", value);
    return value;
  }

  getEvent(id: number) {
    return this.parse(this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown>);
  }

  events(channel = "general", after = 0, limit = 100) {
    return (this.db.prepare("SELECT * FROM events WHERE channel = ? AND id > ? ORDER BY id ASC LIMIT ?")
      .all(channel, after, Math.min(limit, 250)) as Record<string, unknown>[]).map((row) => this.parse(row));
  }

  channels() {
    return this.db.prepare(`SELECT channel, COUNT(*) count, MAX(id) last_event_id
      FROM events GROUP BY channel ORDER BY MAX(id) DESC`).all();
  }

  createTask(identity: Identity, input: { title: string; description?: string; priority?: string; assignee?: string }) {
    const result = this.db.prepare(`INSERT INTO tasks (title, description, priority, assignee, created_by)
      VALUES (?, ?, ?, ?, ?)`).run(input.title, input.description ?? "", input.priority ?? "normal", input.assignee ?? null, identity.name);
    const value = this.task(Number(result.lastInsertRowid));
    this.event(identity, { kind: "task.created", summary: `Created task: ${input.title}`, taskId: Number(result.lastInsertRowid), detail: value });
    this.onChange("task", value);
    return value;
  }

  task(id: number) { return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id); }
  tasks() { return this.db.prepare("SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, updated_at DESC").all(); }

  updateTask(identity: Identity, id: number, patch: { status?: string; assignee?: string | null; description?: string; expectedVersion?: number }) {
    const current = this.task(id) as Record<string, unknown> | undefined;
    if (!current) throw new Error("Task not found");
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== current.version) throw new Error(`Version conflict: task is at version ${current.version}`);
    const status = patch.status ?? current.status;
    if (!["open", "in_progress", "blocked", "done", "cancelled"].includes(String(status))) throw new Error("Invalid task status");
    const startedAt = status === "in_progress" && current.status !== "in_progress" ? new Date().toISOString().replace("T", " ").slice(0, 19) : current.started_at;
    this.db.prepare(`UPDATE tasks SET status=?, assignee=?, description=?, started_at=?, version=version+1,
      updated_at=datetime('now') WHERE id=?`).run(status, patch.assignee === undefined ? current.assignee : patch.assignee,
        patch.description ?? current.description, startedAt ?? null, id);
    const value = this.task(id);
    this.event(identity, { kind: "task.updated", summary: `Updated task #${id} to ${status}`, taskId: id, detail: { patch, task: value } });
    this.onChange("task", value);
    return value;
  }

  claim(identity: Identity, resource: string, ttlMinutes: number, reason = "") {
    this.db.prepare("DELETE FROM claims WHERE expires_at <= datetime('now')").run();
    const existing = this.db.prepare("SELECT * FROM claims WHERE resource = ?").get(resource) as { owner: string } | undefined;
    if (existing && existing.owner !== identity.name) throw new Error(`Already claimed by ${existing.owner}`);
    this.db.prepare(`INSERT INTO claims(resource, owner, reason, expires_at) VALUES (?, ?, ?, datetime('now', ?))
      ON CONFLICT(resource) DO UPDATE SET reason=excluded.reason, expires_at=excluded.expires_at`)
      .run(resource, identity.name, reason, `+${Math.max(1, Math.min(ttlMinutes, 240))} minutes`);
    const value = this.db.prepare("SELECT * FROM claims WHERE resource = ?").get(resource);
    this.event(identity, { kind: "claim.acquired", summary: `Claimed ${resource}`, detail: value });
    this.onChange("claim", value);
    return value;
  }

  release(identity: Identity, resource: string) {
    const result = this.db.prepare("DELETE FROM claims WHERE resource=? AND owner=?").run(resource, identity.name);
    if (!result.changes) throw new Error("Claim not found or owned by another identity");
    this.event(identity, { kind: "claim.released", summary: `Released ${resource}` });
    this.onChange("claim", { resource, released: true });
    return { resource, released: true };
  }

  claims() {
    this.db.prepare("DELETE FROM claims WHERE expires_at <= datetime('now')").run();
    return this.db.prepare("SELECT * FROM claims ORDER BY resource").all();
  }

  touch(identity: Identity, status = "online", currentTask?: string) {
    this.ensureProfile(identity.name);
    this.db.prepare(`INSERT INTO presence(name, role, status, current_task, last_seen) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET role=excluded.role,status=excluded.status,current_task=excluded.current_task,last_seen=datetime('now')`)
      .run(identity.name, identity.role, status, currentTask ?? null);
    const value = this.db.prepare("SELECT * FROM presence WHERE name=?").get(identity.name);
    this.onChange("presence", value);
    return value;
  }

  presence() { return this.db.prepare(`SELECT p.*, COALESCE(f.display_name,p.name) display_name, f.avatar, f.active_channel
    FROM presence p LEFT JOIN profiles f ON f.name=p.name ORDER BY p.last_seen DESC`).all(); }

  ensureProfile(name: string) {
    this.db.prepare("INSERT OR IGNORE INTO profiles(name,display_name) VALUES (?,?)").run(name, name);
    return this.profile(name);
  }

  profile(name: string) { return this.db.prepare("SELECT * FROM profiles WHERE name=?").get(name); }

  profiles() { return this.db.prepare("SELECT * FROM profiles ORDER BY display_name").all(); }

  updateProfile(name: string, patch: { displayName?: string; avatar?: string | null; acceptDelegations?: boolean }) {
    this.ensureProfile(name);
    const current = this.profile(name) as { display_name: string; avatar: string | null };
    this.db.prepare("UPDATE profiles SET display_name=?, avatar=?, updated_at=datetime('now') WHERE name=?")
      .run(patch.displayName ?? current.display_name, patch.avatar === undefined ? current.avatar : patch.avatar, name);
    if (patch.acceptDelegations !== undefined) this.db.prepare("UPDATE profiles SET accept_delegations=? WHERE name=?").run(patch.acceptDelegations ? 1 : 0, name);
    const value = this.profile(name);
    this.onChange("profile", value);
    return value;
  }

  activeChannel(name: string) {
    this.ensureProfile(name);
    return (this.profile(name) as { active_channel: string }).active_channel;
  }

  setActiveChannel(identity: Identity, channel: string) {
    this.ensureProfile(identity.name);
    this.db.prepare("UPDATE profiles SET active_channel=?,updated_at=datetime('now') WHERE name=?").run(channel, identity.name);
    this.touch(identity, "online");
    const value = this.profile(identity.name);
    this.onChange("profile", value);
    return value;
  }

  requestDelegation(identity: Identity, targetAgent: string, request: string) {
    const target = this.ensureProfile(targetAgent) as { accept_delegations: number; active_channel: string };
    if (!target.accept_delegations) throw new Error(`${targetAgent} is not accepting delegation requests`);
    const result = this.db.prepare("INSERT INTO delegation_requests(requester,target_agent,channel,request) VALUES (?,?,?,?)")
      .run(identity.name, targetAgent, target.active_channel, request);
    const value = this.db.prepare("SELECT * FROM delegation_requests WHERE id=?").get(result.lastInsertRowid);
    this.event(identity, { channel: target.active_channel, kind: "delegation.requested", summary: `Requested help from ${targetAgent}`, detail: value });
    return value;
  }

  delegationsFor(name: string) { return this.db.prepare("SELECT * FROM delegation_requests WHERE target_agent=? AND status='pending' ORDER BY id").all(name); }

  claimNextDelegation(targetAgent: string) {
    const claim = this.db.transaction(() => {
      const profile = this.profile(targetAgent) as { accept_delegations: number } | undefined;
      if (!profile?.accept_delegations) return null;
      this.db.prepare("UPDATE delegation_requests SET status='pending',claimed_at=NULL WHERE target_agent=? AND status='running' AND claimed_at < datetime('now','-2 hours')").run(targetAgent);
      const next = this.db.prepare("SELECT * FROM delegation_requests WHERE target_agent=? AND status='pending' ORDER BY id LIMIT 1").get(targetAgent) as { id: number } | undefined;
      if (!next) return null;
      this.db.prepare("UPDATE delegation_requests SET status='running',claimed_at=datetime('now') WHERE id=? AND status='pending'").run(next.id);
      return this.db.prepare("SELECT * FROM delegation_requests WHERE id=?").get(next.id);
    });
    return claim();
  }

  finishDelegation(identity: Identity, id: number, status: "completed" | "failed", result: string) {
    const current = this.db.prepare("SELECT * FROM delegation_requests WHERE id=? AND target_agent=?").get(id, identity.name) as { channel: string } | undefined;
    if (!current) throw new Error("Delegation request not found");
    this.db.prepare("UPDATE delegation_requests SET status=?,finished_at=datetime('now'), request=request || char(10) || char(10) || 'Runner result: ' || ? WHERE id=?")
      .run(status, result.slice(0, 4000), id);
    return this.event(identity, { channel: current.channel, kind: `delegation.${status}`, summary: `Delegated task #${id} ${status}`, detail: { delegationId: id, result } });
  }
}
