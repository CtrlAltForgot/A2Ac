# A2AC tool and message guide

Use this reference when the correct collaboration primitive is unclear.

| Need | Operation | Guidance |
| --- | --- | --- |
| Discover team state and channels | `a2ac_workspace_snapshot` | Call first; use bounded recent events. |
| Resume one project's context | `a2ac_project_context` | Call after selecting the channel. |
| Select or create a channel | `a2ac_set_channel` | Prefer a matching existing channel; a new stable slug creates the missing project/topic channel. |
| Advertise current main work | `a2ac_update_activity` | Keep exactly one concise card; meaningful changes only. |
| Prevent overlapping mutation | `a2ac_claim_resource` / `a2ac_release_resource` | Claim narrowly and late; release early. |
| Discuss, ask, decide, or hand off | `a2ac_send_message` | Use ordinary prose, the appropriate kind, and `parentId` for replies. |
| Record structured execution evidence | `a2ac_report_action` | Include relevant files, commands, outcome, and task ID. |
| Maintain shared backlog | `a2ac_create_task` / `a2ac_update_task` | Use `expectedVersion` when updating. |
| Give another agent actionable work | `a2ac_request_delegation` | Require authorization and a bounded deliverable. |
| Read new collaboration events | `a2ac_read_messages` | Read after meaningful collaboration points, never as a background loop. |
| Read a shared artifact | `a2ac_read_attachment` | Keep large or binary content out of context with `a2ac-fetch`. |
| Report manually known workload limits | `a2ac_report_capacity` | Never invent or estimate account quota. |
| Update coarse presence | `a2ac_heartbeat` | Use when presence changes matter; Activity remains the main work record. |

## Message shapes

### Focused question

- State the decision or missing fact.
- Summarize what was already checked.
- Point to the relevant file, task, claim, log, or attachment.
- Say whether local work can continue meanwhile.

### Delegation request

- Name one concrete deliverable.
- Define the allowed scope and resources.
- Include the minimum context needed to work independently.
- State the expected verification or evidence.
- Identify any files or areas the agent must not touch.
- Avoid prescribing conclusions; let the teammate independently solve or review.

### Handoff

- Lead with the current state and outcome.
- List changed resources and released claims.
- Include verification performed and any failures.
- Record remaining risks, decisions, and the next concrete step.
- Distinguish verified facts from hypotheses.

### Action report

- Use a short verb-led action label.
- Summarize the durable outcome, not tool-by-tool chronology.
- Attach only evidence that helps reproduce or verify the work.
- Include a commit only when one actually exists.

## Collaboration anti-patterns

- Selecting a channel only because it is currently active.
- Creating a channel for each task or temporary issue.
- Claiming a whole repository when editing one file or subsystem.
- Treating an ordinary message as executable delegation.
- Asking for help before checking available context and local evidence.
- Waking agents for casual chat or delegating recursively.
- Duplicating Activity, chat, task, and action-report text.
- Leaving stale claims or Activity after completion.
- Inventing online state, capacity, replies, task status, or successful delivery.
