#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const configPath = process.env.A2AC_RUNNER_CONFIG || join(homedir(), ".config/a2ac-runner/config.json");
const statePath = join(dirname(configPath), "state.json");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function json(path, fallback = {}) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } }
async function save(path, value) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temp, path); await chmod(path, 0o600); }

const command = process.argv[2] || "daemon";
if (command === "enable" || /^\d+(?:\.\d+)?$/.test(command)) {
  const shorthand = command !== "enable";
  const hours = Math.max(1, Math.min(Number(shorthand ? command : process.argv[3] || 8), 24));
  const requestedJobs = shorthand || process.argv[4] === undefined ? -1 : Number(process.argv[4]);
  const jobs = requestedJobs === -1 ? -1 : Math.max(1, Math.min(requestedJobs, 100));
  const armedAt=Date.now();
  await save(statePath, { enabledUntil: armedAt + hours * 3_600_000, jobsRemaining: jobs, armedAt });
  console.log(`A2Ac runner armed for ${hours}h / ${jobs === -1 ? "unlimited jobs" : `${jobs} jobs`}. Disable with: a2ac-runner disable`);
  process.exit(0);
}
if (command === "disable") { await save(statePath, { enabledUntil: 0, jobsRemaining: 0 }); console.log("A2Ac runner disabled."); process.exit(0); }
if (command === "status") { const state = await json(statePath); const armed = state.enabledUntil > Date.now() && state.jobsRemaining !== 0; console.log(armed ? `armed until ${new Date(state.enabledUntil).toLocaleString()} (${state.jobsRemaining === -1 ? "unlimited jobs" : `${state.jobsRemaining} jobs left`})` : "disabled"); process.exit(0); }

const config = await json(configPath);
for (const field of ["serverUrl", "agentKey", "codexPath", "projects"]) if (!config[field]) throw new Error(`Missing ${field} in ${configPath}`);
const api = async (path, options = {}) => {
  const response = await fetch(`${config.serverUrl}${path}`, { ...options, headers: { authorization: `Bearer ${config.agentKey}`, "content-type": "application/json", ...options.headers } });
  if (!response.ok) throw new Error(`A2Ac ${response.status}: ${await response.text()}`);
  return response.json();
};

async function runCodex(request, previousChannel) {
  if (!(request.channel in config.projects)) throw new Error(`No allowlisted project directory for #${request.channel}`);
  if (!(config.allowedRequesters || []).includes(request.requester)) throw new Error(`Requester ${request.requester} is not allowlisted`);
  const project = config.projects[request.channel];
  const output = join(tmpdir(), `a2ac-runner-${request.id}-${Date.now()}.txt`);
  const prompt = `You are executing an explicitly queued A2Ac delegation while the owner is away.\n\nDelegation #${request.id}\nRequester: ${request.requester}\nRequest source channel: ${request.channel}\nOwner's persistent agent channel: ${previousChannel}\nRequest: ${request.request}\n\nDo NOT call a2ac_set_channel: this delegation must never change the owner's persistent channel. First call a2ac_workspace_snapshot and inspect availableChannels. Semantically choose the existing channel that best matches the actual project/topic in the request; do not blindly use the source channel. Only when absolutely no channel fits, choose a short dedicated project/topic slug—the first Activity/message will create it. Then call a2ac_project_context for that chosen work channel. Pass the chosen work channel explicitly to every A2Ac message, action, activity, claim, and release tool that accepts it. Respect all tasks and claims, announce the run, maintain one concise Activity card, claim narrowly, do only the requested work, test proportionately, report actions, release every claim, and mark Activity completed when finished. Do not perform unrelated work or request another autonomous run.`;
  const args = ["exec", "--approve-for-me", "--ephemeral", "--cd", project, "--output-last-message", output, "-"];
  const child = spawn(config.codexPath, args, { stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, A2AC_TOKEN: config.agentKey } });
  child.stdin.end(prompt);
  const timeout = setTimeout(() => child.kill("SIGTERM"), Math.max(5, Math.min(config.maxMinutes || 45, 90)) * 60_000);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  clearTimeout(timeout);
  const result = await readFile(output, "utf8").catch(() => `Codex exited with code ${code}`);
  return { status: code === 0 ? "completed" : "failed", result: result.slice(0, 4000) };
}

console.log("A2Ac runner service started; local arming is currently required before jobs can run.");
for (;;) {
  try {
    const state = await json(statePath);
    if (state.enabledUntil > Date.now() && state.jobsRemaining !== 0) {
      if(!state.armedAt){state.armedAt=Date.now();await save(statePath,state);}
      const me=await api("/api/me");
      const previousChannel=me.profile?.active_channel||"general";
      const { request } = await api(`/api/runner/delegations/next?notBefore=${encodeURIComponent(state.armedAt)}`);
      if (request) {
        await save(statePath, { ...state, jobsRemaining: state.jobsRemaining > 0 ? state.jobsRemaining - 1 : -1 });
        let outcome;
        try { outcome = await runCodex(request,previousChannel); } catch (error) { outcome = { status: "failed", result: error instanceof Error ? error.message : String(error) }; }
        try{await api(`/api/runner/delegations/${request.id}/finish`, { method: "POST", body: JSON.stringify(outcome) });}finally{await api("/api/runner/channel",{method:"POST",body:JSON.stringify({channel:previousChannel})});}
      }
    }
  } catch (error) { console.error(new Date().toISOString(), error instanceof Error ? error.message : error); }
  await sleep(10_000);
}
