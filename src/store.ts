import Database from "better-sqlite3";
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { EventInput, Identity } from "./types.js";

export class Store {
  readonly db: Database.Database;
  readonly uploadsDir: string;
  onChange: (type: string, value: unknown) => void = () => {};

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.uploadsDir = join(dataDir, "uploads");
    mkdirSync(this.uploadsDir, { recursive: true });
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
        started_at TEXT, channel TEXT NOT NULL DEFAULT 'general',
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
        ambient_chat INTEGER NOT NULL DEFAULT 0, work_capacity TEXT NOT NULL DEFAULT 'normal', capacity_note TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS delegation_requests (
        id INTEGER PRIMARY KEY, requester TEXT NOT NULL, target_agent TEXT NOT NULL,
        channel TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        request_type TEXT NOT NULL DEFAULT 'delegation', source_event_id INTEGER, task_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), claimed_at TEXT, finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime_type TEXT NOT NULL,
        size INTEGER NOT NULL, uploader TEXT NOT NULL, stored_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL DEFAULT (datetime('now','+7 days'))
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_aliases (old_channel TEXT PRIMARY KEY, new_channel TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pins (
        channel TEXT NOT NULL, event_id INTEGER NOT NULL, pinned_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(channel,event_id)
      );
      CREATE TABLE IF NOT EXISTS workspace_roles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, permissions TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS user_roles (
        user_name TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES workspace_roles(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS agent_activities (
        agent TEXT PRIMARY KEY, channel TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS events_channel_id ON events(channel, id DESC);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, updated_at DESC);
    `);
    const profileColumns = this.db.pragma("table_info(profiles)") as { name: string }[];
    if (!profileColumns.some((column) => column.name === "accept_delegations")) this.db.exec("ALTER TABLE profiles ADD COLUMN accept_delegations INTEGER NOT NULL DEFAULT 0");
    if (!profileColumns.some((column) => column.name === "ambient_chat")) this.db.exec("ALTER TABLE profiles ADD COLUMN ambient_chat INTEGER NOT NULL DEFAULT 0");
    if (!profileColumns.some((column) => column.name === "work_capacity")) this.db.exec("ALTER TABLE profiles ADD COLUMN work_capacity TEXT NOT NULL DEFAULT 'normal'");
    if (!profileColumns.some((column) => column.name === "capacity_note")) this.db.exec("ALTER TABLE profiles ADD COLUMN capacity_note TEXT NOT NULL DEFAULT ''");
    const taskColumns = this.db.pragma("table_info(tasks)") as { name: string }[];
    if (!taskColumns.some((column) => column.name === "started_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN started_at TEXT");
      this.db.exec("UPDATE tasks SET started_at=updated_at WHERE status IN ('in_progress','blocked')");
    }
    if (!taskColumns.some((column) => column.name === "channel")) this.db.exec("ALTER TABLE tasks ADD COLUMN channel TEXT NOT NULL DEFAULT 'general'");
    const delegationColumns = this.db.pragma("table_info(delegation_requests)") as { name: string }[];
    if (!delegationColumns.some((column) => column.name === "claimed_at")) this.db.exec("ALTER TABLE delegation_requests ADD COLUMN claimed_at TEXT");
    if (!delegationColumns.some((column) => column.name === "finished_at")) this.db.exec("ALTER TABLE delegation_requests ADD COLUMN finished_at TEXT");
    if (!delegationColumns.some((column) => column.name === "request_type")) this.db.exec("ALTER TABLE delegation_requests ADD COLUMN request_type TEXT NOT NULL DEFAULT 'delegation'");
    if (!delegationColumns.some((column) => column.name === "source_event_id")) this.db.exec("ALTER TABLE delegation_requests ADD COLUMN source_event_id INTEGER");
    if (!delegationColumns.some((column) => column.name === "task_id")) this.db.exec("ALTER TABLE delegation_requests ADD COLUMN task_id INTEGER");
    const attachmentColumns=this.db.pragma("table_info(attachments)") as {name:string}[];
    if(!attachmentColumns.some(column=>column.name==="expires_at")){
      this.db.exec("ALTER TABLE attachments ADD COLUMN expires_at TEXT");
      this.db.exec("UPDATE attachments SET expires_at=datetime(created_at,'+7 days') WHERE expires_at IS NULL");
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ambient_reply_once ON delegation_requests(target_agent,source_event_id) WHERE source_event_id IS NOT NULL");
    // Older builds could queue the same human post for several ambient agents. Keep
    // the earliest dispatch, then enforce one ambient responder per source message.
    this.db.exec(`DELETE FROM delegation_requests WHERE request_type='ambient' AND source_event_id IS NOT NULL
      AND id NOT IN (SELECT MIN(id) FROM delegation_requests WHERE request_type='ambient' AND source_event_id IS NOT NULL GROUP BY source_event_id)`);
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ambient_source_reply_once ON delegation_requests(source_event_id) WHERE request_type='ambient' AND source_event_id IS NOT NULL");
    this.db.prepare("INSERT OR IGNORE INTO workspace_roles(id,name,permissions) VALUES ('member','Member',?)").run(JSON.stringify(["pin_messages","create_tasks","upload_files","manage_channels"]));
    this.db.prepare("INSERT OR IGNORE INTO workspace_roles(id,name,permissions) VALUES ('trusted','Trusted collaborator',?)").run(JSON.stringify(["pin_messages","create_tasks","upload_files","manage_channels","delegate_agents"]));
    this.db.prepare("INSERT OR IGNORE INTO user_roles(user_name,role_id) VALUES ('buddy','trusted')").run();
  }

  private parse(row: Record<string, unknown>): Record<string, unknown> {
    if (typeof row["detail"] === "string") {
      try { row["detail"] = JSON.parse(row["detail"]); } catch { /* keep text */ }
    }
    return row;
  }

  private channelName(channel: string) {
    let current=channel;
    for(let depth=0;depth<10;depth++){
      const alias=this.db.prepare("SELECT new_channel FROM channel_aliases WHERE old_channel=?").get(current) as {new_channel:string}|undefined;
      if(!alias||alias.new_channel===current)break;
      current=alias.new_channel;
    }
    return current;
  }

  event(identity: Identity, input: EventInput) {
    const channel=this.channelName(input.channel ?? this.activeChannel(identity.name));
    const result = this.db.prepare(`INSERT INTO events
      (channel, kind, actor, actor_role, summary, detail, task_id, parent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(channel, input.kind, identity.name, identity.role, input.summary,
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
    channel=this.channelName(channel);
    const capped = Math.min(limit, 250);
    const rows = after > 0
      ? this.db.prepare("SELECT * FROM events WHERE channel = ? AND id > ? ORDER BY id ASC LIMIT ?").all(channel, after, capped)
      : this.db.prepare("SELECT * FROM (SELECT * FROM events WHERE channel = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC").all(channel, capped);
    return (rows as Record<string, unknown>[]).map((row) => this.parse(row));
  }

  unansweredHumanEventIds(channel:string,limit=20){
    channel=this.channelName(channel);
    return (this.db.prepare(`SELECT e.id FROM events e
      WHERE e.channel=? AND e.actor_role!='agent' AND e.kind='message'
      AND NOT EXISTS (SELECT 1 FROM events reply WHERE reply.parent_id=e.id AND reply.actor_role='agent')
      ORDER BY e.id DESC LIMIT ?`).all(channel,Math.max(1,Math.min(limit,50))) as {id:number}[]).map(row=>row.id);
  }

  channels() {
    return this.db.prepare(`SELECT channel, SUM(count) count, MAX(last_event_id) last_event_id FROM (
      SELECT channel,COUNT(*) count,MAX(id) last_event_id FROM events GROUP BY channel
      UNION ALL SELECT channel,0 count,0 last_event_id FROM agent_activities GROUP BY channel
    ) GROUP BY channel ORDER BY last_event_id DESC`).all();
  }

  renameChannel(identity: Identity, from: string, to: string) {
    from=this.channelName(from);to=this.channelName(to);
    if (from === "general") throw new Error("The general channel cannot be renamed");
    if (from === to) return { from, to };
    const channels = this.channels() as { channel: string }[];
    if (!channels.some((item) => item.channel === from)) throw new Error("Channel not found");
    if (channels.some((item) => item.channel === to)) throw new Error("That channel already exists");
    this.db.transaction(() => {
      for (const table of ["events", "tasks", "pins", "agent_activities", "delegation_requests"])
        this.db.prepare(`UPDATE ${table} SET channel=? WHERE channel=?`).run(to, from);
      this.db.prepare("UPDATE profiles SET active_channel=?,updated_at=datetime('now') WHERE active_channel=?").run(to, from);
      this.db.prepare("UPDATE channel_aliases SET new_channel=? WHERE new_channel=?").run(to,from);
      this.db.prepare("INSERT OR REPLACE INTO channel_aliases(old_channel,new_channel) VALUES (?,?)").run(from,to);
    })();
    const value = { from, to, actor: identity.name };
    this.onChange("channel.renamed", value);
    return value;
  }

  activities() { return this.db.prepare("SELECT * FROM agent_activities ORDER BY updated_at DESC").all(); }

  updateActivity(identity:Identity,input:{channel:string;title:string;description?:string;status:string}) {
    input={...input,channel:this.channelName(input.channel)};
    if(identity.role!=="agent")throw new Error("Agent identity required");
    if(["idle","completed"].includes(input.status)){this.db.prepare("DELETE FROM agent_activities WHERE agent=?").run(identity.name);this.onChange("activity",{agent:identity.name,removed:true});return{agent:identity.name,removed:true};}
    if(!["working","waiting","stalled","paused","blocked"].includes(input.status))throw new Error("Invalid activity status");
    const current=this.db.prepare("SELECT * FROM agent_activities WHERE agent=?").get(identity.name) as {title:string}|undefined;
    const resetStart=!current||current.title!==input.title;
    this.db.prepare(`INSERT INTO agent_activities(agent,channel,title,description,status) VALUES (?,?,?,?,?)
      ON CONFLICT(agent) DO UPDATE SET channel=excluded.channel,title=excluded.title,description=excluded.description,status=excluded.status,
      started_at=CASE WHEN ? THEN datetime('now') ELSE started_at END,updated_at=datetime('now')`)
      .run(identity.name,input.channel,input.title,input.description??"",input.status,resetStart?1:0);
    this.setActiveChannel(identity,input.channel);const value=this.db.prepare("SELECT * FROM agent_activities WHERE agent=?").get(identity.name);this.onChange("activity",value);return value;
  }

  pins(channel: string) { channel=this.channelName(channel);return (this.db.prepare(`SELECT p.channel,p.event_id,p.pinned_by,p.created_at,e.summary,e.actor,e.actor_role
    FROM pins p JOIN events e ON e.id=p.event_id WHERE p.channel=? ORDER BY p.created_at`).all(channel) as Record<string,unknown>[]).map(row=>this.parse(row)); }

  pin(identity: Identity, channel: string, eventId: number) {
    channel=this.channelName(channel);
    const event=this.getEvent(eventId) as {channel:string}|undefined;
    if(!event||event.channel!==channel)throw new Error("Message not found in this channel");
    this.db.prepare("INSERT OR REPLACE INTO pins(channel,event_id,pinned_by) VALUES (?,?,?)").run(channel,eventId,identity.name);
    const value=this.pins(channel).find(pin=>pin.event_id===eventId);this.onChange("pin",value);return value;
  }

  unpin(identity: Identity, channel:string,eventId:number){channel=this.channelName(channel);this.db.prepare("DELETE FROM pins WHERE channel=? AND event_id=?").run(channel,eventId);this.onChange("pin",{channel,eventId,removed:true,actor:identity.name});return{removed:true};}

  createTask(identity: Identity, input: { title: string; description?: string; priority?: string; assignee?: string; channel?:string }) {
    const channel=this.channelName(input.channel??this.activeChannel(identity.name));
    const result = this.db.prepare(`INSERT INTO tasks (title, description, priority, assignee, created_by, channel)
      VALUES (?, ?, ?, ?, ?, ?)`).run(input.title, input.description ?? "", input.priority ?? "normal", input.assignee ?? null, identity.name,channel);
    const value = this.task(Number(result.lastInsertRowid));
    this.event(identity, { channel,kind: "task.created", summary: `Created ${input.assignee==="team"?"team mission":"task"}: ${input.title}`, taskId: Number(result.lastInsertRowid), detail: value });
    this.onChange("task", value);
    return value;
  }

  task(id: number) { return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id); }
  tasks(channel?:string) { return channel?this.db.prepare("SELECT * FROM tasks WHERE channel=? ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, updated_at DESC").all(this.channelName(channel)):this.db.prepare("SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, updated_at DESC").all(); }

  updateTask(identity: Identity, id: number, patch: { status?: string; assignee?: string | null; description?: string; expectedVersion?: number }) {
    const current = this.task(id) as Record<string, unknown> | undefined;
    if (!current) throw new Error("Task not found");
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== current.version) throw new Error(`Version conflict: task is at version ${current.version}`);
    const status = patch.status ?? current.status;
    if (!["open", "in_progress", "waiting", "stalled", "paused", "blocked", "done", "cancelled"].includes(String(status))) throw new Error("Invalid task status");
    const startedAt = status === "in_progress" && !current.started_at ? new Date().toISOString().replace("T", " ").slice(0, 19) : current.started_at;
    this.db.prepare(`UPDATE tasks SET status=?, assignee=?, description=?, started_at=?, version=version+1,
      updated_at=datetime('now') WHERE id=?`).run(status, patch.assignee === undefined ? current.assignee : patch.assignee,
        patch.description ?? current.description, startedAt ?? null, id);
    const value = this.task(id);
    if(["done","cancelled"].includes(String(status)))this.db.prepare("UPDATE delegation_requests SET status='expired',finished_at=datetime('now') WHERE request_type='team' AND task_id=? AND status='pending'").run(id);
    this.event(identity, { kind: "task.updated", summary: `Updated task #${id} to ${status}`, taskId: id, detail: { patch, task: value } });
    this.onChange("task", value);
    return value;
  }

  claim(identity: Identity, resource: string, ttlMinutes: number, reason = "", channel?: string) {
    this.db.prepare("DELETE FROM claims WHERE expires_at <= datetime('now')").run();
    const existing = this.db.prepare("SELECT * FROM claims WHERE resource = ?").get(resource) as { owner: string } | undefined;
    if (existing && existing.owner !== identity.name) throw new Error(`Already claimed by ${existing.owner}`);
    this.db.prepare(`INSERT INTO claims(resource, owner, reason, expires_at) VALUES (?, ?, ?, datetime('now', ?))
      ON CONFLICT(resource) DO UPDATE SET reason=excluded.reason, expires_at=excluded.expires_at`)
      .run(resource, identity.name, reason, `+${Math.max(1, Math.min(ttlMinutes, 240))} minutes`);
    const value = this.db.prepare("SELECT * FROM claims WHERE resource = ?").get(resource);
    const eventChannel=channel??this.activeChannel(identity.name);
    this.event(identity, { channel:eventChannel,kind: "claim.acquired", summary: `Claimed ${resource}`, detail: value });
    if(identity.role==="agent"){
      const existing=this.db.prepare("SELECT * FROM agent_activities WHERE agent=?").get(identity.name) as {title:string;description:string;started_at:string}|undefined;
      const shortResource=resource.split("/").filter(Boolean).at(-1)??resource;
      this.db.prepare(`INSERT INTO agent_activities(agent,channel,title,description,status) VALUES (?,?,?,?, 'working')
        ON CONFLICT(agent) DO UPDATE SET channel=excluded.channel,status='working',description=CASE WHEN agent_activities.description='' THEN excluded.description ELSE agent_activities.description END,updated_at=datetime('now')`)
        .run(identity.name,eventChannel,existing?.title??`Working on ${shortResource}`,existing?.description||reason||`Working with ${resource}`);
      this.onChange("activity",this.db.prepare("SELECT * FROM agent_activities WHERE agent=?").get(identity.name));
    }
    this.onChange("claim", value);
    return value;
  }

  release(identity: Identity, resource: string, channel?: string) {
    const result = this.db.prepare("DELETE FROM claims WHERE resource=? AND owner=?").run(resource, identity.name);
    if (!result.changes) throw new Error("Claim not found or owned by another identity");
    this.event(identity, { channel:channel??this.activeChannel(identity.name),kind: "claim.released", summary: `Released ${resource}` });
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

  workspace() {
    const rows = this.db.prepare("SELECT key,value FROM settings WHERE key IN ('workspace_name','workspace_icon')").all() as {key:string;value:string}[];
    const values=Object.fromEntries(rows.map(row=>[row.key,row.value]));
    return { name: values.workspace_name || "A2Ac Studio", icon: values.workspace_icon || null };
  }

  updateWorkspace(input: {name?:string;icon?:string|null}) {
    if(input.name!==undefined)this.db.prepare("INSERT INTO settings(key,value) VALUES ('workspace_name',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(input.name);
    if(input.icon!==undefined){ if(input.icon===null)this.db.prepare("DELETE FROM settings WHERE key='workspace_icon'").run(); else this.db.prepare("INSERT INTO settings(key,value) VALUES ('workspace_icon',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(input.icon); }
    const value=this.workspace();this.onChange("workspace",value);return value;
  }

  roles() { return (this.db.prepare("SELECT * FROM workspace_roles ORDER BY name").all() as {id:string;name:string;permissions:string}[]).map(role=>({...role,permissions:JSON.parse(role.permissions)})); }
  roleAssignments() { return this.db.prepare("SELECT user_name,role_id FROM user_roles ORDER BY user_name").all(); }
  permissionsFor(name:string) { const role=this.db.prepare(`SELECT r.permissions FROM workspace_roles r LEFT JOIN user_roles u ON u.role_id=r.id WHERE u.user_name=?`).get(name) as {permissions:string}|undefined;const fallback=this.db.prepare("SELECT permissions FROM workspace_roles WHERE id='member'").get() as {permissions:string}|undefined;return JSON.parse(role?.permissions||fallback?.permissions||"[]") as string[]; }
  hasPermission(identity:Identity,permission:string,principal=identity.name){return identity.role==="admin"||principal==="owner"||this.permissionsFor(principal).includes(permission);}
  saveRole(input:{id:string;name:string;permissions:string[]}) { this.db.prepare("INSERT INTO workspace_roles(id,name,permissions) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,permissions=excluded.permissions").run(input.id,input.name,JSON.stringify(input.permissions));const value=this.roles();this.onChange("roles",value);return value; }
  assignRole(userName:string,roleId:string){this.db.prepare("INSERT INTO user_roles(user_name,role_id) VALUES (?,?) ON CONFLICT(user_name) DO UPDATE SET role_id=excluded.role_id").run(userName,roleId);const value=this.roleAssignments();this.onChange("roles",value);return value;}

  updateProfile(name: string, patch: { displayName?: string; avatar?: string | null; acceptDelegations?: boolean; ambientChat?:boolean;workCapacity?:string;capacityNote?:string }) {
    this.ensureProfile(name);
    const current = this.profile(name) as { display_name: string; avatar: string | null };
    this.db.prepare("UPDATE profiles SET display_name=?, avatar=?, updated_at=datetime('now') WHERE name=?")
      .run(patch.displayName ?? current.display_name, patch.avatar === undefined ? current.avatar : patch.avatar, name);
    if (patch.acceptDelegations !== undefined) this.db.prepare("UPDATE profiles SET accept_delegations=? WHERE name=?").run(patch.acceptDelegations ? 1 : 0, name);
    if (patch.ambientChat !== undefined) this.db.prepare("UPDATE profiles SET ambient_chat=? WHERE name=?").run(patch.ambientChat ? 1 : 0, name);
    if (patch.workCapacity !== undefined) {if(!["conserve","normal","heavy"].includes(patch.workCapacity))throw new Error("Invalid work capacity");this.db.prepare("UPDATE profiles SET work_capacity=? WHERE name=?").run(patch.workCapacity,name);}
    if(patch.capacityNote!==undefined)this.db.prepare("UPDATE profiles SET capacity_note=? WHERE name=?").run(patch.capacityNote.trim().slice(0,160),name);
    const value = this.profile(name);
    this.onChange("profile", value);
    return value;
  }

  activeChannel(name: string) {
    this.ensureProfile(name);
    return (this.profile(name) as { active_channel: string }).active_channel;
  }

  setActiveChannel(identity: Identity, channel: string) {
    channel=this.channelName(channel);
    this.ensureProfile(identity.name);
    this.db.prepare("UPDATE profiles SET active_channel=?,updated_at=datetime('now') WHERE name=?").run(channel, identity.name);
    this.touch(identity, "online");
    const value = this.profile(identity.name);
    this.onChange("profile", value);
    return value;
  }

  requestDelegation(identity: Identity, targetAgent: string, request: string, channel?: string, options:{requestType?:"delegation"|"team";taskId?:number}={}) {
    const target = this.ensureProfile(targetAgent) as { accept_delegations: number; active_channel: string };
    if (!target.accept_delegations) throw new Error(`${targetAgent} is not accepting delegation requests`);
    const requestChannel = this.channelName(channel ?? this.activeChannel(identity.name));
    const result = this.db.prepare("INSERT INTO delegation_requests(requester,target_agent,channel,request,request_type,task_id) VALUES (?,?,?,?,?,?)")
      .run(identity.name, targetAgent, requestChannel, request,options.requestType??"delegation",options.taskId??null);
    const value = this.db.prepare("SELECT * FROM delegation_requests WHERE id=?").get(result.lastInsertRowid);
    this.event(identity, { channel: requestChannel, kind: "delegation.requested", summary: `Requested help from ${targetAgent}`, detail: value });
    return value;
  }

  queueAmbientReply(identity:Identity,targetAgent:string,event:{id:number;channel:string;summary:string}){
    const profile=this.ensureProfile(targetAgent) as {ambient_chat:number};
    if(!profile.ambient_chat)return null;
    const alreadyQueued=this.db.prepare("SELECT id FROM delegation_requests WHERE request_type='ambient' AND source_event_id=?").get(event.id);
    if(alreadyQueued)return null;
    const pending=this.db.prepare("SELECT id FROM delegation_requests WHERE target_agent=? AND channel=? AND request_type='ambient' AND status='pending' ORDER BY id DESC LIMIT 1").get(targetAgent,event.channel) as {id:number}|undefined;
    if(pending){this.db.prepare("UPDATE delegation_requests SET requester=?,request=request || char(10) || char(10) || ?,source_event_id=?,created_at=datetime('now') WHERE id=?").run(identity.name,`Follow-up: ${event.summary}`,event.id,pending.id);return this.db.prepare("SELECT * FROM delegation_requests WHERE id=?").get(pending.id);}
    const result=this.db.prepare(`INSERT OR IGNORE INTO delegation_requests(requester,target_agent,channel,request,request_type,source_event_id)
      VALUES (?,?,?,?, 'ambient',?)`).run(identity.name,targetAgent,event.channel,event.summary,event.id);
    if(!result.changes)return null;
    return this.db.prepare("SELECT * FROM delegation_requests WHERE id=?").get(result.lastInsertRowid);
  }

  activeAmbientAgent(channel:string){return (this.db.prepare("SELECT target_agent FROM delegation_requests WHERE request_type='ambient' AND channel=? AND status='running' ORDER BY claimed_at DESC LIMIT 1").get(channel) as {target_agent:string}|undefined)?.target_agent;}

  claimNextAmbient(targetAgent:string,channel:string){return this.db.transaction(()=>{const next=this.db.prepare("SELECT id FROM delegation_requests WHERE target_agent=? AND channel=? AND request_type='ambient' AND status='pending' ORDER BY id LIMIT 1").get(targetAgent,channel) as {id:number}|undefined;if(!next)return null;this.db.prepare("UPDATE delegation_requests SET status='running',claimed_at=datetime('now') WHERE id=? AND status='pending'").run(next.id);return this.db.prepare("SELECT * FROM delegation_requests WHERE id=?").get(next.id);})();}

  delegationsFor(name: string) { return this.db.prepare(`SELECT * FROM delegation_requests WHERE target_agent=? AND status='pending'
    AND (request_type!='team' OR NOT EXISTS(SELECT 1 FROM agent_activities WHERE agent=?)) ORDER BY id`).all(name,name); }

  claimNextDelegation(targetAgent: string, notBefore?: string) {
    const claim = this.db.transaction(() => {
      const profile = this.profile(targetAgent) as { accept_delegations: number; ambient_chat:number } | undefined;
      if (!profile?.accept_delegations&&!profile?.ambient_chat) return null;
      this.db.prepare("UPDATE delegation_requests SET status='pending',claimed_at=NULL WHERE target_agent=? AND status='running' AND claimed_at < datetime('now','-2 hours')").run(targetAgent);
      if (notBefore) this.db.prepare("UPDATE delegation_requests SET status='expired',finished_at=datetime('now') WHERE target_agent=? AND status='pending' AND created_at < ?").run(targetAgent, notBefore);
      this.db.prepare(`UPDATE delegation_requests SET status='expired',finished_at=datetime('now') WHERE target_agent=? AND request_type='team' AND status='pending'
        AND EXISTS(SELECT 1 FROM tasks WHERE tasks.id=delegation_requests.task_id AND tasks.status IN ('done','cancelled'))`).run(targetAgent);
      const next = this.db.prepare(`SELECT * FROM delegation_requests WHERE target_agent=? AND status='pending'
        AND (request_type!='team' OR NOT EXISTS(SELECT 1 FROM agent_activities WHERE agent=?))
        AND ((request_type='ambient' AND ? AND NOT EXISTS(SELECT 1 FROM delegation_requests recent WHERE recent.target_agent=? AND recent.request_type='ambient' AND recent.finished_at>datetime('now','-45 seconds'))) OR (request_type!='ambient' AND ?)) ORDER BY id LIMIT 1`)
        .get(targetAgent,targetAgent,profile.ambient_chat?1:0,targetAgent,profile.accept_delegations?1:0) as { id: number } | undefined;
      if (!next) return null;
      this.db.prepare("UPDATE delegation_requests SET status='running',claimed_at=datetime('now') WHERE id=? AND status='pending'").run(next.id);
      return this.db.prepare("SELECT * FROM delegation_requests WHERE id=?").get(next.id);
    });
    return claim();
  }

  finishDelegation(identity: Identity, id: number, status: "completed" | "failed", result: string) {
    const current = this.db.prepare("SELECT * FROM delegation_requests WHERE id=? AND target_agent=?").get(id, identity.name) as { channel: string;request_type:string } | undefined;
    if (!current) throw new Error("Delegation request not found");
    this.db.prepare("UPDATE delegation_requests SET status=?,finished_at=datetime('now'), request=request || char(10) || char(10) || 'Runner result: ' || ? WHERE id=?")
      .run(status, result.slice(0, 4000), id);
    if(current.request_type==="ambient"){this.onChange("delegation",{id,status});return{id,status};}
    return this.event(identity, { channel: current.channel, kind: `delegation.${status}`, summary: `Delegated task #${id} ${status}`, detail: { delegationId: id, result } });
  }

  createAttachment(identity: Identity, input: { id: string; filename: string; mimeType: string; size: number; storedName: string }) {
    this.cleanupExpiredAttachments();
    this.db.prepare("INSERT INTO attachments(id,filename,mime_type,size,uploader,stored_name,expires_at) VALUES (?,?,?,?,?,?,datetime('now','+7 days'))")
      .run(input.id, input.filename, input.mimeType, input.size, identity.name, input.storedName);
    return this.attachment(input.id);
  }

  cleanupExpiredAttachments(){const expired=this.db.prepare("SELECT stored_name FROM attachments WHERE expires_at<=datetime('now')").all() as {stored_name:string}[];for(const item of expired){try{unlinkSync(join(this.uploadsDir,item.stored_name));}catch{/* already removed */}}if(expired.length)this.db.prepare("DELETE FROM attachments WHERE expires_at<=datetime('now')").run();return expired.length;}

  attachment(id: string) { this.cleanupExpiredAttachments();return this.db.prepare("SELECT id,filename,mime_type,size,uploader,stored_name,created_at,expires_at FROM attachments WHERE id=?").get(id); }

  renewAttachment(identity:Identity,id:string,days=7){this.cleanupExpiredAttachments();const item=this.attachment(id) as {id:string}|undefined;if(!item)throw new Error("Attachment not found or already expired");const safeDays=Math.max(1,Math.min(Math.floor(days),30));this.db.prepare("UPDATE attachments SET expires_at=datetime('now',?) WHERE id=?").run(`+${safeDays} days`,id);const value=this.attachment(id);this.onChange("attachment",{id,renewedBy:identity.name,expiresAt:(value as {expires_at:string}).expires_at});return value;}
}
