import express from "express";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { authMiddleware, identify, loadCredentials } from "./auth.js";
import { handleMcp } from "./mcp.js";
import { Store } from "./store.js";

const port = Number(process.env.PORT ?? 3210);
const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const publicDir = resolve(process.env.PUBLIC_DIR ?? "./public");
const credentials = loadCredentials();
const store = new Store(dataDir);
const app = express();
const httpServer = createServer(app);
const sockets = new WebSocketServer({ noServer: true });

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({ ok: true, version: "0.1.0" }));
app.use(express.static(publicDir));

const requireAuth = authMiddleware(credentials);
app.use("/api", requireAuth);
app.get("/api/me", (req, res) => { store.touch(req.identity!); res.json(req.identity); });
app.get("/api/snapshot", (req, res) => res.json({
  me: req.identity, channels: store.channels(), tasks: store.tasks(), claims: store.claims(), presence: store.presence(),
  events: store.events(String(req.query.channel ?? "general"), Number(req.query.after ?? 0), Number(req.query.limit ?? 100))
}));
app.get("/api/events", (req, res) => res.json(store.events(String(req.query.channel ?? "general"), Number(req.query.after ?? 0), Number(req.query.limit ?? 100))));
app.post("/api/events", (req, res) => {
  const { channel = "general", kind = "message", summary, detail, taskId, parentId } = req.body ?? {};
  if (typeof summary !== "string" || !summary.trim()) return res.status(400).json({ error: "summary is required" });
  res.status(201).json(store.event(req.identity!, { channel, kind, summary: summary.trim(), detail, taskId, parentId }));
});
app.post("/api/tasks", (req, res) => {
  if (typeof req.body?.title !== "string" || !req.body.title.trim()) return res.status(400).json({ error: "title is required" });
  res.status(201).json(store.createTask(req.identity!, req.body));
});
app.patch("/api/tasks/:id", (req, res) => {
  try { res.json(store.updateTask(req.identity!, Number(req.params.id), req.body)); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "Update failed" }); }
});

app.all("/mcp", requireAuth, async (req, res) => {
  try { await handleMcp(req, res, store); }
  catch (error) {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname !== "/ws") return socket.destroy();
  const key = url.searchParams.get("token") ?? "";
  req.headers.authorization = `Bearer ${key}`;
  const identity = identify(req as express.Request, credentials);
  if (!identity) return socket.destroy();
  sockets.handleUpgrade(req, socket, head, (ws) => {
    (ws as WebSocket & { identity?: typeof identity }).identity = identity;
    sockets.emit("connection", ws, req);
  });
});

sockets.on("connection", (socket) => socket.send(JSON.stringify({ type: "connected" })));
store.onChange = (type, value) => {
  const payload = JSON.stringify({ type, value });
  for (const client of sockets.clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
};

httpServer.listen(port, "0.0.0.0", () => console.log(`A2Ac listening on http://0.0.0.0:${port}`));
