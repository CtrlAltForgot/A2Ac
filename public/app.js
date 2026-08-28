const $ = (selector) => document.querySelector(selector);
const state = { token: localStorage.getItem("a2ac-token") || "", channel: "general", channelKey: "", snapshot: null, ws: null, seen: {}, seenKey: "", channelOrder: [], channelOrderKey: "", draggedChannel: null, replyTo: null, mention: null, attachments: [], openContexts: new Set(), contextAutoOpen: false, contextAutoOpenAfter: 0 };

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
function formatMessage(value) {
  const profiles = [...(state.snapshot?.profiles || [])].sort((a, b) => b.display_name.length - a.display_name.length);
  const matches = [];
  for (const profile of profiles) {
    const needle = `@${profile.display_name}`.toLowerCase(); let from = 0;
    while (from < value.length) { const index = value.toLowerCase().indexOf(needle, from); if (index < 0) break; const end = index + needle.length, before = value[index - 1], after = value[end]; if ((!before || /\s|[(]/.test(before)) && (!after || /\s|[.,!?;:)]/.test(after))) matches.push({ index, end, profile }); from = end; }
  }
  matches.sort((a,b) => a.index-b.index || b.end-a.end); let cursor=0, html="";
  for (const match of matches) { if (match.index < cursor) continue; html += escapeHtml(value.slice(cursor,match.index)); html += `<button class="message-mention" data-mentioned="${escapeHtml(match.profile.name)}">@${escapeHtml(match.profile.display_name)}</button>`; cursor=match.end; }
  return html + escapeHtml(value.slice(cursor));
}
const humanLabel=value=>String(value).replace(/_/g," ").replace(/\b\w/g,letter=>letter.toUpperCase());
function contextValue(value,key="") {
  if(value===null||value===undefined)return "";
  if(Array.isArray(value)){if(!value.length)return "";return `<div class="context-list">${value.map((item,index)=>typeof item==="object"?`<div class="context-step"><i></i><div>${contextObject(item,`Step ${index+1}`)}</div></div>`:`<span class="context-chip">${escapeHtml(item)}</span>`).join("")}</div>`;}
  if(typeof value==="object")return contextObject(value);
  if(key==="command")return `<code class="context-command">${escapeHtml(value)}</code>`;
  return `<span>${escapeHtml(value)}</span>`;
}
function contextObject(object,title="") {
  const ignored=new Set(["expectedVersion","version","id","created_at","updated_at","started_at","created_by"]);
  const rows=Object.entries(object||{}).filter(([key,value])=>!ignored.has(key)&&value!==null&&value!==undefined&&value!=="");
  return `${title?`<b class="context-group-title">${escapeHtml(title)}</b>`:""}<div class="context-rows">${rows.map(([key,value])=>`<div class="context-row"><b>${escapeHtml(humanLabel(key))}</b><div>${contextValue(value,key)}</div></div>`).join("")}</div>`;
}
function actionContext(event){
  const detail=event.detail;if(!detail)return "";
  let title=humanLabel(event.kind.replace(/^action\./,"")),body;
  if(event.kind==="task.updated"&&detail.patch){title="Task update";body=contextObject(detail.patch);}
  else if(event.kind==="task.created"){title="Task created";body=contextObject(detail);}
  else body=contextObject(detail);
  const open=state.openContexts.has(event.id)||(state.contextAutoOpen&&event.id>state.contextAutoOpenAfter);
  return `<details class="context-card" data-context-id="${event.id}" ${open?"open":""}><summary><span class="context-spark">✣</span><b>${escapeHtml(title)}</b><small>${open?"Hide details":"Show details"}</small></summary><div class="context-body">${body||`<p>No additional details reported.</p>`}</div></details>`;
}
const isCoordinationNoise=event=>event.kind==="claim.acquired"||event.kind==="claim.released";
function compactTimeline(events){const items=[];for(let index=0;index<events.length;){if(!isCoordinationNoise(events[index])){items.push(events[index++]);continue;}const grouped=[];while(index<events.length&&isCoordinationNoise(events[index]))grouped.push(events[index++]);items.push({coordinationBundle:grouped});}return items;}
function coordinationBundle(events){return `<details class="coordination-bundle"><summary><span>↔</span><b>${events.length} resource coordination update${events.length===1?"":"s"}</b><small>Expand</small></summary><div>${events.map(event=>`<p><i class="${event.kind==="claim.acquired"?"acquired":"released"}"></i><b>${escapeHtml(profileFor(event.actor).display_name||event.actor)}</b><span>${escapeHtml(event.summary)}</span><time>${relative(event.created_at)}</time></p>`).join("")}</div></details>`;}

async function login(token) {
  state.token = token;
  const me = await api("/api/me");
  state.channelKey = `a2ac-active-channel-${me.name}`;
  const savedChannel = localStorage.getItem(state.channelKey);
  if (savedChannel && /^[a-z0-9][a-z0-9-_]{0,62}$/.test(savedChannel)) state.channel = savedChannel;
  localStorage.setItem("a2ac-token", token);
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  await refresh(); connect();
}

async function refresh() {
  state.snapshot = await api(`/api/snapshot?channel=${encodeURIComponent(state.channel)}`);
  if (!state.seenKey) {
    state.seenKey = `a2ac-seen-${state.snapshot.me.name}`;
    state.channelOrderKey = `a2ac-channel-order-${state.snapshot.me.name}`;
    try { state.seen = JSON.parse(localStorage.getItem(state.seenKey) || "{}"); } catch { state.seen = {}; }
    try { state.channelOrder = JSON.parse(localStorage.getItem(state.channelOrderKey) || "[]"); } catch { state.channelOrder = []; }
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
  $("#workspace-name").textContent=s.workspace?.name||"A2Ac Studio";
  $(".mini-logo").innerHTML='<img src="/assets/a2ac-logo.png" alt="A2Ac">';
  $("#workspace-icon").innerHTML=s.workspace?.icon?`<img src="${s.workspace.icon}" alt="">`:"◎";
  $("#self-avatar").innerHTML = avatarContent(s.me.profile);
  $("#channel-name").textContent = state.channel;
  $("#typing-hint").textContent = `Broadcast to both agents · no automatic wake-up`;
  const available = [...new Set(["general", ...s.channels.map(c => c.channel), state.channel])];
  const channels = [...state.channelOrder.filter(name=>available.includes(name)),...available.filter(name=>!state.channelOrder.includes(name))];
  state.channelOrder=channels;
  $("#channels").innerHTML = channels.map(name => { const info = s.channels.find(channel => channel.channel === name); const unread = name !== state.channel && Number(info?.last_event_id || 0) > Number(state.seen[name] || 0); return `<button draggable="true" class="channel ${name === state.channel ? "active" : ""}" data-channel="${escapeHtml(name)}"><span>#</span>${escapeHtml(name)}${unread ? `<i class="unread-blip" title="New activity"></i>` : ""}</button>`; }).join("");
  document.querySelectorAll("[data-channel]").forEach(el => el.onclick = async () => { state.channel = el.dataset.channel; if(state.channelKey)localStorage.setItem(state.channelKey,state.channel); await refresh(); });
  document.querySelectorAll("#channels [data-channel]").forEach(el=>{el.ondragstart=event=>{state.draggedChannel=el.dataset.channel;el.classList.add("dragging");event.dataTransfer.effectAllowed="move";};el.ondragend=()=>{state.draggedChannel=null;el.classList.remove("dragging");};el.ondragover=event=>{event.preventDefault();event.dataTransfer.dropEffect="move";};el.ondrop=event=>{event.preventDefault();const target=el.dataset.channel,source=state.draggedChannel;if(!source||source===target)return;const order=state.channelOrder.filter(name=>name!==source),index=order.indexOf(target);order.splice(index,0,source);state.channelOrder=order;localStorage.setItem(state.channelOrderKey,JSON.stringify(order));render();};});
  $("#online-count").textContent = s.presence.length;
  $("#presence").innerHTML = s.presence.map(p => { const editable = s.me.editableProfiles.includes(p.name), activity = p.current_task ? "working" : p.status; return `<button class="person ${editable ? "editable" : ""}" data-profile-name="${escapeHtml(p.name)}" ${editable ? `data-profile="${escapeHtml(p.name)}"` : "disabled"}><div class="person-avatar">${avatarContent(p)}<i></i></div><div><b>${escapeHtml(p.display_name || p.name)}</b><small>${escapeHtml(activity)} · #${escapeHtml(p.active_channel || "general")}</small></div></button>`; }).join("");
  document.querySelectorAll("[data-profile]").forEach(el => el.onclick = () => openProfile(el.dataset.profile));
  renderEvents(s.events); renderActivities(s.activities||[]); renderTeamTasks(s.tasks||[]); renderPins(s.pins||[]); renderClaims(s.claims);
}

function renderEvents(events) {
  const timeline = $("#timeline");
  if (!events.length) { timeline.innerHTML = `<div class="empty"><div><strong>#${escapeHtml(state.channel)} is ready</strong>Start a conversation with your humans and agents.</div></div>`; return; }
  const byId = new Map(events.map(event => [event.id, event]));
  const pinned=new Set((state.snapshot.pins||[]).map(pin=>Number(pin.event_id)));
  timeline.innerHTML = compactTimeline(events).map(item=>{if(item.coordinationBundle)return coordinationBundle(item.coordinationBundle);const e=item,profile=profileFor(e.actor),parent=e.parent_id?byId.get(e.parent_id):null,parentProfile=parent?profileFor(parent.actor):null,attachments=Array.isArray(e.detail?.attachments)?e.detail.attachments:[];return `<article class="event ${e.actor_role}"><div class="event-avatar">${avatarContent(profile)}</div><div>${parent ? `<button class="reply-quote" data-jump="${parent.id}"><b>${escapeHtml(parentProfile.display_name || parent.actor)}</b><span>${escapeHtml(parent.summary)}</span></button>` : ""}<div class="event-head"><b>${escapeHtml(profile.display_name || e.actor)}</b><span class="role">${escapeHtml(e.actor_role)}</span><time>${relative(e.created_at)}</time><button class="pin-action ${pinned.has(e.id)?"pinned":""}" data-pin="${e.id}" title="${pinned.has(e.id)?"Unpin":"Pin as project guidance"}">${pinned.has(e.id)?"◆":"◇"}</button><button class="reply-action" data-reply="${e.id}" title="Reply">↩ Reply</button></div><p class="event-summary">${formatMessage(e.summary)}</p>${attachments.length?`<div class="event-attachments">${attachments.map(a=>`<button data-load-attachment="${escapeHtml(a.id)}" data-mime="${escapeHtml(a.mime_type)}" data-filename="${escapeHtml(a.filename)}"><b>${escapeHtml(a.filename)}</b><small>${formatBytes(a.size)} · click to open</small></button>`).join("")}</div>`:""}<div class="kind">${escapeHtml(e.kind)}${e.task_id ? ` · TASK #${e.task_id}` : ""}</div>${actionContext(e)}</div></article>`;}).join("");
  document.querySelectorAll("[data-reply]").forEach(button => button.onclick = () => setReply(events.find(event => event.id === Number(button.dataset.reply))));
  document.querySelectorAll("[data-jump]").forEach(button => button.onclick = () => { const target = document.querySelector(`[data-reply="${button.dataset.jump}"]`)?.closest(".event"); target?.scrollIntoView({ behavior: "smooth", block: "center" }); target?.classList.add("reply-flash"); setTimeout(() => target?.classList.remove("reply-flash"), 1400); });
  document.querySelectorAll("[data-mentioned]").forEach(button => button.onclick = () => { const target = button.dataset.mentioned; if (state.snapshot.me.editableProfiles.includes(target)) openProfile(target); else { const member = state.snapshot.presence.find(person => person.name === target); const line = document.querySelector(`[data-profile-name="${CSS.escape(target)}"]`); line?.scrollIntoView({ behavior: "smooth", block: "nearest" }); button.title = `${profileFor(target).display_name} · ${member?.status || "offline"} · #${member?.active_channel || "general"}`; } });
  document.querySelectorAll("[data-load-attachment]").forEach(button => button.onclick = () => openAttachment(button));
  document.querySelectorAll("[data-pin]").forEach(button=>button.onclick=async()=>{const id=Number(button.dataset.pin),method=pinned.has(id)?"DELETE":"POST";await api(`/api/channels/${encodeURIComponent(state.channel)}/pins/${id}`,{method});await refresh();});
  document.querySelectorAll("[data-context-id]").forEach(details=>details.ontoggle=()=>{const id=Number(details.dataset.contextId),label=details.querySelector("summary small");label.textContent=details.open?"Hide details":"Show details";if(details.open){state.openContexts.add(id);state.contextAutoOpen=true;state.contextAutoOpenAfter=Math.max(...events.map(event=>Number(event.id)));}else{state.openContexts.delete(id);state.contextAutoOpen=false;}});
  requestAnimationFrame(() => timeline.scrollTop = timeline.scrollHeight);
}

function setReply(event) { state.replyTo = event || null; $("#reply-target").classList.toggle("hidden", !event); if (event) { $("#reply-name").textContent = profileFor(event.actor).display_name || event.actor; $("#reply-summary").textContent = event.summary; $("#message").focus(); } }

function renderActivities(activities) {
  $("#activity-count").textContent=`${activities.length} active`;
  $("#tasks").innerHTML=activities.length?activities.map(activity=>{const agent=profileFor(activity.agent),status=String(activity.status).replace("_"," "),timing=activity.status==="working"?`Working for ${elapsed(activity.started_at)}`:`${status} · updated ${elapsed(activity.updated_at)} ago`;return `<article class="task activity-card"><div class="task-top"><b>${escapeHtml(activity.title)}</b><i class="activity-dot status-${escapeHtml(activity.status)}"></i></div>${activity.description?`<p>${escapeHtml(activity.description)}</p>`:""}<div class="task-agent"><span class="task-agent-avatar">${avatarContent(agent)}</span><div><b>${escapeHtml(agent.display_name||agent.name)}</b><small class="status-${escapeHtml(activity.status)}">${escapeHtml(timing)}</small></div></div><div class="task-meta"><span class="task-status status-${escapeHtml(activity.status)}">${escapeHtml(status)}</span><span>#${escapeHtml(activity.channel)}</span></div></article>`;}).join(""):`<p class="no-items">No agents are actively working.</p>`;
}
function renderTeamTasks(tasks){const active=tasks.filter(task=>task.assignee==="team"&&!['done','cancelled'].includes(task.status));$("#team-tasks").innerHTML=active.length?active.map(task=>`<article class="team-task"><div><b>${escapeHtml(task.title)}</b><span class="task-status status-${escapeHtml(task.status)}">${escapeHtml(task.status.replace('_',' '))}</span></div>${task.description?`<p>${escapeHtml(task.description)}</p>`:""}<footer><span>${escapeHtml(task.priority)} · #${escapeHtml(task.channel||state.channel)}</span><button data-complete-team-task="${task.id}">Mark complete</button></footer></article>`).join(""):`<p class="no-items">No active team missions.</p>`;document.querySelectorAll("[data-complete-team-task]").forEach(button=>button.onclick=async()=>{await api(`/api/tasks/${button.dataset.completeTeamTask}`,{method:"PATCH",body:JSON.stringify({status:"done"})});await refresh();});}
function renderPins(pins){$("#pin-count").textContent=`${pins.length} pinned`;$("#pins").innerHTML=pins.length?pins.map(pin=>`<article class="pin"><b>${escapeHtml(pin.summary)}</b><small>${escapeHtml(profileFor(pin.actor).display_name||pin.actor)} · project instruction</small><button data-unpin="${pin.event_id}" title="Unpin">×</button></article>`).join(""):`<p class="no-items">No project guidance pinned.</p>`;document.querySelectorAll("[data-unpin]").forEach(button=>button.onclick=async()=>{await api(`/api/channels/${encodeURIComponent(state.channel)}/pins/${button.dataset.unpin}`,{method:"DELETE"});await refresh();});}
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
const composerText = () => $("#message").innerText.replace(/\u00a0/g," ").trim();
const formatBytes = size => size<1024?`${size} B`:size<1048576?`${(size/1024).toFixed(1)} KB`:`${(size/1048576).toFixed(1)} MB`;
async function uploadFiles(files){for(const file of files){const form=new FormData();form.append("file",file);const response=await fetch("/api/attachments",{method:"POST",headers:{authorization:`Bearer ${state.token}`},body:form});const body=await response.json().catch(()=>({}));if(!response.ok){alert(body.error||`Could not upload ${file.name}`);continue;}state.attachments.push(body);}renderAttachmentQueue();}
function renderAttachmentQueue(){const queue=$("#attachment-queue");queue.classList.toggle("hidden",!state.attachments.length);queue.innerHTML=state.attachments.map((a,i)=>`<div><span><b>${escapeHtml(a.filename)}</b><small>${formatBytes(a.size)}</small></span><button type="button" data-remove-attachment="${i}">×</button></div>`).join("");document.querySelectorAll("[data-remove-attachment]").forEach(button=>button.onclick=()=>{state.attachments.splice(Number(button.dataset.removeAttachment),1);renderAttachmentQueue();});}
async function openAttachment(button){if(button.dataset.loaded)return;button.dataset.loaded="1";button.querySelector("small").textContent="Loading…";try{const response=await fetch(`/api/attachments/${encodeURIComponent(button.dataset.loadAttachment)}`,{headers:{authorization:`Bearer ${state.token}`}});if(!response.ok)throw new Error("Download failed");const url=URL.createObjectURL(await response.blob()),mime=button.dataset.mime||"";let media;if(mime.startsWith("image/"))media=`<img src="${url}" alt="${escapeHtml(button.dataset.filename)}">`;else if(mime.startsWith("video/"))media=`<video src="${url}" controls></video>`;else if(mime.startsWith("audio/"))media=`<audio src="${url}" controls></audio>`;else{const link=document.createElement("a");link.href=url;link.download=button.dataset.filename;link.click();button.querySelector("small").textContent="Downloaded";return;}button.outerHTML=`<div class="attachment-media">${media}<small>${escapeHtml(button.dataset.filename)}</small></div>`;}catch(error){button.dataset.loaded="";button.querySelector("small").textContent=error.message;}}
$("#kind-button").onclick=()=>$("#attachment-input").click();
$("#attachment-input").onchange=event=>{uploadFiles([...event.target.files]);event.target.value="";};
for(const target of [$("#timeline"),$("#composer")]){for(const type of ["dragenter","dragover"])target.addEventListener(type,event=>{event.preventDefault();$("#composer").classList.add("drop-active")});for(const type of ["dragleave","drop"])target.addEventListener(type,event=>{event.preventDefault();$("#composer").classList.remove("drop-active")});target.addEventListener("drop",event=>uploadFiles([...event.dataTransfer.files]));}
$("#composer").onsubmit = async (event) => { event.preventDefault(); const field = $("#message"), summary = composerText(), parentId = state.replyTo?.id; if (!summary&&!state.attachments.length) return; const attachments=state.attachments.map(({id,filename,mime_type,size})=>({id,filename,mime_type,size})); await api("/api/events", { method: "POST", body: JSON.stringify({ channel: state.channel, summary:summary||`Shared ${attachments.length} file${attachments.length===1?"":"s"}`, kind: "message", parentId, detail:attachments.length?{attachments}:undefined }) }); field.innerHTML = ""; state.attachments=[]; renderAttachmentQueue(); closeMentionMenu(); setReply(null); };
function updateMentionMenu() {
  const field = $("#message"), selection = getSelection();
  if (!selection?.rangeCount || !field.contains(selection.anchorNode)) return closeMentionMenu();
  const caret = selection.getRangeAt(0), prefix = caret.cloneRange(); prefix.selectNodeContents(field); prefix.setEnd(caret.endContainer,caret.endOffset);
  const before = prefix.toString(), match = before.match(/(?:^|\s)@([^@\n]*)$/);
  if (!match) return closeMentionMenu();
  const query = match[1].trim().toLowerCase(), start = before.length - match[1].length - 1;
  const profiles = (state.snapshot?.profiles || []).filter(profile => !query || profile.display_name.toLowerCase().includes(query)).slice(0,8);
  if (!profiles.length) return closeMentionMenu();
  state.mention = { start, end: before.length, profiles, index: Math.min(state.mention?.index || 0, profiles.length-1) };
  $("#mention-query").textContent = `@${match[1]}`; $("#mention-menu").classList.remove("hidden");
  $("#mention-results").innerHTML = profiles.map((profile,index) => { const presence=state.snapshot.presence.find(person=>person.name===profile.name); return `<button type="button" class="mention-option ${index===state.mention.index?"active":""}" data-mention-index="${index}"><span class="person-avatar">${avatarContent(profile)}</span><span><b>${escapeHtml(profile.display_name)}</b><small>${escapeHtml(presence?.role || (profile.name.endsWith("-agent")?"agent":"member"))} · #${escapeHtml(presence?.active_channel || profile.active_channel || "general")}</small></span></button>`; }).join("");
  document.querySelectorAll("[data-mention-index]").forEach(button => { button.onmousedown = event => { event.preventDefault(); chooseMention(Number(button.dataset.mentionIndex)); }; });
}
function closeMentionMenu(){ state.mention=null; $("#mention-menu").classList.add("hidden"); }
function textPoint(root, targetOffset){ const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT); let offset=0,node; while((node=walker.nextNode())){const next=offset+node.data.length;if(targetOffset<=next)return{node,offset:targetOffset-offset};offset=next;}return{node:root,offset:root.childNodes.length}; }
function chooseMention(index=state.mention?.index||0){ if(!state.mention)return; const field=$("#message"), profile=state.mention.profiles[index], start=textPoint(field,state.mention.start), end=textPoint(field,state.mention.end), range=document.createRange(); range.setStart(start.node,start.offset);range.setEnd(end.node,end.offset);range.deleteContents(); const token=document.createElement("span");token.className="composer-mention";token.contentEditable="false";token.dataset.name=profile.name;token.textContent=`@${profile.display_name}`;const space=document.createTextNode("\u00a0");range.insertNode(space);range.insertNode(token);range.setStartAfter(space);range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);closeMentionMenu();field.focus(); }
$("#message").oninput = updateMentionMenu;
$("#message").onkeydown = event => { if(state.mention){ if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault(); state.mention.index=(state.mention.index+(event.key==="ArrowDown"?1:-1)+state.mention.profiles.length)%state.mention.profiles.length; updateMentionMenu(); return;} if(event.key==="Tab"||event.key==="Enter"){event.preventDefault();chooseMention();return;} if(event.key==="Escape"){event.preventDefault();closeMentionMenu();return;} } if(event.key==="Backspace"){const selection=getSelection();if(selection?.isCollapsed){const range=selection.getRangeAt(0);if(range.startContainer.nodeType===Node.TEXT_NODE&&range.startOffset===1&&range.startContainer.textContent==="\u00a0"&&range.startContainer.previousSibling?.classList?.contains("composer-mention")){event.preventDefault();range.startContainer.previousSibling.remove();range.startContainer.remove();return;}}} if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#composer").requestSubmit(); } };
$("#cancel-reply").onclick = () => setReply(null);
$("#refresh").onclick = refresh;
$("#logout").onclick = () => { localStorage.removeItem("a2ac-token"); location.reload(); };
async function addProjectSpace() {
  const raw = prompt("Project space name (for example: dig-frenzy)");
  const name = raw?.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-").replace(/^-+|-+$/g, "");
  if (!name) return;
  state.channel = name;
  if(state.channelKey)localStorage.setItem(state.channelKey,state.channel);
  await api("/api/events", { method: "POST", body: JSON.stringify({ channel: name, kind: "project.created", summary: `Created project space #${name}` }) });
  await refresh();
}
$("#add-channel").onclick = addProjectSpace;
$("#add-project-space").onclick = addProjectSpace;
$("#close-context").onclick = () => $("#context-panel").classList.remove("open");
$("#new-team-task").onclick=()=>$("#task-dialog").showModal();
$("#task-form").onsubmit = async event => { event.preventDefault(); await api("/api/tasks", { method: "POST", body: JSON.stringify({ title: $("#task-title").value, description: $("#task-description").value, priority: $("#task-priority").value,assignee:"team",channel:state.channel,wakeModels:$("#task-wake-models").checked }) }); $("#task-form").reset(); $("#task-dialog").close(); };

let pendingAvatar;
function openProfile(target = state.snapshot.me.name) {
  const allowed = state.snapshot.me.editableProfiles;
  if (!allowed.includes(target)) return;
  $("#profile-target").innerHTML = allowed.map(name => `<option value="${escapeHtml(name)}" ${name === target ? "selected" : ""}>${escapeHtml(profileFor(name).display_name || name)}${name === state.snapshot.me.name ? " (you)" : " (your agent)"}</option>`).join("");
  loadProfileEditor(target); $("#profile-dialog").showModal();
}
function loadProfileEditor(target) { const profile = profileFor(target); pendingAvatar = profile.avatar; $("#profile-name").value = profile.display_name || target; $("#profile-preview").innerHTML = avatarContent(profile); const agent = target.endsWith("-agent"); $("#profile-delegations").checked = Boolean(profile.accept_delegations); $("#profile-ambient-chat").checked=Boolean(profile.ambient_chat); for(const id of ["#profile-delegations","#profile-ambient-chat"])$(id).closest("label").classList.toggle("hidden",!agent); }
$("#profile-target").onchange = event => loadProfileEditor(event.target.value);
$("#self-avatar").onclick = () => openProfile();
$("#profile-avatar").onchange = event => { const file = event.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { const image = new Image(); image.onload = () => { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256; const context = canvas.getContext("2d"); const scale = Math.max(256 / image.width, 256 / image.height); const width = image.width * scale, height = image.height * scale; context.drawImage(image, (256-width)/2, (256-height)/2, width, height); pendingAvatar = canvas.toDataURL("image/webp", .82); $("#profile-preview").innerHTML = `<img src="${pendingAvatar}" alt="">`; }; image.src = reader.result; }; reader.readAsDataURL(file); };
$("#remove-avatar").onclick = () => { pendingAvatar = null; $("#profile-preview").textContent = initials($("#profile-name").value); };
$("#profile-form").onsubmit = async event => { event.preventDefault(); await api(`/api/profiles/${encodeURIComponent($("#profile-target").value)}`, { method: "PATCH", body: JSON.stringify({ displayName: $("#profile-name").value, avatar: pendingAvatar, acceptDelegations: $("#profile-delegations").checked,ambientChat:$("#profile-ambient-chat").checked }) }); $("#profile-dialog").close(); await refresh(); };
let pendingWorkspaceIcon;
let roleSettings;
$("#workspace-settings").onclick = async () => {const workspace=state.snapshot.workspace||{name:"A2Ac Studio",icon:null};$("#workspace-name-input").value=workspace.name;pendingWorkspaceIcon=workspace.icon;$("#workspace-preview").innerHTML=workspace.icon?`<img src="${workspace.icon}" alt="">`:"A²";$("#workspace-dialog").showModal();roleSettings=await api("/api/roles");renderRoleSettings();};
document.querySelectorAll("[data-settings-tab]").forEach(button=>button.onclick=()=>{document.querySelectorAll("[data-settings-tab]").forEach(item=>item.classList.toggle("active",item===button));document.querySelectorAll("[data-settings-page]").forEach(page=>page.classList.toggle("hidden",page.dataset.settingsPage!==button.dataset.settingsTab));});
const permissionLabels={delegate_agents:"Invoke other users’ agents",pin_messages:"Pin project guidance",create_tasks:"Create shared goals",upload_files:"Upload files",manage_channels:"Create project channels"};
function renderRoleSettings(){if(!roleSettings)return;const assignmentMap=Object.fromEntries(roleSettings.assignments.map(item=>[item.user_name,item.role_id]));$("#role-list").innerHTML=roleSettings.roles.map(role=>`<article class="role-card" data-role-card="${escapeHtml(role.id)}"><div class="role-card-head"><input value="${escapeHtml(role.name)}" maxlength="40"><button type="button" data-save-role="${escapeHtml(role.id)}">Save</button></div><div class="permission-grid">${roleSettings.permissions.map(permission=>`<label><input type="checkbox" value="${permission}" ${role.permissions.includes(permission)?"checked":""}>${escapeHtml(permissionLabels[permission]||permission)}</label>`).join("")}</div></article>`).join("");$("#role-assignments").innerHTML=roleSettings.users.map(user=>`<div class="role-assignment"><div><b>${escapeHtml(user.displayName)}</b><small>${escapeHtml(user.name)}${user.name==="owner"?" · owner":""}</small></div><select data-assign-user="${escapeHtml(user.name)}" ${user.name==="owner"?"disabled":""}>${roleSettings.roles.map(role=>`<option value="${escapeHtml(role.id)}" ${(assignmentMap[user.name]||"member")===role.id?"selected":""}>${escapeHtml(role.name)}</option>`).join("")}</select></div>`).join("");document.querySelectorAll("[data-save-role]").forEach(button=>button.onclick=async()=>{const card=button.closest("[data-role-card]"),permissions=[...card.querySelectorAll('input[type="checkbox"]:checked')].map(input=>input.value);await api(`/api/roles/${encodeURIComponent(button.dataset.saveRole)}`,{method:"PUT",body:JSON.stringify({name:card.querySelector('input[type="text"],input:not([type])').value,permissions})});roleSettings=await api("/api/roles");renderRoleSettings();});document.querySelectorAll("[data-assign-user]").forEach(select=>select.onchange=async()=>{await api(`/api/users/${encodeURIComponent(select.dataset.assignUser)}/role`,{method:"PUT",body:JSON.stringify({roleId:select.value})});roleSettings=await api("/api/roles");renderRoleSettings();});}
$("#add-role").onclick=async()=>{const name=prompt("New role name");if(!name?.trim())return;const id=name.trim().toLowerCase().replace(/[^a-z0-9-_]/g,"-").replace(/^-+|-+$/g,"");await api(`/api/roles/${encodeURIComponent(id)}`,{method:"PUT",body:JSON.stringify({name:name.trim(),permissions:[]})});roleSettings=await api("/api/roles");renderRoleSettings();};
$("#workspace-icon-input").onchange=event=>{const file=event.target.files[0];if(!file)return;const reader=new FileReader();reader.onload=()=>{const image=new Image();image.onload=()=>{const canvas=document.createElement("canvas");canvas.width=canvas.height=256;const context=canvas.getContext("2d"),scale=Math.max(256/image.width,256/image.height),w=image.width*scale,h=image.height*scale;context.drawImage(image,(256-w)/2,(256-h)/2,w,h);pendingWorkspaceIcon=canvas.toDataURL("image/webp",.82);$("#workspace-preview").innerHTML=`<img src="${pendingWorkspaceIcon}" alt="">`;};image.src=reader.result;};reader.readAsDataURL(file);};
$("#remove-workspace-icon").onclick=()=>{pendingWorkspaceIcon=null;$("#workspace-preview").textContent="A²";};
$("#workspace-form").onsubmit=async event=>{event.preventDefault();await api("/api/workspace",{method:"PATCH",body:JSON.stringify({name:$("#workspace-name-input").value,icon:pendingWorkspaceIcon})});$("#workspace-dialog").close();await refresh();};
$("#copy-invite").onclick = async () => { await navigator.clipboard.writeText($("#invite-url").value); $("#copy-invite").textContent = "Copied"; setTimeout(() => $("#copy-invite").textContent = "Copy", 1200); };
document.querySelectorAll("[data-close]").forEach(button => button.onclick = () => $("#" + button.dataset.close).close());
setInterval(() => { if (state.snapshot && !document.hidden) refresh().catch(console.error); }, 30_000);
if (state.token) login(state.token).catch(() => localStorage.removeItem("a2ac-token"));
