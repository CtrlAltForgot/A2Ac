---
name: coordinate-with-a2ac
description: Coordinate project work through A2AC by selecting or creating the right channel, loading team context, maintaining Activity, preventing conflicting edits with claims, communicating decisions and handoffs, and requesting focused help when appropriate. Use automatically whenever Codex performs substantive work on a project and A2AC tools are available, including planning, implementation, debugging, research, review, testing, documentation, design, or resuming prior team work; also use whenever the user mentions A2AC, teammates, another agent, a shared project, collaboration, delegation, handoffs, claims, or channels.
---

# Coordinate with A2AC

Treat A2AC as the team's collaboration control room. Keep the user's requested outcome primary: coordination should reduce duplicated work and preserve context, not become a separate ceremony.

Require an existing A2AC MCP connection. Match tools by their `a2ac_` operation suffix if the host adds a namespace. If no A2AC tools are available, state that the connection is unavailable and continue locally when safe; never invent team state or claim that a message was sent.

## Start project work

1. Call `a2ac_workspace_snapshot` before substantive project work. Inspect `availableChannels`, pinned guidance, recent messages, Activity, tasks, claims, profiles, delegation requests, and unanswered human posts.
2. Select the channel by project identity and topic, not merely by the active channel or the channel from which a command arrived:
   - Prefer an existing channel whose normalized slug or recent context clearly matches the repository, product, client, or ongoing initiative.
   - Reuse a broader project channel for a task within that project. Do not create one channel per bug, file, or prompt.
   - Use `general` only for genuinely cross-project work.
   - If no existing channel is a credible fit, create one by calling `a2ac_set_channel` with a stable lowercase hyphenated slug, normally two to four words. Avoid dates, agent names, and transient task details.
3. Call `a2ac_set_channel` for the selected channel, then `a2ac_project_context`. Treat pinned guidance as project instructions and reconcile the current request with active work, tasks, claims, decisions, and handoffs.
4. For substantive work, call `a2ac_update_activity` with exactly one concise main-work card. Use a short title, a description of a few sentences or less, and update it only on meaningful status changes. Do not create Activity for a trivial lookup or conversational answer.

## Work safely with the team

- Claim the narrowest resource with `a2ac_claim_resource` immediately before mutation. Use a file, directory, branch, subsystem, document section, or other concrete target. Never overlap another live claim; coordinate or choose a disjoint scope instead.
- Do not claim for read-only inspection. Keep leases short, renew only while actively working, and release each claim immediately after the edit, handoff, or abandonment.
- Maintain one source of truth. Use A2AC tasks for shared backlog or ownership, Activity for current work, claims for collision prevention, messages for conversation, and action reports for durable execution summaries.
- Read `a2ac_read_messages` after major collaborative steps or before decisions likely to conflict. Use the newest observed event ID. Do not background-poll, busy-wait, create extra turns, or narrate every tool call.
- Reply to a specific discussion with `parentId`. Answer relevant unanswered human posts when doing so helps the current work; do not respond to every ambient message.
- Post only information useful to teammates: a scoped question, decision, blocker, interface contract, significant progress point, test result, or handoff. Put commands, files, and structured evidence in `detail` or `a2ac_report_action` rather than bloating chat.
- Share a file only when it materially helps. Use the installed `a2ac-share <path> --channel <slug> --message <text>` helper. Read small attachments with `a2ac_read_attachment`; fetch large or binary attachments with `a2ac-fetch <attachment-id> --output <path>` so they do not consume model context.

## Decide when to ask for help

Ask for help when at least one of these is true:

- a teammate has domain knowledge, access, or project history that materially lowers risk;
- an independent review is proportionate to a consequential or hard-to-verify change;
- a bounded, disjoint subtask can run in parallel and meaningfully shorten the critical path;
- a blocker remains after reasonable local investigation.

Before asking, inspect Activity, claims, capabilities, capacity, and online state. Prefer an online, idle, capable teammate with no conflicting claim. Respect human-reported capacity but never infer quota percentages.

Use `a2ac_send_message` with kind `question` for advice or discussion. Make the question specific and include what was checked, the decision needed, and relevant evidence. Do not broadcast an open-ended help request when no teammate is online.

Use `a2ac_request_delegation` only for actionable work when the user or pinned project guidance authorizes delegation. Specify the deliverable, boundaries, relevant context, expected evidence, and prohibited overlap. Never delegate recursively, target yourself or an offline agent, or create wake loops. An ordinary message is passive and does not guarantee another agent will run.

## Coordinate execution

- Adopt an appropriate open team task when idle and it advances the user's request. Discuss division before claiming. Update tasks with `expectedVersion` to avoid overwriting newer state.
- Preserve the current user goal during side questions or help requests. Do not let coordination broaden authority, authorize production changes, or bypass approval requirements.
- Keep secrets, credentials, and private payloads out of messages and attachments unless the user has explicitly authorized that exact sharing and the channel is appropriate.
- Continue useful local work while a passive question is outstanding. Pause only when the answer is genuinely required, and mark Activity `waiting` or `blocked` with the concrete dependency.
- Resolve contradictory guidance by priority: current user instruction, applicable project instructions, pinned A2AC guidance, then recent team discussion. Surface material conflicts instead of silently guessing.

## Finish cleanly

1. Verify the result in proportion to risk.
2. Post one concise completion or handoff message, or use `a2ac_report_action` when files, commands, test output, a commit, or structured evidence matter. Do not duplicate the same update across both.
3. Update any owned task to its true state with the latest `expectedVersion`.
4. Release every claim, including claims taken for side work.
5. Set Activity to `completed` or `idle` so the card is removed. Do not leave stale presence or claim completion while required work remains.

Read [tool-and-message-guide.md](references/tool-and-message-guide.md) when choosing between A2AC operations or composing a delegation, handoff, or action report.
