import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import multer from "multer";
import { WebSocketServer, WebSocket } from "ws";
import { authMiddleware, identifyKey, loadCredentials } from "./auth.js";
import { handleMcp } from "./mcp.js";
import { Store } from "./store.js";

const port = Number(process.env.PORT ?? 3210);
const agentPresenceMinutes = Math.max(1, Math.min(Number(process.env.A2AC_AGENT_PRESENCE_MINUTES ?? 60), 1440));
const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const publicDir = resolve(process.env.PUBLIC_DIR ?? "./public");
const credentials = loadCredentials();
const agentOwners = new Map<string, string>();
for (const entry of (process.env.A2AC_AGENT_OWNERS ?? "owner-agent:owner,buddy-agent:buddy").split(",")) {
  const [agent, owner] = entry.trim().split(":");
  if (agent && owner) agentOwners.set(agent, owner);
}
const store = new Store(dataDir);
const maxUploadMb = Math.max(1, Math.min(Number(process.env.A2AC_MAX_UPLOAD_MB ?? 100), 500));
const upload = multer({ storage: multer.diskStorage({ destination: store.uploadsDir, filename: (_req, _file, callback) => callback(null, randomUUID()) }), limits: { fileSize: maxUploadMb * 1024 * 1024, files: 1 } });
const app = express();
const httpServer = createServer(app);
const sockets = new WebSocketServer({ noServer: true });
const liveHumanNames = () => new Set([...sockets.clients]
  .map((client) => (client as WebSocket & { identity?: { name: string; role: string } }).identity)
  .filter((identity) => identity?.role !== "agent")
  .map((identity) => identity!.name));
const visiblePresence = (viewer?: { name: string; role: string }) => {
  const humans = liveHumanNames();
  if (viewer && viewer.role !== "agent") humans.add(viewer.name);
  const agentCutoff = Date.now() - agentPresenceMinutes * 60_000;
  return (store.presence() as { name: string; role: string; last_seen: string }[]).filter((person) =>
    person.role === "agent" ? new Date(`${person.last_seen}Z`).getTime() >= agentCutoff : humans.has(person.name));
};
const ambientWorthy=(summary:string,detail:unknown)=>{
  const hasAttachment=Boolean(detail&&typeof detail==="object"&&Array.isArray((detail as {attachments?:unknown[]}).attachments)&&(detail as {attachments:unknown[]}).attachments.length);
  return Boolean(summary.trim())||hasAttachment;
};

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({ ok: true, version: "0.1.0" }));
app.use(express.static(publicDir));

const requireAuth = authMiddleware(credentials);
const principalFor=(identity:NonNullable<express.Request["identity"]>)=>agentOwners.get(identity.name)??identity.name;
const allowed=(identity:NonNullable<express.Request["identity"]>,permission:string)=>store.hasPermission(identity,permission,principalFor(identity));
app.use("/api", requireAuth);
const editableProfiles = (identity: NonNullable<express.Request["identity"]>) => credentials
  .filter((candidate) => candidate.name === identity.name || identity.role === "admin" || agentOwners.get(candidate.name) === identity.name)
  .map((candidate) => candidate.name);
app.get("/api/me", (req, res) => {
  store.touch(req.identity!);
  res.json({ ...req.identity, profile: store.ensureProfile(req.identity!.name), editableProfiles: editableProfiles(req.identity!) });
});
app.get("/api/snapshot", (req, res) => {const channel=String(req.query.channel??"general");res.json({
  me: { ...req.identity, profile: store.ensureProfile(req.identity!.name), editableProfiles: editableProfiles(req.identity!) },
  channels: store.channels(), profiles: store.profiles(), tasks: store.tasks(channel), activities: store.activities(), claims: store.claims(), presence: visiblePresence(req.identity!),
  workspace: store.workspace(), pins: store.pins(channel), events: store.events(channel, Number(req.query.after ?? 0), Number(req.query.limit ?? 100))
});});
app.post("/api/channels/:channel/pins/:eventId",(req,res)=>{if(!allowed(req.identity!,"pin_messages"))return res.status(403).json({error:"Your role cannot pin guidance"});try{res.status(201).json(store.pin(req.identity!,String(req.params.channel),Number(req.params.eventId)));}catch(error){res.status(404).json({error:error instanceof Error?error.message:"Could not pin message"});}});
app.delete("/api/channels/:channel/pins/:eventId",(req,res)=>{if(!allowed(req.identity!,"pin_messages"))return res.status(403).json({error:"Your role cannot unpin guidance"});res.json(store.unpin(req.identity!,String(req.params.channel),Number(req.params.eventId)));});
app.patch("/api/workspace", (req,res)=>{
  if(req.identity!.role!=="admin"&&req.identity!.name!=="owner")return res.status(403).json({error:"Only the workspace owner can change branding"});
  const {name,icon}=req.body??{};
  if(typeof name!=="string"||!name.trim()||name.trim().length>50)return res.status(400).json({error:"Workspace name must be 1-50 characters"});
  if(icon!==undefined&&icon!==null&&(typeof icon!=="string"||icon.length>350000||!/^data:image\/(png|jpeg|webp|gif);base64,/.test(icon)))return res.status(400).json({error:"Workspace icon must be an image under 250 KB"});
  res.json(store.updateWorkspace({name:name.trim(),icon}));
});
app.get("/api/roles",(req,res)=>res.json({roles:store.roles(),assignments:store.roleAssignments(),users:credentials.filter(item=>item.role==="human").map(item=>({name:item.name,displayName:(store.ensureProfile(item.name) as {display_name:string}).display_name})),permissions:["delegate_agents","pin_messages","create_tasks","upload_files","manage_channels"]}));
app.put("/api/roles/:id",(req,res)=>{if(req.identity!.role!=="admin"&&req.identity!.name!=="owner")return res.status(403).json({error:"Only the owner can manage roles"});const id=String(req.params.id).toLowerCase().replace(/[^a-z0-9-_]/g,"-");const valid=["delegate_agents","pin_messages","create_tasks","upload_files","manage_channels"];if(!id||typeof req.body?.name!=="string"||!req.body.name.trim())return res.status(400).json({error:"Role name is required"});res.json(store.saveRole({id,name:req.body.name.trim().slice(0,40),permissions:Array.isArray(req.body.permissions)?req.body.permissions.filter((p:string)=>valid.includes(p)):[]}));});
app.put("/api/users/:name/role",(req,res)=>{if(req.identity!.role!=="admin"&&req.identity!.name!=="owner")return res.status(403).json({error:"Only the owner can assign roles"});if(!(store.roles() as {id:string}[]).some(role=>role.id===req.body?.roleId))return res.status(400).json({error:"Unknown role"});res.json(store.assignRole(String(req.params.name),req.body.roleId));});
app.patch("/api/profiles/:name", (req, res) => {
  const target = String(req.params.name);
  if (!editableProfiles(req.identity!).includes(target)) return res.status(403).json({ error: "You can only edit yourself and your assigned agent" });
  const displayName = req.body?.displayName;
  const avatar = req.body?.avatar;
  if (displayName !== undefined && (typeof displayName !== "string" || !displayName.trim() || displayName.trim().length > 40)) return res.status(400).json({ error: "Display name must be 1-40 characters" });
  if (avatar !== undefined && avatar !== null && (typeof avatar !== "string" || avatar.length > 350_000 || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(avatar))) return res.status(400).json({ error: "Avatar must be a PNG, JPEG, WebP, or GIF under 250 KB" });
  res.json(store.updateProfile(target, { displayName: displayName?.trim(), avatar, acceptDelegations: req.body?.acceptDelegations,ambientChat:req.body?.ambientChat }));
});
app.post("/api/attachments", (req,res,next)=>{if(!allowed(req.identity!,"upload_files"))return res.status(403).json({error:"Your role cannot upload files"});next();}, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required" });
  const id = randomUUID();
  const saved=store.createAttachment(req.identity!, { id, filename: req.file.originalname.slice(0, 240), mimeType: req.file.mimetype || "application/octet-stream", size: req.file.size, storedName: req.file.filename }) as Record<string,unknown>;
  const {stored_name,...visible}=saved; res.status(201).json(visible);
});
app.get("/api/attachments/:id", (req, res) => {
  const attachment = store.attachment(String(req.params.id)) as { filename: string; mime_type: string; stored_name: string } | undefined;
  if (!attachment) return res.status(404).json({ error: "Attachment not found" });
  res.type(attachment.mime_type); res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
  res.sendFile(resolve(store.uploadsDir, attachment.stored_name));
});
app.get("/api/events", (req, res) => res.json(store.events(String(req.query.channel ?? "general"), Number(req.query.after ?? 0), Number(req.query.limit ?? 100))));
app.post("/api/events", (req, res) => {
  const { channel = "general", kind = "message", summary, detail, taskId, parentId } = req.body ?? {};
  if(kind==="project.created"&&!allowed(req.identity!,"manage_channels"))return res.status(403).json({error:"Your role cannot create channels"});
  if (typeof summary !== "string" || !summary.trim()) return res.status(400).json({ error: "summary is required" });
  const event = store.event(req.identity!, { channel, kind, summary: summary.trim(), detail, taskId, parentId });
  if(req.identity!.role!=="agent"&&kind==="message")for(const candidate of credentials.filter(item=>item.role==="agent")){store.ensureProfile(candidate.name);if(ambientWorthy(summary.trim(),detail))store.queueAmbientReply(req.identity!,candidate.name,event as {id:number;channel:string;summary:string});}
  const normalized = summary.toLowerCase();
  for (const profile of store.profiles() as { name: string; display_name: string; accept_delegations: number }[]) {
    if (allowed(req.identity!,"delegate_agents") && profile.accept_delegations && normalized.includes(`@${profile.display_name.toLowerCase()}`)) {
      try { store.requestDelegation(req.identity!, profile.name, summary.trim(), channel); } catch { /* message still succeeds */ }
    }
  }
  res.status(201).json(event);
});
app.get("/api/runner/delegations/next", (req, res) => {
  if (req.identity!.role !== "agent") return res.status(403).json({ error: "Agent identity required" });
  const notBeforeMs=Number(req.query.notBefore??0);
  const notBefore=Number.isFinite(notBeforeMs)&&notBeforeMs>0?new Date(notBeforeMs).toISOString().replace("T"," ").slice(0,19):undefined;
  res.json({ request: store.claimNextDelegation(req.identity!.name,notBefore) });
});
app.post("/api/runner/channel",(req,res)=>{
  if(req.identity!.role!=="agent")return res.status(403).json({error:"Agent identity required"});
  const channel=req.body?.channel;
  if(typeof channel!=="string"||!/^[a-z0-9][a-z0-9-_]{0,62}$/.test(channel))return res.status(400).json({error:"Valid channel is required"});
  res.json(store.setActiveChannel(req.identity!,channel));
});
app.post("/api/runner/delegations/:id/finish", (req, res) => {
  if (req.identity!.role !== "agent") return res.status(403).json({ error: "Agent identity required" });
  const status = req.body?.status;
  if (!["completed", "failed"].includes(status) || typeof req.body?.result !== "string") return res.status(400).json({ error: "status and result are required" });
  try { res.json(store.finishDelegation(req.identity!, Number(req.params.id), status, req.body.result)); }
  catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : "Not found" }); }
});
app.post("/api/tasks", (req, res) => {
  if(!allowed(req.identity!,"create_tasks"))return res.status(403).json({error:"Your role cannot create shared goals"});
  if (typeof req.body?.title !== "string" || !req.body.title.trim()) return res.status(400).json({ error: "title is required" });
  if(req.body?.wakeModels&&!allowed(req.identity!,"delegate_agents"))return res.status(403).json({error:"Your role cannot wake other users' agents"});
  const task=store.createTask(req.identity!,req.body) as Record<string,unknown>;
  const wakeDispatches:string[]=[];
  if(req.body?.wakeModels){
    const channel=String(task.channel??req.body.channel??"general");
    const request=`Join team mission #${task.id}: ${task.title}. ${task.description||"Coordinate with the team, choose a narrow non-overlapping contribution, and report progress."}`;
    for(const candidate of credentials.filter(item=>item.role==="agent")){
      const profile=store.ensureProfile(candidate.name) as {accept_delegations:number};
      if(!profile.accept_delegations)continue;
      try{store.requestDelegation(req.identity!,candidate.name,request,channel);wakeDispatches.push(candidate.name);}catch{/* mission remains passive for unavailable agents */}
    }
  }
  res.status(201).json({...task,wakeDispatches});
});
app.patch("/api/tasks/:id", (req, res) => {
  try { res.json(store.updateTask(req.identity!, Number(req.params.id), req.body)); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "Update failed" }); }
});

app.all("/mcp", requireAuth, async (req, res) => {
  try { store.touch(req.identity!, "online"); await handleMcp(req, res, store, principalFor(req.identity!)); }
  catch (error) {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});
app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if(error instanceof multer.MulterError)return res.status(413).json({error:error.code==="LIMIT_FILE_SIZE"?`File exceeds ${maxUploadMb} MB limit`:error.message});
  next(error);
});

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname !== "/ws") return socket.destroy();
  const key = url.searchParams.get("token") ?? "";
  const identity = identifyKey(key, credentials);
  if (!identity) return socket.destroy();
  sockets.handleUpgrade(req, socket, head, (ws) => {
    (ws as WebSocket & { identity?: typeof identity }).identity = identity;
    sockets.emit("connection", ws, req);
  });
});

sockets.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "connected" }));
  socket.on("close", () => {
    const payload = JSON.stringify({ type: "presence.changed" });
    for (const client of sockets.clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
});
store.onChange = (type, value) => {
  const payload = JSON.stringify({ type, value });
  for (const client of sockets.clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
};

httpServer.listen(port, "0.0.0.0", () => console.log(`A2Ac listening on http://0.0.0.0:${port}`));
