const $ = (selector) => document.querySelector(selector);
const state = { token: localStorage.getItem("a2ac-token") || "", channel: "general", snapshot: null, ws: null, seen: {}, seenKey: "", replyTo: null };

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", authorization: `Bearer ${state.token}`, ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
const initials = (name = "?") => name.split(/[\s-_]+/).map(x => x[0]).join("").slice(0, 2).toUpperCase();
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const relative = (date) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(`${date}Z`));
const elapsed = date => { if (!date) return "not started"; const minutes = Math.max(0, Math.floor((Date.now() - new Date(`${date}Z`)) / 60000)); if (minutes < 1) return "just started"; if (minutes < 60) return `${minutes}m`; const hours = Math.floor(minutes / 60), rest = minutes % 60; if (hours < 24) return `${hours}h ${rest}m`; return `${Math.floor(hours / 24)}d ${hours % 24}h`; };
const profileFor = name => state.snapshot?.profiles?.find(profile => profile.name === name) || { name, display_name: name, avatar: null };
const avatarContent = profile => profile.avatar ? `<img src="${profile.avatar}" alt="">` : initials(profile.display_name || profile.name);

async function login(token) {
  state.token = token;
  await api("/api/me");
  localStorage.setItem("a2ac-token", token);
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  await refresh(); connect();
}

async function refresh() {
  state.snapshot = await api(`/api/snapshot?channel=${encodeURIComponent(state.channel)}`);
  if (!state.seenKey) {
    state.seenKey = `a2ac-seen-${state.snapshot.me.name}`;
    try { state.seen = JSON.parse(localStorage.getItem(state.seenKey) || "{}"); } catch { state.seen = {}; }
  }
  const current = state.snapshot.channels.find(channel => channel.channel === state.channel);
  const latestVisible = Math.max(Number(state.snapshot.events.at(-1)?.id || 0), Number(current?.last_event_id || 0));
  if (latestVisible > (state.seen[state.channel] || 0)) {
    state.seen[state.channel] = latestVisible;
    localStorage.setItem(state.seenKey, JSON.stringify(state.seen));
  }
  render();
}

function render() {
  const s = state.snapshot; if (!s) return;
  $("#self-avatar").innerHTML = avatarContent(s.me.profile);
  $("#channel-name").textContent = state.channel;
  $("#typing-hint").textContent = `Broadcast to both agents · no automatic wake-up`;
  const channels = new Set(["general", ...s.channels.map(c => c.channel), state.channel]);
  $("#channels").innerHTML = [...channels].map(name => { const info = s.channels.find(channel => channel.channel === name); const unread = name !== state.channel && Number(info?.last_event_id || 0) > Number(state.seen[name] || 0); return `<button class="channel ${name === state.channel ? "active" : ""}" data-channel="${escapeHtml(name)}"><span>#</span>${escapeHtml(name)}${unread ? `<i class="unread-blip" title="New activity"></i>` : ""}</button>`; }).join("");
  document.querySelectorAll("[data-channel]").forEach(el => el.onclick = async () => { state.channel = el.dataset.channel; await refresh(); });
  $("#online-count").textContent = s.presence.length;
  $("#presence").innerHTML = s.presence.map(p => { const editable = s.me.editableProfiles.includes(p.name); return `<button class="person ${editable ? "editable" : ""}" ${editable ? `data-profile="${escapeHtml(p.name)}"` : "disabled"}><div class="person-avatar">${avatarContent(p)}<i></i></div><div><b>${escapeHtml(p.display_name || p.name)}</b><small>${escapeHtml(p.current_task || p.status)} · #${escapeHtml(p.active_channel || "general")}</small></div></button>`; }).join("");
  document.querySelectorAll("[data-profile]").forEach(el => el.onclick = () => openProfile(el.dataset.profile));
  renderEvents(s.events); renderTasks(s.tasks); renderClaims(s.claims);
}

function renderEvents(events) {
  const timeline = $("#timeline");
  if (!events.length) { timeline.innerHTML = `<div class="empty"><div><strong>#${escapeHtml(state.channel)} is ready</strong>Start a conversation with your humans and agents.</div></div>`; return; }
  const byId = new Map(events.map(event => [event.id, event]));
  timeline.innerHTML = events.map(e => { const profile = profileFor(e.actor), parent = e.parent_id ? byId.get(e.parent_id) : null, parentProfile = parent ? profileFor(parent.actor) : null; return `<article class="event ${e.actor_role}"><div class="event-avatar">${avatarContent(profile)}</div><div>${parent ? `<button class="reply-quote" data-jump="${parent.id}"><b>${escapeHtml(parentProfile.display_name || parent.actor)}</b><span>${escapeHtml(parent.summary)}</span></button>` : ""}<div class="event-head"><b>${escapeHtml(profile.display_name || e.actor)}</b><span class="role">${escapeHtml(e.actor_role)}</span><time>${relative(e.created_at)}</time><button class="reply-action" data-reply="${e.id}" title="Reply">↩ Reply</button></div><p class="event-summary">${escapeHtml(e.summary)}</p><div class="kind">${escapeHtml(e.kind)}${e.task_id ? ` · TASK #${e.task_id}` : ""}</div>${e.detail ? `<details class="context-card"><summary>Show action context</summary><pre>${escapeHtml(JSON.stringify(e.detail, null, 2))}</pre></details>` : ""}</div></article>`; }).join("");
  document.querySelectorAll("[data-reply]").forEach(button => button.onclick = () => setReply(events.find(event => event.id === Number(button.dataset.reply))));
  document.querySelectorAll("[data-jump]").forEach(button => button.onclick = () => { const target = document.querySelector(`[data-reply="${button.dataset.jump}"]`)?.closest(".event"); target?.scrollIntoView({ behavior: "smooth", block: "center" }); target?.classList.add("reply-flash"); setTimeout(() => target?.classList.remove("reply-flash"), 1400); });
  requestAnimationFrame(() => timeline.scrollTop = timeline.scrollHeight);
}

function setReply(event) { state.replyTo = event || null; $("#reply-target").classList.toggle("hidden", !event); if (event) { $("#reply-name").textContent = profileFor(event.actor).display_name || event.actor; $("#reply-summary").textContent = event.summary; $("#message").focus(); } }

function renderTasks(tasks) {
  const active = tasks.filter(t => !["done", "cancelled"].includes(t.status));
  $("#tasks").innerHTML = active.length ? active.map(t => { const agent = t.assignee ? profileFor(t.assignee) : null; return `<article class="task"><div class="task-top"><b>${escapeHtml(t.title)}</b><i class="priority ${t.priority}"></i></div>${t.description ? `<p>${escapeHtml(t.description)}</p>` : ""}${agent ? `<div class="task-agent"><span class="task-agent-avatar">${avatarContent(agent)}</span><div><b>${escapeHtml(agent.display_name || agent.name)}</b><small>${t.started_at ? `Working for ${elapsed(t.started_at)}` : "Assigned · not started"}</small></div></div>` : `<div class="task-agent unassigned-agent"><span>?</span><div><b>Unassigned</b><small>Waiting for an agent</small></div></div>`}<div class="task-meta"><span class="task-status">${escapeHtml(t.status.replace("_", " "))}</span><span>Task #${t.id}</span></div></article>`; }).join("") : `<p class="no-items">No active tasks. Clear runway.</p>`;
}
function renderClaims(claims) {
  $("#claim-count").textContent = `${claims.length} active`;
  $("#claims").innerHTML = claims.length ? claims.map(c => `<div class="claim"><i></i><div><b>${escapeHtml(c.resource)}</b><small>${escapeHtml(c.owner)} · ${escapeHtml(c.reason || "editing")}</small></div></div>`).join("") : `<p class="no-items">Nothing claimed right now.</p>`;
}

function connect() {
  state.ws?.close();
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/ws?token=${encodeURIComponent(state.token)}`); state.ws = ws;
  ws.onopen = () => { $("#connection").innerHTML = "<i></i> Connected"; };
  ws.onmessage = () => refresh().catch(console.error);
  ws.onclose = () => { $("#connection").textContent = "Reconnecting…"; setTimeout(connect, 2500); };
}

$("#login-form").onsubmit = async (event) => { event.preventDefault(); $("#login-error").textContent = ""; try { await login($("#token").value); } catch (error) { $("#login-error").textContent = error.message; } };
$("#composer").onsubmit = async (event) => { event.preventDefault(); const field = $("#message"), summary = field.value.trim(), parentId = state.replyTo?.id; if (!summary) return; field.value = ""; setReply(null); await api("/api/events", { method: "POST", body: JSON.stringify({ channel: state.channel, summary, kind: "message", parentId }) }); };
$("#message").onkeydown = event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#composer").requestSubmit(); } };
$("#cancel-reply").onclick = () => setReply(null);
$("#refresh").onclick = refresh;
$("#logout").onclick = () => { localStorage.removeItem("a2ac-token"); location.reload(); };
async function addProjectSpace() {
  const raw = prompt("Project space name (for example: dig-frenzy)");
  const name = raw?.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-").replace(/^-+|-+$/g, "");
  if (!name) return;
  state.channel = name;
  await api("/api/events", { method: "POST", body: JSON.stringify({ channel: name, kind: "project.created", summary: `Created project space #${name}` }) });
  await refresh();
}
$("#add-channel").onclick = addProjectSpace;
$("#add-project-space").onclick = addProjectSpace;
$("#close-context").onclick = () => $("#context-panel").classList.remove("open");
$("#new-task").onclick = () => $("#task-dialog").showModal();
$("#task-form").onsubmit = async event => { if (event.submitter?.value === "cancel") return; event.preventDefault(); await api("/api/tasks", { method: "POST", body: JSON.stringify({ title: $("#task-title").value, description: $("#task-description").value, priority: $("#task-priority").value }) }); $("#task-form").reset(); $("#task-dialog").close(); };

let pendingAvatar;
function openProfile(target = state.snapshot.me.name) {
  const allowed = state.snapshot.me.editableProfiles;
  if (!allowed.includes(target)) return;
  $("#profile-target").innerHTML = allowed.map(name => `<option value="${escapeHtml(name)}" ${name === target ? "selected" : ""}>${escapeHtml(profileFor(name).display_name || name)}${name === state.snapshot.me.name ? " (you)" : " (your agent)"}</option>`).join("");
  loadProfileEditor(target); $("#profile-dialog").showModal();
}
function loadProfileEditor(target) { const profile = profileFor(target); pendingAvatar = profile.avatar; $("#profile-name").value = profile.display_name || target; $("#profile-preview").innerHTML = avatarContent(profile); const agent = target.endsWith("-agent"); $("#profile-delegations").checked = Boolean(profile.accept_delegations); $("#profile-delegations").closest("label").classList.toggle("hidden", !agent); }
$("#profile-target").onchange = event => loadProfileEditor(event.target.value);
$("#self-avatar").onclick = () => openProfile();
$("#profile-avatar").onchange = event => { const file = event.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { const image = new Image(); image.onload = () => { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256; const context = canvas.getContext("2d"); const scale = Math.max(256 / image.width, 256 / image.height); const width = image.width * scale, height = image.height * scale; context.drawImage(image, (256-width)/2, (256-height)/2, width, height); pendingAvatar = canvas.toDataURL("image/webp", .82); $("#profile-preview").innerHTML = `<img src="${pendingAvatar}" alt="">`; }; image.src = reader.result; }; reader.readAsDataURL(file); };
$("#remove-avatar").onclick = () => { pendingAvatar = null; $("#profile-preview").textContent = initials($("#profile-name").value); };
$("#profile-form").onsubmit = async event => { event.preventDefault(); await api(`/api/profiles/${encodeURIComponent($("#profile-target").value)}`, { method: "PATCH", body: JSON.stringify({ displayName: $("#profile-name").value, avatar: pendingAvatar, acceptDelegations: $("#profile-delegations").checked }) }); $("#profile-dialog").close(); await refresh(); };
$("#workspace-settings").onclick = () => $("#workspace-dialog").showModal();
$("#copy-invite").onclick = async () => { await navigator.clipboard.writeText($("#invite-url").value); $("#copy-invite").textContent = "Copied"; setTimeout(() => $("#copy-invite").textContent = "Copy", 1200); };
document.querySelectorAll("[data-close]").forEach(button => button.onclick = () => $("#" + button.dataset.close).close());
setInterval(() => { if (state.snapshot) renderTasks(state.snapshot.tasks); }, 60_000);
if (state.token) login(state.token).catch(() => localStorage.removeItem("a2ac-token"));
