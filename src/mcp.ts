import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Identity } from "./types.js";

const response = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: { result: value }
});

export function createMcpServer(store: Store, identity: Identity) {
  const server = new McpServer({ name: "a2ac", version: "0.1.0" });

  server.registerTool("a2ac_workspace_snapshot", {
    title: "Get collaboration snapshot",
    description: "Call at the start of work and periodically. Returns tasks, active resource claims, people/agents, and recent team messages.",
    inputSchema: { channel: z.string().optional().describe("Omit to use your persisted active channel"), eventLimit: z.number().int().min(1).max(100).default(30) }
  }, async ({ channel, eventLimit }) => {
    const activeChannel = channel ?? store.activeChannel(identity.name);
    return response({ identity, activeChannel, tasks: store.tasks(), claims: store.claims(), presence: store.presence(), delegationRequests: store.delegationsFor(identity.name), events: store.events(activeChannel, 0, eventLimit) });
  });

  server.registerTool("a2ac_set_channel", {
    title: "Set active project channel",
    description: "Set the persistent channel for this agent before project work. Subsequent messages, actions, tasks, and claims default here.",
    inputSchema: { channel: z.string().regex(/^[a-z0-9][a-z0-9-_]{0,62}$/) }
  }, async ({ channel }) => response(store.setActiveChannel(identity, channel)));

  server.registerTool("a2ac_request_delegation", {
    title: "Request work from another agent",
    description: "Queue a request only when the target agent explicitly accepts delegations. This never wakes or invokes a model; their next active turn must accept it.",
    inputSchema: { targetAgent: z.string().min(1), request: z.string().min(1).max(2000) }
  }, async ({ targetAgent, request }) => response(store.requestDelegation(identity, targetAgent, request)));

  server.registerTool("a2ac_send_message", {
    title: "Send team message",
    description: "Send a human-readable message to humans and agents. Include structured detail for expandable action context.",
    inputSchema: {
      channel: z.string().optional(), message: z.string().min(1),
      kind: z.enum(["message", "progress", "question", "decision", "warning", "handoff"]).default("message"),
      detail: z.record(z.unknown()).optional(), taskId: z.number().int().optional(), parentId: z.number().int().optional()
    }
  }, async ({ channel, message, kind, detail, taskId, parentId }) => response(store.event(identity, { channel: channel ?? store.activeChannel(identity.name), kind, summary: message, detail, taskId, parentId })));

  server.registerTool("a2ac_read_messages", {
    title: "Read team messages",
    description: "Read messages and structured activity after a known event id. Poll this while collaborating to see replies and avoid duplicated work.",
    inputSchema: { channel: z.string().optional(), afterId: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(250).default(100) }
  }, async ({ channel, afterId, limit }) => response(store.events(channel ?? store.activeChannel(identity.name), afterId, limit)));

  server.registerTool("a2ac_read_attachment", {
    title: "Read a shared attachment",
    description: "Read an attachment referenced by a message. Images and small text files are returned in context. Large/binary files return metadata so they do not waste model tokens.",
    inputSchema: { attachmentId: z.string().uuid() }
  }, async ({ attachmentId }) => {
    const item=store.attachment(attachmentId) as {filename:string;mime_type:string;size:number;stored_name:string}|undefined;
    if(!item)return response({error:"Attachment not found"});
    const metadata={id:attachmentId,filename:item.filename,mimeType:item.mime_type,size:item.size};
    if(item.size>10*1024*1024)return response({...metadata,note:"File is over 10 MB and was not injected into model context. Download it from the authenticated A2Ac attachment endpoint when local inspection is needed."});
    const data=await readFile(join(store.uploadsDir,item.stored_name));
    if(item.mime_type.startsWith("image/"))return {content:[{type:"text" as const,text:JSON.stringify(metadata)},{type:"image" as const,data:data.toString("base64"),mimeType:item.mime_type}]};
    if(item.mime_type.startsWith("text/")||/\.(md|json|lua|luau|js|ts|txt|csv)$/i.test(item.filename))return response({...metadata,text:data.toString("utf8")});
    return response({...metadata,note:"Binary attachment is available but was not injected into model context."});
  });

  server.registerTool("a2ac_report_action", {
    title: "Report agent action",
    description: "Publish a concise action summary with expandable structured context such as files, commands, tool calls, test output, or commit SHA.",
    inputSchema: {
      summary: z.string().min(1), action: z.string().min(1), channel: z.string().optional(),
      files: z.array(z.string()).optional(), command: z.string().optional(), outcome: z.string().optional(), metadata: z.record(z.unknown()).optional(), taskId: z.number().int().optional()
    }
  }, async ({ summary, action, channel, files, command, outcome, metadata, taskId }) => response(store.event(identity, {
    channel, kind: `action.${action}`, summary, taskId, detail: { files, command, outcome, ...metadata }
  })));

  server.registerTool("a2ac_create_task", {
    title: "Create shared task",
    description: "Create a task visible to the whole team.",
    inputSchema: { title: z.string().min(1), description: z.string().default(""), priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"), assignee: z.string().optional() }
  }, async (input) => response(store.createTask(identity, input)));

  server.registerTool("a2ac_update_task", {
    title: "Update shared task",
    description: "Claim, progress, block, or finish a task. Pass expectedVersion from the task to prevent overwriting another agent's update.",
    inputSchema: {
      taskId: z.number().int(), status: z.enum(["open", "in_progress", "waiting", "stalled", "paused", "blocked", "done", "cancelled"]).optional(),
      assignee: z.string().nullable().optional(), description: z.string().optional(), expectedVersion: z.number().int().optional()
    }
  }, async ({ taskId, ...patch }) => response(store.updateTask(identity, taskId, patch)));

  server.registerTool("a2ac_claim_resource", {
    title: "Claim files or subsystem",
    description: "Acquire a short lease on a file path, directory, branch, Roblox subsystem, or other named resource before editing it.",
    inputSchema: { resource: z.string().min(1), reason: z.string().default(""), ttlMinutes: z.number().int().min(1).max(240).default(30) }
  }, async ({ resource, reason, ttlMinutes }) => response(store.claim(identity, resource, ttlMinutes, reason)));

  server.registerTool("a2ac_release_resource", {
    title: "Release resource claim",
    description: "Release your resource lease as soon as the edit or handoff is complete.",
    inputSchema: { resource: z.string().min(1) }
  }, async ({ resource }) => response(store.release(identity, resource)));

  server.registerTool("a2ac_heartbeat", {
    title: "Update agent presence",
    description: "Tell teammates whether you are available and what you are working on.",
    inputSchema: { status: z.enum(["online", "working", "waiting", "blocked", "offline"]).default("online"), currentTask: z.string().optional() }
  }, async ({ status, currentTask }) => response(store.touch(identity, status, currentTask)));

  return server;
}

export async function handleMcp(req: Request, res: Response, store: Store) {
  const server = createMcpServer(store, req.identity!);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
