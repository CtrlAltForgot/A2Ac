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
      CREATE INDEX IF NOT EXISTS events_channel_id ON events(channel, id DESC);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, updated_at DESC);
    `);
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
      .run(input.channel ?? "general", input.kind, identity.name, identity.role, input.summary,
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
    this.db.prepare(`UPDATE tasks SET status=?, assignee=?, description=?, version=version+1,
      updated_at=datetime('now') WHERE id=?`).run(status, patch.assignee === undefined ? current.assignee : patch.assignee,
        patch.description ?? current.description, id);
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
    this.db.prepare(`INSERT INTO presence(name, role, status, current_task, last_seen) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET role=excluded.role,status=excluded.status,current_task=excluded.current_task,last_seen=datetime('now')`)
      .run(identity.name, identity.role, status, currentTask ?? null);
    const value = this.db.prepare("SELECT * FROM presence WHERE name=?").get(identity.name);
    this.onChange("presence", value);
    return value;
  }

  presence() { return this.db.prepare("SELECT * FROM presence ORDER BY last_seen DESC").all(); }
}
