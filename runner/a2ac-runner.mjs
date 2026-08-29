#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const configPath = process.env.A2AC_RUNNER_CONFIG || join(homedir(), ".config/a2ac-runner/config.json");
const statePath = join(dirname(configPath), "state.json");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ambientThreads=new Map();
// Ambient chat only needs A2Ac and ordinary local/web tools. Roblox Studio's
// Windows MCP launcher is a generated mcp.bat file; starting it from a hidden
// ambient thread can keep that file open while Studio tries to regenerate it.
// Disable the official server name for these disposable chat threads. Explicit
// delegated project jobs still inherit Studio MCP because they may need it.
const ambientCodexConfig={mcp_servers:{Roblox_Studio:{enabled:false}}};

async function json(path, fallback = {}) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } }
async function save(path, value) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temp, path); await chmod(path, 0o600); }

const command = process.argv[2] || "daemon";
if (command === "enable" || /^\d+(?:\.\d+)?$/.test(command)) {
  const persistent=command==="enable",shorthand=!persistent;
  const hours = persistent?null:Math.max(1,Math.min(Number(command),24));
  const requestedJobs = persistent||process.argv[3] === undefined ? -1 : Number(process.argv[3]);
  const jobs = requestedJobs === -1 ? -1 : Math.max(1, Math.min(requestedJobs, 100));
  const armedAt=Date.now();
  await save(statePath, { persistent,enabledUntil:persistent?null:armedAt+hours*3_600_000,jobsRemaining:jobs,armedAt });
  console.log(`A2Ac runner armed ${persistent?"until disabled":`for ${hours}h`} / ${jobs === -1 ? "unlimited jobs" : `${jobs} jobs`}. Disable with: a2ac-runner disable`);
  process.exit(0);
}
if (command === "disable") { await save(statePath, { enabledUntil: 0, jobsRemaining: 0 }); console.log("A2Ac runner disabled."); process.exit(0); }
if (command === "status") { const state = await json(statePath); const armed = (state.persistent||state.enabledUntil>Date.now())&&state.jobsRemaining!==0; console.log(armed ? `${state.persistent?"armed until disabled":`armed until ${new Date(state.enabledUntil).toLocaleString()}`} (${state.jobsRemaining === -1 ? "unlimited jobs" : `${state.jobsRemaining} jobs left`})` : "disabled"); process.exit(0); }

const config = await json(configPath);
for (const field of ["serverUrl", "agentKey", "codexPath", "projects"]) if (!config[field]) throw new Error(`Missing ${field} in ${configPath}`);
const api = async (path, options = {}) => {
  const response = await fetch(`${config.serverUrl}${path}`, { ...options, headers: { authorization: `Bearer ${config.agentKey}`, "content-type": "application/json", ...options.headers } });
  if (!response.ok) throw new Error(`A2Ac ${response.status}: ${await response.text()}`);
  return response.json();
};

async function runCodex(request, previousChannel) {
  const ambient=request.request_type==="ambient";
  if (!ambient&&!(request.channel in config.projects)) throw new Error(`No allowlisted project directory for #${request.channel}`);
  if (!(config.allowedRequesters || []).includes(request.requester)) throw new Error(`Requester ${request.requester} is not allowlisted`);
  const project = config.projects[request.channel]||Object.values(config.projects)[0];
  if(!project)throw new Error("No allowlisted project directory is configured");
  const output = join(tmpdir(), `a2ac-runner-${request.id}-${Date.now()}.txt`);
  const prompt = ambient
    ? `You are a short-lived ambient A2Ac chat instance, separate from the owner's main agent. Human ${request.requester} posted event #${request.source_event_id} in #${request.channel}: ${request.request}\n\nLoad a2ac_project_context for exactly #${request.channel} with messageLimit 20, find event #${request.source_event_id}, and consider its nearby conversation and attachments. Draft one concise human-style response when the message is reasonably directed to you or the group. IMPORTANT: do not call a2ac_send_message; return only the response draft because the runner will combine rapid follow-ups and publish once. If this is a continuation on the same thread, replace your earlier draft with one consolidated answer covering all new follow-ups. You may answer a question or casually converse. If it asks whether anyone can do work, only volunteer or act when the request is clear, safe, within the allowlisted project, and does not conflict with tasks or claims; announce and claim narrowly first. If the message is clearly between humans, rhetorical, already resolved, or needs no useful response, return an empty response. Never respond to agent-authored chatter, never trigger another delegation, never change the persistent channel, and never create/update/clear Activity or disturb the owner's existing goal.`
    : `You are executing an explicitly queued A2Ac delegation while the owner is away.\n\nDelegation #${request.id}\nRequester: ${request.requester}\nRequest source channel: ${request.channel}\nOwner's persistent agent channel: ${previousChannel}\nRequest: ${request.request}\n\nThis is a temporary side request, not permission to replace or forget the agent's existing goal. Do NOT call a2ac_set_channel: this delegation must never change the owner's persistent channel. First call a2ac_workspace_snapshot, remember any existing Activity/task for this agent, and inspect availableChannels. Semantically choose the existing channel that best matches the actual project/topic in the request; do not blindly use the source channel. Only when absolutely no channel fits, choose a short dedicated project/topic slug. Then call a2ac_project_context for that chosen work channel. Pass the chosen work channel explicitly to every A2Ac message, action, claim, and release tool that accepts it. If this agent already has an Activity, NEVER overwrite, complete, idle, or otherwise modify that Activity; use concise channel progress messages for this delegation instead. If it has no Activity, a temporary Activity is allowed and must be cleared when done. Respect all tasks and claims, announce the run, claim narrowly, do only the requested side work, test proportionately, report actions, release every delegation claim, and leave the original goal/task/Activity intact so its normal session can continue. Do not perform unrelated work or request another autonomous run.`;
  if(ambient){
    const now=Date.now(),existing=ambientThreads.get(request.channel);
    let thread=existing&&now-existing.lastUsed<=60_000?existing.thread:null;
    if(!thread){
      const {Codex}=await import("@openai/codex-sdk");
      const codex=new Codex({codexPathOverride:config.codexPath,config:ambientCodexConfig,env:{...process.env,A2AC_TOKEN:config.agentKey}});
      thread=codex.startThread({workingDirectory:project,skipGitRepoCheck:true,sandboxMode:"workspace-write",approvalPolicy:"never",networkAccessEnabled:true});
    }
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),Math.max(5,Math.min(config.maxMinutes||45,90))*60_000);
    try{const result=await thread.run(prompt,{signal:controller.signal});ambientThreads.set(request.channel,{thread,lastUsed:Date.now()});return{status:"completed",result:result.finalResponse.slice(0,4000),usageWarning:false};}
    catch(error){ambientThreads.delete(request.channel);const message=error instanceof Error?error.message:String(error);return{status:"failed",result:message.slice(0,4000),usageWarning:/\b(?:usage|rate|plan|quota)\s*(?:limit|cap)|too many requests|limit (?:reached|exceeded)|resets? (?:at|in)/i.test(message)};}
    finally{clearTimeout(timeout);}
  }
  const args = ["exec", "--approve-for-me", "--ephemeral", "--cd", project, "--output-last-message", output, "-"];
  const child = spawn(config.codexPath, args, { stdio: ["pipe", "inherit", "pipe"], env: { ...process.env, A2AC_TOKEN: config.agentKey } });
  let stderr="";child.stderr.on("data",chunk=>{const text=chunk.toString();stderr=(stderr+text).slice(-12000);process.stderr.write(text);});
  child.stdin.end(prompt);
  const timeout = setTimeout(() => child.kill("SIGTERM"), Math.max(5, Math.min(config.maxMinutes || 45, 90)) * 60_000);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  clearTimeout(timeout);
  const result = await readFile(output, "utf8").catch(() => `Codex exited with code ${code}${stderr?`\n${stderr}`:""}`);
  const usageWarning=code!==0&&/\b(?:usage|rate|plan|quota)\s*(?:limit|cap)|too many requests|limit (?:reached|exceeded)|resets? (?:at|in)/i.test(stderr);
  return { status: code === 0 ? "completed" : "failed", result: result.slice(0, 4000),usageWarning };
}

console.log("A2Ac runner service started; local arming is currently required before jobs can run.");
for (;;) {
  let loopDelay=10_000;
  try {
    const state = await json(statePath);
    const armed=(state.persistent||state.enabledUntil>Date.now())&&state.jobsRemaining!==0;
    await api("/api/runner/heartbeat",{method:"POST",body:JSON.stringify({armed})});
    if (armed) {
      loopDelay=2_000;
      if(!state.armedAt){state.armedAt=Date.now();await save(statePath,state);}
      const me=await api("/api/me");
      const previousChannel=me.profile?.active_channel||"general";
      const { request } = await api(`/api/runner/delegations/next?notBefore=${encodeURIComponent(state.armedAt)}`);
      if (request) {
        await save(statePath, { ...state, jobsRemaining: state.jobsRemaining > 0 ? state.jobsRemaining - 1 : -1 });
        let outcome,current=request;
        await api("/api/runner/typing",{method:"POST",body:JSON.stringify({active:true,stage:"thinking",channel:request.channel,parentId:request.source_event_id||null})});
        const workingTimer=setTimeout(()=>api("/api/runner/typing",{method:"POST",body:JSON.stringify({active:true,stage:"working",channel:request.channel,parentId:request.source_event_id||null})}).catch(()=>{}),8_000);
        try {
          for(;;){
            try { outcome = await runCodex(current,previousChannel); } catch (error) { outcome = { status: "failed", result: error instanceof Error ? error.message : String(error) }; }
            if(current.request_type!=="ambient"||outcome.status!=="completed")break;
            await sleep(900);
            const followUp=(await api(`/api/runner/ambient/next?channel=${encodeURIComponent(current.channel)}`)).request;
            if(!followUp)break;
            await api(`/api/runner/delegations/${current.id}/finish`,{method:"POST",body:JSON.stringify({status:"completed",result:"Draft consolidated into the next rapid ambient follow-up."})});
            current=followUp;
            await api("/api/runner/typing",{method:"POST",body:JSON.stringify({active:true,stage:"thinking",channel:current.channel,parentId:current.source_event_id||null})});
          }
          if(current.request_type==="ambient"&&outcome.status==="completed"&&outcome.result.trim())await api("/api/events",{method:"POST",body:JSON.stringify({channel:current.channel,kind:"message",summary:outcome.result.trim(),parentId:current.source_event_id||null})});
        } catch(error){outcome={status:"failed",result:error instanceof Error?error.message:String(error)};}
        if(outcome.usageWarning)await api(`/api/profiles/${encodeURIComponent(me.name)}`,{method:"PATCH",body:JSON.stringify({workCapacity:"conserve",capacityNote:`Codex runner reported a real usage/rate-limit warning at ${new Date().toLocaleString()}.`})}).catch(error=>console.error("Could not publish capacity warning:",error.message));
        try{await api(`/api/runner/delegations/${current.id}/finish`, { method: "POST", body: JSON.stringify(outcome) });}finally{clearTimeout(workingTimer);await api("/api/runner/typing",{method:"POST",body:JSON.stringify({active:false})}).catch(()=>{});await api("/api/runner/channel",{method:"POST",body:JSON.stringify({channel:previousChannel})});}
      }
    }
  } catch (error) { console.error(new Date().toISOString(), error instanceof Error ? error.message : error); }
  await sleep(loopDelay);
}
