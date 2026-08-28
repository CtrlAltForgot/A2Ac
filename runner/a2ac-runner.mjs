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
if (command === "enable") {
  const hours = Math.max(1, Math.min(Number(process.argv[3] || 8), 24));
  const jobs = Math.max(1, Math.min(Number(process.argv[4] || 3), 10));
  await save(statePath, { enabledUntil: Date.now() + hours * 3_600_000, jobsRemaining: jobs });
  console.log(`A2Ac runner armed for ${hours}h / ${jobs} jobs. Disable with: a2ac-runner disable`);
  process.exit(0);
}
if (command === "disable") { await save(statePath, { enabledUntil: 0, jobsRemaining: 0 }); console.log("A2Ac runner disabled."); process.exit(0); }
if (command === "status") { const state = await json(statePath); console.log(state.enabledUntil > Date.now() && state.jobsRemaining > 0 ? `armed until ${new Date(state.enabledUntil).toLocaleString()} (${state.jobsRemaining} jobs left)` : "disabled"); process.exit(0); }

const config = await json(configPath);
for (const field of ["serverUrl", "agentKey", "codexPath", "projects"]) if (!config[field]) throw new Error(`Missing ${field} in ${configPath}`);
const api = async (path, options = {}) => {
  const response = await fetch(`${config.serverUrl}${path}`, { ...options, headers: { authorization: `Bearer ${config.agentKey}`, "content-type": "application/json", ...options.headers } });
  if (!response.ok) throw new Error(`A2Ac ${response.status}: ${await response.text()}`);
  return response.json();
};

async function runCodex(request) {
  if (!(request.channel in config.projects)) throw new Error(`No allowlisted project directory for #${request.channel}`);
  if (!(config.allowedRequesters || []).includes(request.requester)) throw new Error(`Requester ${request.requester} is not allowlisted`);
  const project = config.projects[request.channel];
  const output = join(tmpdir(), `a2ac-runner-${request.id}-${Date.now()}.txt`);
  const prompt = `You are executing an explicitly queued A2Ac delegation while the owner is away.\n\nDelegation #${request.id}\nRequester: ${request.requester}\nProject channel: ${request.channel}\nRequest: ${request.request}\n\nFirst call a2ac_set_channel for ${request.channel}, then a2ac_workspace_snapshot. Respect all tasks and resource claims. Announce this delegated run, claim only the narrowest resources needed, do the requested work in the current repository, run proportionate tests, report actions through A2Ac, and release claims when complete. Do not perform unrelated work or request another autonomous run.`;
  const args = ["exec", "--approve-for-me", "--sandbox", "workspace-write", "--cd", project, "--output-last-message", output, "-"];
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
    if (state.enabledUntil > Date.now() && state.jobsRemaining > 0) {
      const { request } = await api("/api/runner/delegations/next");
      if (request) {
        await save(statePath, { ...state, jobsRemaining: state.jobsRemaining - 1 });
        let outcome;
        try { outcome = await runCodex(request); } catch (error) { outcome = { status: "failed", result: error instanceof Error ? error.message : String(error) }; }
        await api(`/api/runner/delegations/${request.id}/finish`, { method: "POST", body: JSON.stringify(outcome) });
      }
    }
  } catch (error) { console.error(new Date().toISOString(), error instanceof Error ? error.message : error); }
  await sleep(10_000);
}
