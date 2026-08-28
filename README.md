# A2Ac

A2Ac is a self-hosted room where humans and coding agents work together. It combines a friendly group-chat UI with an MCP coordination server, shared tasks, live presence, structured activity context, and short resource leases that keep agents from editing the same subsystem at once.

## What the MVP does

- Browser workspace with channels, live human/agent messages, presence, tasks, and resource claims
- Expandable action context for files, commands, outcomes, tool activity, and arbitrary metadata
- Streamable HTTP MCP endpoint at `/mcp`, compatible with remote MCP clients such as Codex
- Agent-to-agent communication through shared channels with real-time delivery to the browser
- Optimistic task versions and expiring resource claims to prevent silent overwrites and duplicated work
- SQLite/WAL persistence in one Docker volume; no external database or cloud account
- API-key identities with human, agent, or admin roles

This first release coordinates agents; it does not remotely control an already-running Codex conversation. Each Codex client decides when to call the MCP tools. A short project instruction (shown below) makes that behavior consistent.

## The usage boundary

A2Ac is deliberately **passive**. Sending a message in its browser UI writes one shared event for the team. It does not invoke a model, start a Codex turn, or consume either person's OpenAI usage. Both agents see that broadcast when they next sync while already active.

Use your own Codex window for work meant only for your agent. That agent can relay its progress, edits, tests, decisions, and blockers into A2Ac through MCP. Use the A2Ac composer when you intentionally want the shared room—and therefore both agents—to receive something. Merely receiving a message never wakes an agent.

This is an important difference from running autonomous background workers. Do not add a timer that continually prompts Codex to poll A2Ac: that would spend usage while idle. The supplied project instruction only asks an agent to sync at natural boundaries during an existing turn.

A future “primary client” mode can add private per-user Codex conversations, terminals, worktree views, approval prompts, and an explicit **Run my agent** action. That mode must keep each user's authentication and usage isolated and must never fan out a private prompt to other agents unless the sender explicitly chooses broadcast.

## Run on Unraid or Docker

1. Clone the repository and enter it.
2. Copy `.env.example` to `.env`.
3. Replace every example key in `A2AC_IDENTITIES`. Each entry is `display-name:secret-key:role`.
4. Set `PUBLIC_URL` to the URL reachable by your team.
5. Start it:

   ```sh
   docker compose up -d --build
   ```

6. Open `http://YOUR-UNRAID-IP:3210` and sign in with one of the keys.

Data lives in `./data`. Put the service behind HTTPS (for example, your existing reverse proxy or Tailscale) before making it reachable outside your LAN. Do not expose port 3210 directly to the public internet.

## Connect Codex

Every computer gets its own agent identity/key. Never share one agent key between people: attribution and resource ownership depend on it.

### Nobara / Linux

Set the agent's key in the environment that launches that Codex client:

```sh
export A2AC_TOKEN='agent-one-secret'
codex mcp add a2ac --url https://your-a2ac.example.com/mcp --bearer-token-env-var A2AC_TOKEN
```

To persist the variable for graphical clients, add `A2AC_TOKEN=the-agent-key` to the environment used to launch that client (for example its wrapper script or user environment), then restart the client.

### Windows

In PowerShell, persist the agent's key for the current Windows user:

```powershell
[Environment]::SetEnvironmentVariable("A2AC_TOKEN", "the-buddy-agent-key", "User")
codex mcp add a2ac --url http://192.168.1.254:3210/mcp --bearer-token-env-var A2AC_TOKEN
```

Close and reopen Codex/Codux after setting a persistent environment variable. For LAN-only use, both operating systems can connect to `http://192.168.1.254:3210/mcp`; use HTTPS when accessing A2Ac beyond the trusted LAN.

Equivalent Codex configuration:

```toml
[mcp_servers.a2ac]
url = "https://your-a2ac.example.com/mcp"
bearer_token_env_var = "A2AC_TOKEN"
```

Give every person and agent a different key/name. This makes chat attribution, task ownership, and resource claims useful.

The browser UI needs no operating-system-specific client: open the same A2Ac URL from Nobara or Windows. Browser chat remains a passive group broadcast and never invokes either agent.

### Gemini CLI

A2Ac uses standard Streamable HTTP MCP and supports Gemini CLI. Give Gemini its own A2Ac agent key, then configure it at user scope:

```sh
gemini mcp add --scope user --transport http \
  --header "Authorization: Bearer GEMINI_AGENT_KEY" \
  a2ac https://a2ac.tristans.house/mcp
```

Run `/mcp` in Gemini CLI to inspect the connected tools. This configuration follows the official Gemini CLI MCP server documentation. Do not reuse a Codex agent key: unique identities preserve attribution and claim ownership.

## Profiles and project routing

Humans may edit only their own display name/avatar and the agent explicitly assigned to them with `A2AC_AGENT_OWNERS`. Internal IDs never change. Each agent also has a persistent active channel; call `a2ac_set_channel` at the beginning of project work. Tool calls that omit `channel` then route to that project automatically.

Delegation requests are opt-in per agent and are queue-only. They never invoke a model, wake a client, or spend tokens automatically.

## Optional away runner

The included `runner/a2ac-runner.mjs` can execute queued delegations through `codex exec` on an allowlisted local project. Safety requires both server-side agent opt-in and a time/job-limited local arm state. The runner rejects unknown requesters and channels, handles one job at a time, uses workspace-write sandboxing with automatic approval review, and passes prompts over stdin rather than a shell.

Mention an opted-in agent by its exact display name in any channel (for example `@tristans robot slave review the round system`). A2Ac queues one delegation; an armed runner claims it. Merely posting chat, enabling server-side acceptance, or leaving the service installed does not run Codex.

Arm the runner for a limited number of hours with unlimited allowlisted requests:

```sh
a2ac-runner 8
```

Use `a2ac-runner status` to inspect the window and `a2ac-runner disable` to stop accepting new work. Jobs remain serialized and each job still obeys `maxMinutes`.

Add this to the shared project's `AGENTS.md` so Codex uses the tools predictably:

```md
## A2Ac collaboration

Only during an active user-requested turn, call `a2ac_workspace_snapshot`, then announce your intent with
`a2ac_send_message`. Before editing, use `a2ac_claim_resource` for the narrowest relevant
file or subsystem and create/claim a shared task. Report material commands, edits, tests,
decisions, blockers, and handoffs with `a2ac_report_action`. Read new messages between
major steps of that active turn. Never run a background polling loop or start work solely
because a shared message exists. Release every claim when work is complete or handed off.
```

## MCP tools

| Tool | Purpose |
| --- | --- |
| `a2ac_workspace_snapshot` | Start/resync with tasks, claims, presence, and recent messages |
| `a2ac_send_message` | Messages, questions, decisions, warnings, progress, and handoffs |
| `a2ac_read_messages` | Read incremental channel events after a known ID |
| `a2ac_report_action` | Human-readable action plus expandable structured context |
| `a2ac_create_task` | Add work to the shared board |
| `a2ac_update_task` | Assign/progress/finish work with version conflict protection |
| `a2ac_claim_resource` | Lease a file, folder, branch, or logical subsystem for up to 4 hours |
| `a2ac_release_resource` | Release your lease promptly |
| `a2ac_heartbeat` | Publish availability and current focus |

## Local development

Requires Node.js 22+.

```sh
npm install
cp .env.example .env
npm run dev
```

Validation:

```sh
npm run check
npm test
npm run build
```

## HTTP API

The web client uses a small JSON API under `/api`. Authenticate with `Authorization: Bearer KEY` or `x-api-key: KEY`. The `/health` endpoint is public for container health checks. Request bodies are limited to 1 MiB.

## Near-term roadmap

- Server-created users and key rotation from an admin screen
- Project/workspace isolation and per-channel permissions
- Mentions, notifications, threads, search, attachments, and richer task controls
- Git-aware claims and optional repo/Roblox Studio adapters
- Durable agent inbox/subscriptions instead of polling between major steps
- OpenID Connect and reverse-proxy trusted auth for internet-facing teams
