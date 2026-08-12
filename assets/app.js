const state = { session: null, hostStatus: null, terminals: new Map(), activeTerminal: null, forceNewTerminal: false, pollTimer: null, monitorTimer: null, monitoringPaused: false, eventSources: new Map(), fileEditorPath: null, fileEditorKind: null, selectedFilePath: null, selectedFileType: null, selectedFileSize: 0, currentDirectory: ".", fileTreeCache: new Map(), openDirectories: new Set(["."]), fileViewMode: "preview", workspaceView: "overview", commandSubmitting: false, commandHistory: [], historyCursor: -1, terminalLabels: new Map(), transfers: new Map(), remoteTransfers: [], transferActiveCount: 0, transferPanelClosed: true, transferPanelMinimized: false, taskMode: "active", taskActive: [], taskHistory: [], taskHistoryCursor: null, taskCapabilities: null, taskStorage: null, selectedTaskId: null, selectedTask: null, taskLoaded: false, taskLoading: false, taskStatusLoading: false, taskStatusTimer: null, taskStatusError: null, taskObservedAt: null, taskLogLoading: false, taskLogOffset: 0, taskLogTimer: null };
const $ = (selector) => document.querySelector(selector);
const PROFILE_STORAGE_KEY = "remote-control-bridge.connection-profiles.v1";
const ACTIVE_SESSION_STORAGE_KEY = "remote-control-bridge.active-session.v1";
const TERMINAL_LABEL_STORAGE_KEY = "remote-control-bridge.terminal-labels.v1";
const MAX_INLINE_TEXT_PREVIEW_BYTES = 256 * 1024;
const MAX_INLINE_IMAGE_PREVIEW_BYTES = 16 * 1024 * 1024;
const BINARY_PREVIEW_PATTERN = /\.(?:7z|arrow|bin|bz2|class|ckpt|db|dll|docx?|dylib|exe|feather|gz|h5|hdf5|iso|jar|joblib|model|npy|npz|onnx|parquet|pb|pdf|pickle|pkl|pt|pth|rar|safetensors|so|sqlite|tar|tgz|war|weights|xlsx?|xz|zip)$/i;

async function request(path, options) {
  let response;
  try { response = await fetch(path, options); }
  catch (cause) {
    const error = new Error("无法连接本地 Bridge。请确认页面来自 http://127.0.0.1:8877/，且 Bridge 服务仍在运行。");
    error.cause = cause; throw error;
  }
  let body;
  try { body = await response.json(); }
  catch (cause) { const error = new Error("本地 Bridge 返回了无效响应。"); error.cause = cause; throw error; }
  if (!response.ok) { const error = new Error(body.error || `Request failed (${response.status})`); error.payload = body; error.status = response.status; throw error; }
  return body;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function showNotice(message) { $("#notice").textContent = message; }
function formatUptime(seconds) {
  if (!Number.isFinite(Number(seconds))) return "未知";
  const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${minutes} 分`;
}
function formatGiB(kib) { return Number.isFinite(Number(kib)) ? `${(Number(kib) / 1048576).toFixed(1)} GiB` : "未知"; }
function percent(value) { const number = Number(String(value ?? "0").replace("%", "")); return Math.max(0, Math.min(100, Number.isFinite(number) ? number : 0)); }
function readActiveSession() { try { return JSON.parse(sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) || "null"); } catch { return null; } }
function saveActiveSession(agentEnabled = $("#agentEnabled")?.checked || false) { try { if (state.session) sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify({ session: state.session, agentEnabled: Boolean(agentEnabled) })); } catch {} }
function forgetActiveSession() { try { sessionStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY); } catch {} }
function loadTerminalLabels() { state.terminalLabels.clear(); try { const all = JSON.parse(sessionStorage.getItem(TERMINAL_LABEL_STORAGE_KEY) || "{}"); const labels = all?.[state.session] || {}; for (const [idValue, label] of Object.entries(labels)) if (typeof label === "string" && label.trim()) state.terminalLabels.set(idValue, label.trim().slice(0, 40)); } catch {} }
function saveTerminalLabels() { try { const all = JSON.parse(sessionStorage.getItem(TERMINAL_LABEL_STORAGE_KEY) || "{}"); all[state.session] = Object.fromEntries(state.terminalLabels); sessionStorage.setItem(TERMINAL_LABEL_STORAGE_KEY, JSON.stringify(all)); } catch {} }
function terminalLabel(terminal) { return state.terminalLabels.get(terminal.terminal_id) || `终端 ${terminal.index}`; }

function connected(enabled) {
  for (const id of ["refresh", "disconnect", "logPath", "readLog", "commandInput", "runCommand", "commandTimeout", "newTerminal", "renameTerminal", "listFiles", "parentFolder", "newFolder", "transferFileInput", "transferFolderInput", "chooseTransferFiles", "chooseTransferFolder", "refreshTransfers", "refreshInterval", "pauseMonitoring", "refreshTasks"]) $("#" + id).disabled = !enabled;
  for (const id of ["workspaceTabTerminal", "workspaceTabTasks", "workspaceTabFiles", "workspaceTabLogs"]) $("#" + id).disabled = !enabled;
  for (const id of ["connect", "host", "port", "username", "password", "authMethod", "savedProfile", "deleteProfile", "saveProfile"]) $("#" + id).disabled = enabled;
  $("#workspace").classList.toggle("is-connected", enabled);
  updateFileActionState();
  if (!enabled) setWorkspaceView("overview");
  if (!enabled) { $("#pauseMonitoring").textContent = "暂停监控"; $("#lastRefresh").textContent = "尚未采集"; }
}

function setWorkspaceView(view) {
  const allowed = new Set(["overview", "terminal", "tasks", "files", "logs"]);
  const next = allowed.has(view) && (view === "overview" || state.session) ? view : "overview";
  state.workspaceView = next; $("#workspace").dataset.view = next;
  for (const tab of document.querySelectorAll(".workspace-tab")) {
    const active = tab.dataset.view === next;
    tab.classList.toggle("active", active); tab.setAttribute("aria-selected", String(active));
  }
  if (next === "terminal") setTimeout(() => $("#commandInput")?.focus(), 0);
  if (next === "overview" && state.session) void refresh({ silent: true });
  if (next === "tasks") { refreshTaskCenter({ resetHistory: !state.taskLoaded }); scheduleTaskStatusPolling(); scheduleTaskLogPolling(); }
  else { clearTimeout(state.taskStatusTimer); state.taskStatusTimer = null; clearTimeout(state.taskLogTimer); state.taskLogTimer = null; }
}

function clearSessionState() {
  clearTimeout(state.pollTimer);
  clearTimeout(state.monitorTimer);
  for (const source of state.eventSources.values()) source.close();
  for (const item of state.transfers.values()) { try { item.upload?.abort(false); } catch {} }
  state.eventSources.clear(); state.session = null; state.hostStatus = null; state.terminals.clear(); state.activeTerminal = null; state.fileTreeCache.clear(); state.openDirectories = new Set(["."]); state.currentDirectory = "."; state.fileEditorPath = null; state.fileEditorKind = null; state.selectedFilePath = null; state.selectedFileType = null; state.selectedFileSize = 0; state.commandSubmitting = false; state.commandHistory = []; state.historyCursor = -1; state.terminalLabels.clear(); state.transfers.clear(); state.remoteTransfers = []; state.transferActiveCount = 0; state.transferPanelClosed = true; state.transferPanelMinimized = false;
  resetTaskState();
  clearFileEditor(); updateCurrentDirectory();
  renderTransferQueue();
  forgetActiveSession();
  connected(false); $("#agentEnabled").checked = true; $("#agentEnabled").disabled = false; $("#stopCommand").disabled = true;
}

function renderStatusLegacy(data) {
  $("#hostTitle").textContent = `${data.username}@${data.host}`;
  $("#hostMeta").textContent = `SSH · ${data.host}:${data.port} · ${data.workdir}`;
  const disk = typeof data.root_disk === "object" ? data.root_disk : {};
  const diskPercent = percent(disk.used_percent);
  const cpu = typeof data.cpu === "object" ? data.cpu : {};
  const memory = typeof data.memory === "object" ? data.memory : {};
  const cpuUsage = Number.isFinite(Number(cpu.usage_percent)) ? `${Number(cpu.usage_percent).toFixed(1)}%` : "未知";
  const memoryUsage = Number.isFinite(Number(memory.used_percent)) ? `${Number(memory.used_percent).toFixed(1)}%` : "未知";
  const memorySummary = Number.isFinite(Number(memory.used_kib)) && Number.isFinite(Number(memory.total_kib)) ? `${formatGiB(memory.used_kib)} / ${formatGiB(memory.total_kib)}` : "未知";
  const gpuHtml = (data.gpus || []).length ? data.gpus.map((gpu) => {
    const memoryPercent = Number(gpu.memory_total_mib) ? percent(Number(gpu.memory_used_mib) * 100 / Number(gpu.memory_total_mib)) : 0;
    const utilization = percent(gpu.utilization_percent);
    return `<article class="gpu-panel"><div class="gpu-heading"><strong>GPU ${escapeHtml(gpu.index)}</strong><span>${escapeHtml(gpu.name)}</span></div><div class="gauge-row"><span>利用率</span><div class="bar"><i style="width:${utilization}%"></i></div><b>${utilization}%</b></div><div class="gauge-row"><span>显存</span><div class="bar memory"><i style="width:${memoryPercent}%"></i></div><b>${escapeHtml(gpu.memory_used_mib)} / ${escapeHtml(gpu.memory_total_mib)} MiB</b></div><div class="gpu-temp">${escapeHtml(gpu.temperature_c)} °C</div></article>`;
  }).join("") : `<div class="empty-state">未检测到 NVIDIA GPU</div>`;
  $("#dashboard").innerHTML = `<div class="metric-grid"><div class="metric"><span>主机名</span><strong>${escapeHtml(data.hostname)}</strong></div><div class="metric"><span>在线时间</span><strong>${escapeHtml(formatUptime(data.uptime_seconds))}</strong></div><div class="metric"><span>系统负载</span><strong>${escapeHtml(data.load_average || "未知")}</strong></div><div class="metric"><span>用户主目录</span><strong>${escapeHtml(data.workdir)}</strong></div></div><section class="disk-panel"><div><span>根分区</span><strong>${formatGiB(disk.used_kib)} / ${formatGiB(disk.total_kib)}</strong></div><div class="bar disk"><i style="width:${diskPercent}%"></i></div><small>${diskPercent}% 已使用 · ${formatGiB(disk.available_kib)} 可用</small></section><section class="gpu-grid">${gpuHtml}</section>`;
  showNotice(`状态更新于 ${new Date().toLocaleTimeString()}`);
}

/* Compact resource view retained for compatibility with older cached pages. */
function renderStatusCompact(data) {
  $("#hostTitle").textContent = `${data.username}@${data.host}`;
  $("#hostMeta").textContent = `SSH · ${data.host}:${data.port} · ${data.workdir}`;
  const disk = typeof data.root_disk === "object" ? data.root_disk : {};
  const diskPercent = percent(disk.used_percent);
  const cpu = typeof data.cpu === "object" ? data.cpu : {};
  const memory = typeof data.memory === "object" ? data.memory : {};
  const cpuUsage = Number.isFinite(Number(cpu.usage_percent)) ? `${Number(cpu.usage_percent).toFixed(1)}%` : "未知";
  const memoryUsage = Number.isFinite(Number(memory.used_percent)) ? `${Number(memory.used_percent).toFixed(1)}%` : "未知";
  const memorySummary = Number.isFinite(Number(memory.used_kib)) && Number.isFinite(Number(memory.total_kib)) ? `${formatGiB(memory.used_kib)} / ${formatGiB(memory.total_kib)}` : "未知";
  const gpus = Array.isArray(data.gpus) ? data.gpus : [];
  const gpuHtml = gpus.length ? gpus.map((gpu) => {
    const memoryPercent = Number(gpu.memory_total_mib) ? percent(Number(gpu.memory_used_mib) * 100 / Number(gpu.memory_total_mib)) : 0;
    const utilization = percent(gpu.utilization_percent);
    return `<article class="gpu-panel"><div class="gpu-heading"><strong>GPU ${escapeHtml(gpu.index)}</strong><span>${escapeHtml(gpu.name)}</span></div><div class="gpu-temp">${escapeHtml(gpu.temperature_c)} °C</div><div class="gauge-row"><span>利用率</span><div class="bar"><i style="width:${utilization}%"></i></div><b>${utilization}%</b></div><div class="gauge-row"><span>显存</span><div class="bar memory"><i style="width:${memoryPercent}%"></i></div><b>${escapeHtml(gpu.memory_used_mib)} / ${escapeHtml(gpu.memory_total_mib)} MiB</b></div></article>`;
  }).join("") : `<div class="empty-state">未检测到 NVIDIA GPU</div>`;
  const gpuBusy = gpus.filter((gpu) => percent(gpu.utilization_percent) > 0).length;
  $("#dashboard").innerHTML = `<div class="metric-grid"><div class="metric"><span>主机名</span><strong>${escapeHtml(data.hostname)}</strong></div><div class="metric"><span>在线时间</span><strong>${escapeHtml(formatUptime(data.uptime_seconds))}</strong></div><div class="metric"><span>CPU 使用率</span><strong>${cpuUsage}${cpu.cores ? ` · ${escapeHtml(cpu.cores)} 核` : ""}</strong></div><div class="metric"><span>内存使用率</span><strong>${memoryUsage}</strong><small>${memorySummary}</small></div><div class="metric"><span>系统负载</span><strong>${escapeHtml(data.load_average || "未知")}</strong></div><div class="metric"><span>用户主目录</span><strong>${escapeHtml(data.workdir)}</strong></div></div><div class="resource-grid"><section class="disk-panel"><div class="resource-heading"><div><span>根分区</span><strong>${formatGiB(disk.used_kib)} / ${formatGiB(disk.total_kib)}</strong></div><span class="resource-status">${diskPercent}% 已用</span></div><div class="bar disk"><i style="width:${diskPercent}%"></i></div><small>${formatGiB(disk.available_kib)} 可用空间</small></section><section class="gpu-panel-group"><div class="resource-heading"><div><span>GPU 资源</span><strong>${gpus.length ? `${gpus.length} 张设备` : "未检测到设备"}</strong></div><span class="resource-status">${gpuBusy ? `${gpuBusy} 张工作中` : "空闲"}</span></div><div class="gpu-grid">${gpuHtml}</div></section></div>`;
  showNotice(`状态更新于 ${new Date().toLocaleTimeString()}`);
}

function renderStatus(data) {
  state.hostStatus = data;
  $("#hostTitle").textContent = `${data.username}@${data.host}`;
  $("#hostMeta").textContent = `SSH · ${data.host}:${data.port} · ${data.workdir}`;
  const disk = typeof data.root_disk === "object" ? data.root_disk : {};
  const cpu = typeof data.cpu === "object" ? data.cpu : {};
  const memory = typeof data.memory === "object" ? data.memory : {};
  const diskPercent = percent(disk.used_percent);
  const cpuPercent = percent(cpu.usage_percent);
  const memoryPercent = percent(memory.used_percent);
  const gpus = Array.isArray(data.gpus) ? data.gpus : [];
  const memoryDetail = Number.isFinite(Number(memory.used_kib)) && Number.isFinite(Number(memory.total_kib)) ? `${formatGiB(memory.used_kib)} 已用 · ${formatGiB(memory.available_kib)} 可用` : "等待数据";
  const diskDetail = Number.isFinite(Number(disk.used_kib)) && Number.isFinite(Number(disk.total_kib)) ? `${formatGiB(disk.used_kib)} / ${formatGiB(disk.total_kib)}` : "等待数据";
  const gpuUsed = gpus.reduce((sum, gpu) => sum + (Number(gpu.memory_used_mib) || 0), 0);
  const gpuTotal = gpus.reduce((sum, gpu) => sum + (Number(gpu.memory_total_mib) || 0), 0);
  const gauge = (label, value, detail, tone) => `<article class="gauge-card"><div class="dial" style="--value:${value};--gauge-color:${tone}"><div class="dial-inner"><strong>${value}%</strong><span>实时</span></div></div><div class="gauge-copy"><span>${label}</span><strong>${detail}</strong></div></article>`;
  const gpuHtml = gpus.length ? gpus.map((gpu) => {
    const utilization = percent(gpu.utilization_percent);
    const gpuMemory = Number(gpu.memory_total_mib) ? percent(Number(gpu.memory_used_mib) * 100 / Number(gpu.memory_total_mib)) : 0;
    return `<article class="gpu-panel"><div class="gpu-heading"><strong>GPU ${escapeHtml(gpu.index)}</strong><span>${escapeHtml(gpu.name)}</span></div><div class="gpu-temp">${escapeHtml(gpu.temperature_c)} °C</div><div class="gauge-row"><span>利用率</span><div class="bar"><i style="width:${utilization}%"></i></div><b>${utilization}%</b></div><div class="gauge-row"><span>显存</span><div class="bar memory"><i style="width:${gpuMemory}%"></i></div><b>${escapeHtml(gpu.memory_used_mib)} / ${escapeHtml(gpu.memory_total_mib)} MiB</b></div></article>`;
  }).join("") : `<div class="empty-state">未检测到 NVIDIA GPU</div>`;
  const loads = String(data.load_average || "0 0 0").split(/\s+/).slice(0, 3).map(Number).map((value) => Number.isFinite(value) ? value : 0);
  const loadMax = Math.max(1, ...loads);
  const loadHtml = loads.map((value, index) => `<div class="load-meter"><span>${index === 0 ? "1 分钟" : index === 1 ? "5 分钟" : "15 分钟"}</span><div class="bar"><i style="width:${Math.min(100, value * 100 / loadMax)}%"></i></div><b>${value.toFixed(2)}</b></div>`).join("");
  $("#dashboard").innerHTML = `<div class="metric-grid"><div class="metric"><span>主机名</span><strong>${escapeHtml(data.hostname)}</strong></div><div class="metric"><span>在线时间</span><strong>${escapeHtml(formatUptime(data.uptime_seconds))}</strong></div><div class="metric"><span>处理器</span><strong>${cpu.cores ? `${escapeHtml(cpu.cores)} 核` : "未知"}</strong></div><div class="metric"><span>内存总量</span><strong>${Number.isFinite(Number(memory.total_kib)) ? formatGiB(memory.total_kib) : "未知"}</strong></div><div class="metric"><span>系统负载</span><strong>${escapeHtml(data.load_average || "未知")}</strong></div><div class="metric"><span>用户主目录</span><strong>${escapeHtml(data.workdir)}</strong></div></div><div class="status-dashboard"><section class="gauge-board"><div class="dashboard-heading"><div><span class="eyebrow">SYSTEM HEALTH</span><h2>系统资源</h2></div><span class="dashboard-caption">实时采样</span></div><div class="gauge-cards">${gauge("CPU 使用率", cpuPercent, cpu.cores ? `${cpu.cores} 核处理器` : "等待数据", "#177a70")}${gauge("内存使用率", memoryPercent, memoryDetail, "#467e9d")}${gauge("根分区使用率", diskPercent, diskDetail, "#b5782b")}</div><div class="load-panel"><div class="load-title"><strong>系统负载</strong><span>${escapeHtml(data.load_average || "未知")}</span></div>${loadHtml}</div></section><section class="gpu-panel-group"><div class="dashboard-heading"><div><span class="eyebrow">ACCELERATOR</span><h2>GPU 资源</h2></div><span class="dashboard-caption">${gpus.length ? `${gpus.length} 张设备 · ${gpuUsed} / ${gpuTotal} MiB 显存` : "未检测到设备"}</span></div><div class="gpu-grid">${gpuHtml}</div></section></div>`;
  if (state.selectedTask) renderTaskGpu(state.selectedTask);
  showNotice(`状态更新于 ${new Date().toLocaleTimeString()}`);
}

function scheduleMonitoring() {
  clearTimeout(state.monitorTimer);
  if (!state.session || state.monitoringPaused) return;
  const seconds = Number($("#refreshInterval").value || 0);
  if (!seconds) return;
  state.monitorTimer = setTimeout(async () => { try { await refresh({ silent: true }); } finally { scheduleMonitoring(); } }, seconds * 1000);
}
function toggleMonitoringPause() {
  state.monitoringPaused = !state.monitoringPaused;
  $("#pauseMonitoring").textContent = state.monitoringPaused ? "恢复监控" : "暂停监控";
  if (state.monitoringPaused) clearTimeout(state.monitorTimer); else { void refresh({ silent: true }); scheduleMonitoring(); }
}
function updateRefreshSchedule() { state.monitoringPaused = false; $("#pauseMonitoring").textContent = "暂停监控"; void refresh({ silent: true }); scheduleMonitoring(); }

function renderJobOverview() {
  const jobs = [...state.terminals.values()].flatMap((terminal) => terminal.jobs.map((job) => ({ ...job, terminal: terminal.index })));
  const active = jobs.filter((job) => job.status === "queued" || job.status === "running");
  $("#jobOverview").hidden = !jobs.length;
  $("#jobCount").textContent = active.length ? `${active.length} 个运行中` : `${jobs.length} 个任务`;
  $("#jobRows").innerHTML = jobs.slice(-8).reverse().map((job) => `<div class="job-row"><span>终端 ${escapeHtml(job.terminal)}</span><code title="${escapeHtml(job.command)}">${escapeHtml(job.command)}</code><span class="job-status ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span><span>${escapeHtml(job.duration_ms ?? "-")} ms</span></div>`).join("");
}

async function openSession(payload) {
  try {
    const result = await request("/api/v1/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    state.session = result.session; state.terminals.clear(); state.activeTerminal = null; state.commandHistory = []; state.historyCursor = -1; state.currentDirectory = "."; state.openDirectories = new Set(["."]); state.fileTreeCache.clear(); clearFileEditor(); updateCurrentDirectory(); resetTaskState(); loadTerminalLabels(); saveActiveSession(false);
    $("#password").value = ""; connected(true); state.monitoringPaused = false;
    await syncAgentPreference();
    renderStatus(result.status); $("#lastRefresh").textContent = `更新于 ${new Date().toLocaleTimeString()}`; startTerminalPolling(); scheduleMonitoring(); listFiles(); refreshTransfers(); return true;
  } catch (error) {
    const trust = error.payload;
    if (trust?.trust_required) {
      const accepted = window.confirm(`首次连接必须核验服务器指纹。\n\n主机：${trust.host}:${trust.port}\n算法：${trust.key_type}\n指纹：${trust.fingerprint}\n\n请通过可信渠道核对后再确认。`);
      if (accepted) { await request("/api/v1/host-keys/trust", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: trust.token }) }); return openSession(payload); }
      showNotice("已取消主机密钥信任；未建立连接。"); return;
    }
    $("#connect").disabled = false; showNotice(`连接失败：${error.message}`);
  }
}

async function syncAgentPreference() {
  if (!state.session) return;
  const enabled = Boolean($("#agentEnabled").checked);
  try {
    await request(`/api/v1/sessions/${encodeURIComponent(state.session)}/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
    saveActiveSession(enabled);
  } catch (error) {
    $("#agentEnabled").checked = false; saveActiveSession(false); showNotice(`SSH 已连接，但 Agent 授权失败：${error.message}`);
  }
}

async function connect(event) {
  event.preventDefault(); const form = new FormData($("#connectForm"));
  $("#connect").disabled = true; showNotice("正在建立 SSH 会话…");
  const payload = { protocol: form.get("protocol"), host: form.get("host"), port: Number(form.get("port")), username: form.get("username"), auth_method: form.get("auth_method"), password: form.get("password") };
  const connectedSuccessfully = await openSession(payload);
  if (connectedSuccessfully && $("#saveProfile").checked) saveProfile(payload);
}

function updateAuthMethod() {
  const passwordMode = $("#authMethod").value === "password";
  $("#passwordField").hidden = !passwordMode;
  $("#password").required = passwordMode;
  if (!passwordMode) $("#password").value = "";
}

function readProfiles() {
  try { const value = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
}
function renderProfiles() {
  const profiles = readProfiles();
  $("#savedProfile").innerHTML = "<option value=\"\">选择连接配置</option>" + profiles.map((profile) => "<option value=\"" + escapeHtml(profile.id) + "\">" + escapeHtml(profile.label) + "</option>").join("");
  $("#deleteProfile").disabled = !profiles.length;
}
function applyProfile() {
  const profile = readProfiles().find((item) => item.id === $("#savedProfile").value);
  if (!profile) return;
  $("#protocol").value = profile.protocol || "ssh";
  $("#host").value = profile.host || "";
  $("#port").value = profile.port || 22;
  $("#username").value = profile.username || "";
  $("#authMethod").value = profile.auth_method || "password";
  updateAuthMethod();
  $("#password").value = "";
  showNotice("已填充连接配置，请输入密码后连接。");
}
function saveProfile(payload) {
  const profile = { label: payload.username + "@" + payload.host + ":" + payload.port, protocol: payload.protocol || "ssh", host: payload.host, port: payload.port, username: payload.username, auth_method: payload.auth_method || "password", updated_at: new Date().toISOString() };
  const profiles = readProfiles();
  const existing = profiles.find((item) => item.host === profile.host && Number(item.port) === Number(profile.port) && item.username === profile.username && (item.protocol || "ssh") === profile.protocol && (item.auth_method || "password") === profile.auth_method);
  if (existing) Object.assign(existing, profile);
  else profiles.unshift({ id: "profile-" + Date.now().toString(36), ...profile });
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profiles.slice(0, 20)));
  renderProfiles();
}
function deleteProfile() {
  const id = $("#savedProfile").value;
  if (!id) return;
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(readProfiles().filter((item) => item.id !== id)));
  renderProfiles();
  showNotice("连接配置已删除。");
}

async function refreshNow({ silent = false } = {}) {
  if (!state.session) return false; $("#refresh").disabled = true; if (!silent) showNotice("正在读取远程状态…");
  try { renderStatus(await request(`/api/v1/sessions/${encodeURIComponent(state.session)}/status`)); $("#lastRefresh").textContent = `更新于 ${new Date().toLocaleTimeString()}`; }
  catch (error) { if (!silent) showNotice(`状态读取失败：${error.message}`); return false; }
  finally { $("#refresh").disabled = !state.session; }
}

let monitorInFlight = false;
async function refresh(options = {}) {
  if (!state.session || monitorInFlight) return false;
  monitorInFlight = true;
  try { return await refreshNow(options); }
  finally { monitorInFlight = false; }
}

async function readLog() {
  if (!state.session) return; const path = $("#logPath").value.trim(); if (!path) { showNotice("请输入日志路径"); return; }
  try { const result = await request(`/api/v1/sessions/${encodeURIComponent(state.session)}/logs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, lines: 200 }) }); $("#logOutput").hidden = false; $("#logOutput").textContent = result.content || "（日志为空）"; }
  catch (error) { showNotice(`日志读取失败：${error.message}`); }
}

function joinRemotePath(base, name) { return base === "." ? name : base + "/" + name; }
function parentRemotePath(filePath) { const index = String(filePath).lastIndexOf("/"); return index < 0 ? "." : filePath.slice(0, index) || "."; }
function remoteBaseName(filePath) { const parts = String(filePath).split("/"); return parts[parts.length - 1] || filePath; }
function isImageFile(filePath) { return /\.(?:png|jpe?g|gif|webp|bmp|avif|ico)$/i.test(String(filePath || "")); }
function formatFileBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

const TASK_CANCELLABLE_STATUSES = new Set(["queued", "starting", "running", "cancelling"]);
const TASK_STATUS_LABELS = { queued: "排队中", starting: "启动中", running: "运行中", cancelling: "取消中", completed: "已完成", failed: "失败", cancelled: "已取消", cancel_incomplete: "取消未完成", interrupted: "已中断", unknown: "未知" };
function taskIdOf(record) { return record?.manifest?.task_id || record?.status?.task_id || ""; }
function taskStatusOf(record) { return record?.status?.status || "unknown"; }
function taskStatusLabel(status) { return TASK_STATUS_LABELS[status] || status || "未知"; }
function taskTime(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "未知"; }
function currentTaskRecords() { return state.taskMode === "active" ? state.taskActive : state.taskHistory; }
function mergeTaskRecords(existing, incoming) {
  const records = new Map(existing.map((record) => [taskIdOf(record), record]));
  for (const record of incoming) records.set(taskIdOf(record), record);
  return [...records.values()];
}

function resetTaskState() {
  clearTimeout(state.taskStatusTimer);
  clearTimeout(state.taskLogTimer);
  state.taskMode = "active"; state.taskActive = []; state.taskHistory = []; state.taskHistoryCursor = null; state.taskCapabilities = null; state.taskStorage = null; state.selectedTaskId = null; state.selectedTask = null; state.taskLoaded = false; state.taskLoading = false; state.taskStatusLoading = false; state.taskStatusTimer = null; state.taskStatusError = null; state.taskObservedAt = null; state.taskLogLoading = false; state.taskLogOffset = 0; state.taskLogTimer = null;
  if (!$("#taskList")) return;
  $("#taskCapabilitySummary").textContent = "等待读取任务能力"; $("#taskObserverState").textContent = "未监控"; $("#taskObserverState").className = "task-observer-state"; $("#taskRemoteCount").textContent = "-"; $("#taskRemoteBytes").textContent = "-"; $("#taskLocalCount").textContent = "-"; $("#taskPinnedCount").textContent = "-"; $("#taskScanStatus").textContent = "-"; $("#taskCleanupSummary").textContent = "尚未预演"; $("#taskList").innerHTML = '<div class="task-empty">暂无任务数据</div>'; $("#taskListCount").textContent = "0 条"; $("#taskDetail").hidden = true; $("#taskDetailEmpty").hidden = false; $("#taskGpuPanel").hidden = true; $("#taskGpuList").innerHTML = ""; $("#taskLogOutput").textContent = "（日志为空）"; $("#taskLogOffset").textContent = "offset 0"; $("#loadMoreTasks").hidden = true; $("#previewTaskCleanup").disabled = true;
  for (const button of document.querySelectorAll(".task-mode")) { const active = button.dataset.taskMode === "active"; button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); }
}

function renderTaskStorage() {
  const capabilities = state.taskCapabilities || {};
  const storage = state.taskStorage || {};
  const remote = storage.remote_store || {};
  const local = storage.local_index || {};
  const launchers = Object.entries(capabilities.launchers || {}).filter(([, value]) => value.available).map(([name, value]) => `${name} ${value.reliability}`).join(" · ");
  $("#taskCapabilitySummary").textContent = capabilities.base_available ? `${launchers || "启动器可用"} · 记录删除${capabilities.remote_record_deletion_enabled ? "已启用" : "关闭"}` : "远端缺少持久任务运行依赖";
  $("#taskRemoteCount").textContent = Number.isFinite(Number(remote.task_count)) ? `${remote.task_count} 条` : "-";
  $("#taskRemoteBytes").textContent = Number.isFinite(Number(remote.managed_bytes)) ? formatFileBytes(remote.managed_bytes) : "-";
  $("#taskLocalCount").textContent = Number.isFinite(Number(local.total_rows)) ? `${local.total_rows} 条` : "-";
  $("#taskPinnedCount").textContent = Number.isFinite(Number(local.pinned_rows)) ? `${local.pinned_rows} 条` : "-";
  $("#taskScanStatus").textContent = remote.complete ? "完整" : remote.truncated ? "已截断" : remote.errors?.length ? `${remote.errors.length} 个错误` : "等待扫描";
  $("#previewTaskCleanup").disabled = !state.session || !remote.task_count;
}

function renderTaskList() {
  const records = currentTaskRecords();
  $("#taskListTitle").textContent = state.taskMode === "active" ? "当前任务" : "任务历史";
  $("#taskListCount").textContent = `${records.length} 条`;
  $("#taskStatusFilter").disabled = state.taskMode !== "history";
  $("#loadMoreTasks").hidden = state.taskMode !== "history" || !state.taskHistoryCursor;
  if (!records.length) { $("#taskList").innerHTML = `<div class="task-empty">${state.taskMode === "active" ? "当前没有 Bridge 管理的活动或未决任务" : "没有符合条件的历史任务"}</div>`; return; }
  $("#taskList").innerHTML = records.map((record) => {
    const id = taskIdOf(record); const status = taskStatusOf(record); const selected = id === state.selectedTaskId;
    return `<button class="task-row${selected ? " selected" : ""}" type="button" data-task-id="${escapeHtml(id)}"><span class="task-row-top"><span class="task-status ${escapeHtml(status)}">${escapeHtml(taskStatusLabel(status))}</span>${record.pinned ? '<span class="task-pin-badge">已固定</span>' : ""}<time>${escapeHtml(taskTime(record.status?.updated_at || record.manifest?.created_at))}</time></span><strong title="${escapeHtml(id)}">${escapeHtml(id)}</strong><span class="task-row-command" title="${escapeHtml(record.manifest?.display_command || "")}">${escapeHtml(record.manifest?.display_command || "无命令摘要")}</span><span class="task-row-meta">${escapeHtml(record.manifest?.workdir || ".")} · ${escapeHtml(record.manifest?.launcher || "unknown")}</span></button>`;
  }).join("");
  for (const button of $("#taskList").querySelectorAll(".task-row")) button.addEventListener("click", () => selectTask(button.dataset.taskId));
}

function renderTaskDetail(record) {
  state.selectedTask = record;
  if (!record) { $("#taskDetail").hidden = true; $("#taskDetailEmpty").hidden = false; renderTaskGpu(null); return; }
  const status = taskStatusOf(record);
  $("#taskDetailEmpty").hidden = true; $("#taskDetail").hidden = false;
  $("#taskDetailId").textContent = taskIdOf(record);
  $("#taskDetailStatus").textContent = taskStatusLabel(status); $("#taskDetailStatus").className = `task-status ${status}`;
  $("#pinTask").textContent = record.pinned ? "取消固定" : "固定";
  $("#cancelTask").disabled = !TASK_CANCELLABLE_STATUSES.has(status);
  const metadata = [["创建时间", taskTime(record.manifest?.created_at)], ["更新时间", taskTime(record.status?.updated_at)], ["工作目录", record.manifest?.workdir || "."], ["启动器", `${record.manifest?.launcher || "unknown"} · ${record.manifest?.reliability || "unknown"}`], ["退出码", Number.isInteger(record.status?.exit_code) ? record.status.exit_code : "-"], ["日志状态", record.status?.logging_status || "-"]];
  $("#taskMetadata").innerHTML = metadata.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd></div>`).join("") + `<div class="task-command-meta"><dt>命令</dt><dd title="${escapeHtml(record.manifest?.display_command || "")}">${escapeHtml(record.manifest?.display_command || "-")}</dd></div>`;
  renderTaskGpu(record);
}

function renderTaskGpu(record) {
  const panel = $("#taskGpuPanel");
  if (!panel) return;
  if (!record) { panel.hidden = true; $("#taskGpuList").innerHTML = ""; return; }
  panel.hidden = false;
  const allGpus = Array.isArray(state.hostStatus?.gpus) ? state.hostStatus.gpus : [];
  const resources = record.manifest?.resources && typeof record.manifest.resources === "object" ? record.manifest.resources : {};
  const visibility = resources.gpu_visibility || "unrecorded";
  const declared = visibility === "restricted" && Array.isArray(resources.gpu_devices) ? [...new Set(resources.gpu_devices.filter((value) => Number.isInteger(value) && value >= 0))] : [];
  const sampleTime = Number.isFinite(Number(state.hostStatus?.collected_at)) ? new Date(Number(state.hostStatus.collected_at) * 1000).toLocaleTimeString() : "等待主机采样";
  let summary = `主机快照 ${sampleTime} · 未记录任务绑定`;
  let cards = allGpus.map((gpu) => ({ gpu, declared: false }));
  if (visibility === "restricted") {
    summary = `任务声明 GPU ${declared.length ? declared.join(", ") : "-"} · 主机快照 ${sampleTime}`;
    cards = declared.map((index) => ({ gpu: allGpus.find((gpu) => Number(gpu.index) === index) || { index }, declared: true }));
  } else if (visibility === "all") summary = `任务声明全部可见 GPU · 主机快照 ${sampleTime}`;
  else if (visibility === "none") { summary = "任务声明不使用 GPU"; cards = []; }
  else if (visibility === "unresolved") summary = `任务 GPU 选择器无法映射到物理编号 · 主机快照 ${sampleTime}`;
  $("#taskGpuSummary").textContent = summary;
  if (!cards.length) {
    $("#taskGpuList").innerHTML = `<div class="task-gpu-empty">${visibility === "none" ? "此任务未请求 GPU" : "当前主机快照未检测到 NVIDIA GPU"}</div>`;
    return;
  }
  $("#taskGpuList").innerHTML = cards.map(({ gpu, declared: isDeclared }) => {
    const available = Number.isFinite(Number(gpu.memory_total_mib));
    if (!available) return `<article class="task-gpu-card unavailable${isDeclared ? " declared" : ""}"><div class="task-gpu-card-head"><strong>GPU ${escapeHtml(gpu.index)}</strong><span>快照未返回</span></div></article>`;
    const utilization = percent(gpu.utilization_percent);
    const memoryPercent = Number(gpu.memory_total_mib) ? percent(Number(gpu.memory_used_mib) * 100 / Number(gpu.memory_total_mib)) : 0;
    return `<article class="task-gpu-card${isDeclared ? " declared" : ""}"><div class="task-gpu-card-head"><strong>GPU ${escapeHtml(gpu.index)}</strong><span>${escapeHtml(gpu.temperature_c)} °C</span></div><div class="gauge-row"><span>利用率</span><div class="bar"><i style="width:${utilization}%"></i></div><b>${utilization}%</b></div><div class="gauge-row"><span>显存</span><div class="bar memory"><i style="width:${memoryPercent}%"></i></div><b>${escapeHtml(gpu.memory_used_mib)} / ${escapeHtml(gpu.memory_total_mib)} MiB</b></div></article>`;
  }).join("");
}

function renderTaskObserverState() {
  const element = $("#taskObserverState");
  if (!element) return;
  element.className = "task-observer-state";
  if (!state.session || state.workspaceView !== "tasks" || !state.selectedTask) { element.textContent = "未监控"; return; }
  if (state.taskStatusLoading) { element.textContent = "正在核验"; element.classList.add("active"); return; }
  if (state.taskStatusError) { element.textContent = "监控异常"; element.classList.add("error"); return; }
  if (!TASK_CANCELLABLE_STATUSES.has(taskStatusOf(state.selectedTask))) { element.textContent = "任务已结束"; return; }
  element.textContent = state.taskObservedAt ? `自动监控 · ${state.taskObservedAt.toLocaleTimeString()}` : "自动监控";
  element.classList.add("active");
}

function scheduleTaskStatusPolling(delay = 5000) {
  clearTimeout(state.taskStatusTimer); state.taskStatusTimer = null; renderTaskObserverState();
  if (!state.session || state.workspaceView !== "tasks" || !state.selectedTaskId || !TASK_CANCELLABLE_STATUSES.has(taskStatusOf(state.selectedTask))) return;
  state.taskStatusTimer = setTimeout(refreshSelectedTaskStatus, delay);
}

async function refreshSelectedTaskStatus() {
  if (state.taskStatusLoading || state.taskLoading) { scheduleTaskStatusPolling(1000); return; }
  const taskId = state.selectedTaskId;
  if (!taskId || !state.session || state.workspaceView !== "tasks") return;
  const previousStatus = taskStatusOf(state.selectedTask);
  state.taskStatusLoading = true; state.taskStatusError = null; renderTaskObserverState();
  try {
    const record = await request(`/api/v1/agent/tasks/${encodeURIComponent(taskId)}`);
    if (state.selectedTaskId !== taskId) return;
    state.taskObservedAt = new Date(); replaceTaskRecord(record);
    const nextStatus = taskStatusOf(record);
    if (nextStatus !== previousStatus && !TASK_CANCELLABLE_STATUSES.has(nextStatus)) {
      showNotice(`任务 ${taskId} 已更新为${taskStatusLabel(nextStatus)}`);
      refreshTaskStorage();
    }
  } catch (error) {
    if (state.selectedTaskId === taskId) state.taskStatusError = error.message;
  } finally {
    state.taskStatusLoading = false; renderTaskObserverState(); scheduleTaskStatusPolling(state.taskStatusError ? 10000 : 5000); scheduleTaskLogPolling();
  }
}

async function selectTask(taskId, { resetLog = true } = {}) {
  if (!taskId) return;
  const changed = state.selectedTaskId !== taskId;
  state.selectedTaskId = taskId; renderTaskList();
  try {
    const record = await request(`/api/v1/agent/tasks/${encodeURIComponent(taskId)}`);
    if (state.selectedTaskId !== taskId) return;
    renderTaskDetail(record);
  } catch (error) {
    if (state.selectedTaskId !== taskId) return;
    const cached = currentTaskRecords().find((record) => taskIdOf(record) === taskId);
    renderTaskDetail(cached || null); showNotice(`任务详情读取失败：${error.message}`);
  }
  state.taskStatusError = null; state.taskObservedAt = new Date();
  if (changed || resetLog) await loadTaskLogs({ reset: true });
  else scheduleTaskLogPolling();
  scheduleTaskStatusPolling();
}

async function refreshTaskCenter({ resetHistory = true } = {}) {
  if (!state.session || state.taskLoading) return;
  if (state.taskMode === "history" && !resetHistory && !state.taskHistoryCursor) return;
  state.taskLoading = true; $("#refreshTasks").disabled = true;
  try {
    const [capabilities, storage] = await Promise.all([request("/api/v1/agent/tasks/capabilities"), request("/api/v1/agent/tasks/storage")]);
    state.taskCapabilities = capabilities; state.taskStorage = storage;
    if (state.taskMode === "active") state.taskActive = (await request("/api/v1/agent/tasks")).tasks || [];
    else {
      const query = new URLSearchParams({ limit: "50" }); const status = $("#taskStatusFilter").value;
      if (status) query.set("status", status);
      if (!resetHistory && state.taskHistoryCursor) query.set("cursor", state.taskHistoryCursor);
      const page = await request(`/api/v1/agent/tasks/history?${query}`);
      state.taskHistory = resetHistory ? page.tasks || [] : mergeTaskRecords(state.taskHistory, page.tasks || []);
      state.taskHistoryCursor = page.next_cursor || null;
    }
    state.taskLoaded = true; renderTaskStorage(); renderTaskList();
    const records = currentTaskRecords(); const selectedExists = records.some((record) => taskIdOf(record) === state.selectedTaskId);
    if (selectedExists) await selectTask(state.selectedTaskId, { resetLog: false });
    else if (records[0]) await selectTask(taskIdOf(records[0]), { resetLog: true });
    else { state.selectedTaskId = null; renderTaskDetail(null); }
    showNotice(`任务中心更新于 ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    $("#taskCapabilitySummary").textContent = `任务接口不可用：${error.message}`;
    $("#taskList").innerHTML = '<div class="task-empty">请确认已启用持久任务，并允许本地 Agent 使用当前 SSH 会话。</div>';
    showNotice(`任务中心读取失败：${error.message}`);
  } finally { state.taskLoading = false; $("#refreshTasks").disabled = !state.session; scheduleTaskStatusPolling(); }
}

function setTaskMode(mode) {
  if (!new Set(["active", "history"]).has(mode) || state.taskMode === mode) return;
  state.taskMode = mode; state.selectedTaskId = null; state.selectedTask = null; state.taskStatusError = null; state.taskObservedAt = null; clearTimeout(state.taskStatusTimer); state.taskStatusTimer = null; clearTimeout(state.taskLogTimer); state.taskLogTimer = null; renderTaskObserverState();
  for (const button of document.querySelectorAll(".task-mode")) { const active = button.dataset.taskMode === mode; button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); }
  renderTaskDetail(null); renderTaskList(); refreshTaskCenter({ resetHistory: true });
}

async function refreshTaskStorage() {
  try { state.taskStorage = await request("/api/v1/agent/tasks/storage?refresh=true"); renderTaskStorage(); }
  catch (error) { showNotice(`任务存储统计失败：${error.message}`); }
}

function replaceTaskRecord(record) {
  const id = taskIdOf(record); const replace = (records) => records.map((item) => taskIdOf(item) === id ? record : item);
  state.taskActive = replace(state.taskActive); state.taskHistory = replace(state.taskHistory); state.selectedTask = record; renderTaskList(); renderTaskDetail(record);
}

async function toggleSelectedTaskPin() {
  const record = state.selectedTask; if (!record) return;
  const action = record.pinned ? "unpin" : "pin"; $("#pinTask").disabled = true;
  try { const result = await request(`/api/v1/agent/tasks/${encodeURIComponent(taskIdOf(record))}/${action}`, { method: "POST" }); replaceTaskRecord(result); await refreshTaskStorage(); showNotice(result.pinned ? "任务记录已固定" : "已取消固定"); }
  catch (error) { showNotice(`任务固定操作失败：${error.message}`); }
  finally { $("#pinTask").disabled = false; }
}

async function cancelSelectedTask() {
  const record = state.selectedTask; if (!record || !TASK_CANCELLABLE_STATUSES.has(taskStatusOf(record))) return;
  if (!window.confirm(`确认取消任务 ${taskIdOf(record)}？\n\n系统会校验远端进程身份后终止任务进程组。`)) return;
  $("#cancelTask").disabled = true;
  try { const result = await request(`/api/v1/agent/tasks/${encodeURIComponent(taskIdOf(record))}/cancel`, { method: "POST" }); replaceTaskRecord(result); showNotice("已提交任务取消请求"); setTimeout(() => refreshTaskCenter({ resetHistory: true }), 1200); }
  catch (error) { showNotice(`取消任务失败：${error.message}`); $("#cancelTask").disabled = false; }
}

async function previewTaskCleanup() {
  $("#previewTaskCleanup").disabled = true; $("#taskCleanupSummary").textContent = "正在计算…";
  try {
    const result = await request("/api/v1/agent/tasks/cleanup-preview?refresh=true&retention_days=30&quota_bytes=2147483648&limit=100");
    $("#taskCleanupSummary").textContent = result.candidate_count ? `${result.candidate_count} 条候选 · 可释放 ${formatFileBytes(result.candidate_bytes)} · 仅预演` : `无候选 · ${formatFileBytes(result.managed_bytes)} 已管理 · 仅预演`;
    showNotice(result.scan_complete ? "清理预演完成，没有执行删除" : "清理预演基于不完整扫描，没有执行删除");
  } catch (error) { $("#taskCleanupSummary").textContent = `预演失败：${error.message}`; }
  finally { $("#previewTaskCleanup").disabled = !state.session; }
}

function scheduleTaskLogPolling() {
  clearTimeout(state.taskLogTimer); state.taskLogTimer = null;
  if (!state.session || state.workspaceView !== "tasks" || !state.selectedTaskId || !$("#taskLogFollow").checked || !TASK_CANCELLABLE_STATUSES.has(taskStatusOf(state.selectedTask))) return;
  state.taskLogTimer = setTimeout(() => loadTaskLogs({ reset: false }), 3000);
}

async function loadTaskLogs({ reset = false } = {}) {
  if (!state.selectedTaskId || state.taskLogLoading) return;
  state.taskLogLoading = true; clearTimeout(state.taskLogTimer); state.taskLogTimer = null;
  if (reset) { state.taskLogOffset = 0; $("#taskLogOutput").textContent = ""; $("#taskLogNotice").hidden = true; }
  const stream = $("#taskLogStream").value;
  try {
    const result = await request(`/api/v1/agent/tasks/${encodeURIComponent(state.selectedTaskId)}/logs?stream=${encodeURIComponent(stream)}&offset=${state.taskLogOffset}&max_bytes=262144`);
    if (result.cursor_was_dropped) { $("#taskLogNotice").hidden = false; $("#taskLogNotice").textContent = `早期日志已轮转，从 offset ${result.first_available_offset} 继续。`; }
    if (result.content) { if ($("#taskLogOutput").textContent === "（日志为空）") $("#taskLogOutput").textContent = ""; $("#taskLogOutput").textContent += result.content; }
    if (!$("#taskLogOutput").textContent) $("#taskLogOutput").textContent = "（日志为空）";
    state.taskLogOffset = Number(result.next_offset || state.taskLogOffset); $("#taskLogOffset").textContent = `offset ${state.taskLogOffset}`;
    if ($("#taskLogFollow").checked) $("#taskLogOutput").scrollTop = $("#taskLogOutput").scrollHeight;
  } catch (error) { $("#taskLogNotice").hidden = false; $("#taskLogNotice").textContent = `日志读取失败：${error.message}`; }
  finally { state.taskLogLoading = false; scheduleTaskLogPolling(); }
}

function filePreviewBlockReason(filePath, size) {
  const bytes = Math.max(0, Number(size) || 0);
  if (isImageFile(filePath)) return bytes > MAX_INLINE_IMAGE_PREVIEW_BYTES ? `图片超过 ${formatFileBytes(MAX_INLINE_IMAGE_PREVIEW_BYTES)}，为避免占用过多内存，不在网页中预览。` : "";
  if (BINARY_PREVIEW_PATTERN.test(String(filePath || ""))) return "这是权重、归档、文档或其他二进制格式，网页不会尝试解析。";
  if (bytes > MAX_INLINE_TEXT_PREVIEW_BYTES) return `文件超过 ${formatFileBytes(MAX_INLINE_TEXT_PREVIEW_BYTES)}，为避免浏览器卡顿，不自动预览；可直接下载或通过日志功能读取文本尾部。`;
  return "";
}
function updateCurrentDirectory() {
  $("#fileCurrentDirectory").textContent = state.currentDirectory || ".";
  $("#parentFolder").disabled = !state.session || state.currentDirectory === ".";
}
function clearFileEditor() {
  state.fileEditorPath = null; state.fileEditorKind = null; state.fileViewMode = "preview";
  const image = $("#fileImagePreview");
  if (image) { image.removeAttribute("src"); image.alt = ""; image.hidden = true; }
  if ($("#filePreviewNotice")) { $("#filePreviewNotice").hidden = true; $("#filePreviewNotice").textContent = ""; }
  if ($(".file-editor-empty")) $(".file-editor-empty").hidden = false;
  if ($(".file-editor-content")) $(".file-editor-content").hidden = true;
}
function updateFileActionState() {
  const selected = Boolean(state.session && state.selectedFilePath);
  const selectedFile = selected && state.selectedFileType === "file";
  $("#downloadFile").disabled = !selectedFile;
  $("#renameFile").disabled = !selected;
  $("#deleteFile").disabled = !selected;
  $("#fileSelection").textContent = selected ? `${state.selectedFileType === "directory" ? "目录" : "文件"}：${state.selectedFilePath}${selectedFile ? ` · ${formatFileBytes(state.selectedFileSize)}` : ""}` : "未选择项目";
}
function sortFileEntries(entries) { return [...entries].sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base" }) : a.type === "directory" ? -1 : 1); }
async function loadDirectory(filePath, force = false) {
  if (!force && state.fileTreeCache.has(filePath)) return state.fileTreeCache.get(filePath);
  const result = await request("/api/v1/sessions/" + encodeURIComponent(state.session) + "/files?path=" + encodeURIComponent(filePath));
  const entries = sortFileEntries(result.entries || []);
  state.fileTreeCache.set(filePath, entries);
  return entries;
}
function treeRows(filePath, depth = 0) {
  const entries = state.fileTreeCache.get(filePath) || [];
  return entries.map((entry) => {
    const childPath = joinRemotePath(filePath, entry.name);
    const directory = entry.type === "directory";
    const open = directory && state.openDirectories.has(childPath);
    const selected = childPath === state.selectedFilePath;
    const current = directory && childPath === state.currentDirectory;
    const size = directory ? "" : "<small>" + escapeHtml(formatFileBytes(entry.size)) + "</small>";
    const row = "<button type=\"button\" class=\"tree-row " + entry.type + (selected ? " selected" : "") + (current ? " current" : "") + "\" data-path=\"" + escapeHtml(childPath) + "\" data-type=\"" + entry.type + "\" data-size=\"" + escapeHtml(entry.size || 0) + "\" style=\"--tree-depth:" + depth + "\"><span class=\"tree-chevron\">" + (directory ? (open ? "▾" : "▸") : "") + "</span><span class=\"tree-icon " + (directory ? "folder-icon" : "file-icon") + "\"></span><span class=\"tree-name\">" + escapeHtml(entry.name) + "</span>" + size + "</button>";
    return row + (open ? treeRows(childPath, depth + 1) : "");
  }).join("");
}
function renderFileTree() {
  $("#fileList").innerHTML = treeRows(".") || "<div class=\"tree-empty\">目录为空</div>";
  for (const button of $("#fileList").querySelectorAll(".tree-row")) button.addEventListener("click", () => openFileEntry(button.dataset.path, button.dataset.type, Number(button.dataset.size || 0)));
}
function fileLanguage(filePath) {
  const name = String(filePath || "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : "";
  if (["py", "pyw"].includes(ext)) return "python";
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx"].includes(ext)) return "javascript";
  if (["json", "jsonl"].includes(ext)) return "json";
  if (["sh", "bash", "zsh", "fish"].includes(ext)) return "shell";
  if (["html", "htm", "xml", "svg"].includes(ext)) return "markup";
  if (["css", "scss", "less"].includes(ext)) return "css";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["yml", "yaml", "toml", "ini", "cfg", "conf"].includes(ext)) return "config";
  if (["c", "h", "cc", "cpp", "hpp", "cu", "go", "rs", "java"].includes(ext)) return "systems";
  return "text";
}
function highlightSource(source, filePath) {
  const language = fileLanguage(filePath);
  if (language === "text") return escapeHtml(source);
  const keywords = {
    python: "and|as|assert|async|await|class|def|elif|else|for|from|if|import|in|is|lambda|match|not|or|pass|raise|return|try|while|with|yield|True|False|None|self",
    javascript: "as|async|await|break|case| catch|class|const|continue|debugger|default|delete|else|export|extends|false|finally|for|from|function|if|import|in|instanceof|let|new|null|of|return|static|switch|this|throw|true|try|typeof|var|void|while|with|yield",
    json: "true|false|null",
    shell: "case|do|done|elif|else|esac|fi|for|function|if|in|select|then|time|until|while",
    markup: "DOCTYPE|html|head|body|div|span|script|style|section|main|title|meta|link",
    css: "@media|@import|@supports|important",
    config: "true|false|null|yes|no",
    systems: "auto|bool|break|case|class|const|continue|else|enum|false|fn|for|if|impl|import|in|let|match|mut|new|null|package|public|return|static|struct|switch|this|trait|true|type|use|while",
    markdown: "TODO|NOTE|WARNING"
  }[language];
  return String(source || "").split(/\r?\n/).map((line) => {
    let text = escapeHtml(line); const slots = [];
    const protect = (regex, className) => { text = text.replace(regex, (match) => { const index = slots.push(`<span class="${className}">${match}</span>`) - 1; return `\u0000${"x".repeat(index + 1)}\u0000`; }); };
    protect(/(&quot;|&#39;|`)(?:\\.|(?!\1)[^\\\r\n])*\1/g, "tok-string");
    if (["python", "shell", "config"].includes(language)) protect(/(^|\s)(#.*$)/g, "tok-comment");
    else if (["javascript", "systems", "css"].includes(language)) protect(/(\/\/.*$|\/\*.*?\*\/)/g, "tok-comment");
    else if (language === "markdown") protect(/(^|\s)(\u0000?)(\u0023{1,6}\s.*$)/g, "tok-heading");
    if (keywords) text = text.replace(new RegExp(`\\b(${keywords})\\b`, "g"), `<span class="tok-keyword">$1</span>`);
    text = text.replace(/\b\d+(?:\.\d+)?\b/g, `<span class="tok-number">$&</span>`);
    text = text.replace(/\b[A-Za-z_$][\w$]*(?=\s*\()/g, `<span class="tok-function">$&</span>`);
    return text.replace(/\u0000(x+)\u0000/g, (_, marker) => slots[marker.length - 1]);
  }).join("\n");
}
function renderFileEditor() {
  const image = state.fileEditorKind === "image";
  const unavailable = state.fileEditorKind === "unavailable";
  $("#fileImagePreview").hidden = !image;
  $("#filePreviewNotice").hidden = !unavailable;
  $(".file-editor-actions").hidden = image || unavailable;
  if (image || unavailable) { $("#fileHighlight").hidden = true; $("#fileContent").hidden = true; return; }
  const preview = state.fileViewMode === "preview";
  $("#fileHighlight").innerHTML = highlightSource($("#fileContent").value, state.fileEditorPath);
  $("#fileHighlight").hidden = !preview;
  $("#fileContent").hidden = preview;
  $("#toggleFileView").textContent = preview ? "编辑" : "高亮预览";
}
function showFilePreviewUnavailable(filePath, reason) {
  state.fileEditorPath = filePath;
  state.fileEditorKind = "unavailable";
  $("#fileEditorPath").textContent = filePath;
  $("#fileImagePreview").removeAttribute("src");
  $("#filePreviewNotice").textContent = `${reason} 仍可使用上方“下载”按钮获取原文件。`;
  $(".file-editor-empty").hidden = true;
  $(".file-editor-content").hidden = false;
  renderFileEditor();
}
async function listFiles() {
  if (!state.session) return;
  const current = state.currentDirectory || ".";
  try { state.fileTreeCache.delete(current); await loadDirectory(current, true); renderFileTree(); updateCurrentDirectory(); }
  catch (error) { showNotice("目录读取失败：" + error.message); }
}
async function openFileEntry(filePath, type, size = 0) {
  state.selectedFilePath = filePath; state.selectedFileType = type; state.selectedFileSize = Number(size || 0); updateFileActionState();
  if (type === "directory") {
    try {
      state.currentDirectory = filePath; updateCurrentDirectory();
      if (state.openDirectories.has(filePath)) state.openDirectories.delete(filePath);
      else { state.openDirectories.add(filePath); await loadDirectory(filePath); }
      renderFileTree();
    } catch (error) { showNotice("目录展开失败：" + error.message); }
    return;
  }
  state.currentDirectory = parentRemotePath(filePath); updateCurrentDirectory();
  const blocked = filePreviewBlockReason(filePath, size);
  if (blocked) { showFilePreviewUnavailable(filePath, blocked); renderFileTree(); return; }
  try {
    state.fileEditorPath = filePath;
    $("#fileEditorPath").textContent = filePath;
    $(".file-editor-empty").hidden = true;
    $(".file-editor-content").hidden = false;
    if (isImageFile(filePath)) {
      state.fileEditorKind = "image";
      const image = $("#fileImagePreview");
      image.alt = `图片预览：${filePath}`;
      image.src = `/api/v1/sessions/${encodeURIComponent(state.session)}/files/media?path=${encodeURIComponent(filePath)}`;
    } else {
      const result = await request("/api/v1/sessions/" + encodeURIComponent(state.session) + "/files/preview?path=" + encodeURIComponent(filePath));
      if (result.truncated) { showFilePreviewUnavailable(filePath, `文件在读取期间已超过 ${formatFileBytes(MAX_INLINE_TEXT_PREVIEW_BYTES)}，未加载不完整内容。`); renderFileTree(); return; }
      state.fileEditorKind = "text";
      $("#fileImagePreview").removeAttribute("src");
      $("#fileContent").value = result.content || "";
      state.fileViewMode = "preview";
    }
    renderFileEditor();
    renderFileTree();
  } catch (error) { showFilePreviewUnavailable(filePath, error.message || "文件格式不支持预览。"); renderFileTree(); }
}
async function openParentFolder() {
  if (!state.session || state.currentDirectory === ".") return;
  state.currentDirectory = parentRemotePath(state.currentDirectory); state.openDirectories.add(state.currentDirectory); updateCurrentDirectory();
  try { await loadDirectory(state.currentDirectory); renderFileTree(); }
  catch (error) { showNotice("上级目录读取失败：" + error.message); }
}
function toggleFileView() { if (state.fileEditorKind !== "text") return; state.fileViewMode = state.fileViewMode === "preview" ? "edit" : "preview"; renderFileEditor(); }
async function saveFile() {
  if (!state.session || !state.fileEditorPath || state.fileEditorKind !== "text") return;
  try { await request("/api/v1/sessions/" + encodeURIComponent(state.session) + "/files/content", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: state.fileEditorPath, content: $("#fileContent").value }) }); showNotice("文件已保存"); }
  catch (error) { showNotice("文件保存失败：" + error.message); }
}
async function newFolder() {
  if (!state.session) return;
  const name = window.prompt("新目录名称");
  if (!name) return;
  const base = state.currentDirectory || ".";
  const folder = joinRemotePath(base, name);
  try { await request("/api/v1/sessions/" + encodeURIComponent(state.session) + "/files/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: folder }) }); state.fileTreeCache.delete(base); await loadDirectory(base, true); renderFileTree(); }
  catch (error) { showNotice("新建目录失败：" + error.message); }
}

function downloadFile() {
  if (!state.session || state.selectedFileType !== "file" || !state.selectedFilePath) return;
  const link = document.createElement("a");
  link.href = `/api/v1/sessions/${encodeURIComponent(state.session)}/files/download?path=${encodeURIComponent(state.selectedFilePath)}`;
  link.download = remoteBaseName(state.selectedFilePath);
  document.body.appendChild(link); link.click(); link.remove();
}

async function renameFile() {
  if (!state.session || !state.selectedFilePath) return;
  const current = state.selectedFilePath;
  const name = window.prompt("新名称", remoteBaseName(current));
  if (name === null) return;
  const nextName = name.trim();
  if (!nextName || nextName.includes("/") || nextName.includes("\\")) { showNotice("重命名失败：名称不能包含路径分隔符"); return; }
  const next = joinRemotePath(parentRemotePath(current), nextName);
  try {
    await request(`/api/v1/sessions/${encodeURIComponent(state.session)}/files/rename`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: current, to: next }) });
    if (state.fileEditorPath === current) { state.fileEditorPath = next; $("#fileEditorPath").textContent = next; }
    if (state.currentDirectory === current || state.currentDirectory.startsWith(current + "/")) state.currentDirectory = next + state.currentDirectory.slice(current.length);
    state.selectedFilePath = next; state.fileTreeCache.delete(parentRemotePath(current)); await loadDirectory(parentRemotePath(current), true); renderFileTree(); updateCurrentDirectory(); updateFileActionState(); showNotice(`已重命名为 ${nextName}`);
  } catch (error) { showNotice(`重命名失败：${error.message}`); }
}

async function deleteFile() {
  if (!state.session || !state.selectedFilePath) return;
  const target = state.selectedFilePath; const type = state.selectedFileType;
  if (!window.confirm(`确认删除${type === "directory" ? "空目录" : "文件"} ${target}？`)) return;
  try {
    await request(`/api/v1/sessions/${encodeURIComponent(state.session)}/files?path=${encodeURIComponent(target)}`, { method: "DELETE" });
    if (state.fileEditorPath === target) clearFileEditor();
    if (state.currentDirectory === target || state.currentDirectory.startsWith(target + "/")) state.currentDirectory = parentRemotePath(target);
    state.openDirectories = new Set([...state.openDirectories].filter((item) => item !== target && !item.startsWith(target + "/")));
    state.selectedFilePath = null; state.selectedFileType = null; state.fileTreeCache.delete(parentRemotePath(target)); await loadDirectory(parentRemotePath(target), true); renderFileTree(); updateCurrentDirectory(); updateFileActionState(); showNotice(`已删除 ${target}`);
  } catch (error) { showNotice(`删除失败：${error.message}`); }
}

function formatTransferBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  if (bytes >= 1099511627776) return `${(bytes / 1099511627776).toFixed(2)} TiB`;
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GiB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
function transferStatusLabel(status) { return ({ queued: "排队中", preparing: "准备中", uploading: "上传中", retrying: "等待重试", paused: "已暂停", completed: "已完成", failed: "失败", cancelled: "已取消" })[status] || status; }
function transferPathForFile(file, base) {
  const relative = String(file.webkitRelativePath || file.name || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!relative || relative.split("/").includes("..")) throw new Error("文件名包含不安全路径");
  return joinRemotePath(base, relative);
}
function transferFingerprint(file, target, overwrite = false) {
  const host = `${$("#host").value.trim()}:${$("#port").value || 22}:${$("#username").value.trim()}`;
  return Promise.resolve(["rcb", host, target, file.size, file.lastModified || 0, overwrite ? "overwrite" : "create"].join("|"));
}
function transferIdFromUpload(upload) { try { return decodeURIComponent(new URL(upload?.url || "", location.href).pathname.split("/").filter(Boolean).pop() || ""); } catch { return ""; } }
function transferTargetExists(target) {
  const entries = state.fileTreeCache.get(parentRemotePath(target));
  return Array.isArray(entries) && entries.some((entry) => entry.name === remoteBaseName(target));
}
function transferErrorMessage(error) {
  const response = error?.originalResponse;
  const status = Number(response?.getStatus?.() || 0);
  const body = String(response?.getBody?.() || "").trim();
  if (/atomic overwrite is unavailable/i.test(body)) return "远程服务器不支持安全的原子覆盖";
  if (status === 409 || /target file already exists/i.test(body)) return "目标位置已存在同名文件";
  if (body) return body.replace(/^Something went wrong with that request\s*/i, "").trim() || error.message || "传输失败";
  return error?.message || "传输失败";
}
function transferHasTargetConflict(error) {
  const response = error?.originalResponse;
  return Number(response?.getStatus?.() || 0) === 409 && /target file already exists/i.test(String(response?.getBody?.() || ""));
}
function confirmTransferOverwrite(target) {
  return window.confirm(`目标文件 ${target} 已存在。\n\n是否覆盖？覆盖操作会在上传完成后原子替换远程文件。`);
}
function renderTransferQueue() {
  const local = [...state.transfers.values()];
  const localTargets = new Set(local.map((item) => item.target));
  const remote = state.remoteTransfers.filter((item) => !localTargets.has(item.path));
  const visible = local.length > 0 || remote.length > 0;
  const panel = $("#transferPanel");
  panel.classList.toggle("minimized", state.transferPanelMinimized);
  panel.hidden = !visible || state.transferPanelClosed;
  $("#showTransfers").hidden = !visible || !state.transferPanelClosed;
  $("#minimizeTransfers").textContent = state.transferPanelMinimized ? "+" : "−";
  $("#minimizeTransfers").title = state.transferPanelMinimized ? "展开上传窗口" : "最小化上传窗口";
  const rows = [...local.map((item) => {
    const progress = item.total ? Math.min(100, Math.round(item.bytes * 100 / item.total)) : 0;
    const status = item.status;
    const action = ["queued", "preparing", "uploading", "retrying"].includes(status) ? `<button type="button" data-transfer-action="pause" data-transfer-id="${item.id}">暂停</button>` : status === "paused" || status === "failed" ? `<button type="button" data-transfer-action="retry" data-transfer-id="${item.id}">${status === "failed" ? "重试" : "继续"}</button>` : "";
    const cancel = status !== "completed" && status !== "cancelled" ? `<button type="button" data-transfer-action="cancel" data-transfer-id="${item.id}">取消</button>` : status === "completed" ? `<button type="button" data-transfer-action="remove" data-transfer-id="${item.id}">删除记录</button>` : "";
    return `<article class="transfer-row"><div class="transfer-main"><strong class="transfer-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</strong><span class="transfer-path" title="${escapeHtml(item.target)}">${escapeHtml(item.target)}</span><div class="transfer-meta"><span>${formatTransferBytes(item.bytes)} / ${formatTransferBytes(item.total)}</span><span>${item.speed ? `${formatTransferBytes(item.speed)}/s` : status === "completed" ? "远程文件已保留" : "等待速度"}</span></div></div><div class="transfer-progress"><div class="transfer-bar"><i style="width:${progress}%"></i></div><div class="transfer-status ${escapeHtml(status)}">${transferStatusLabel(status)}${item.error ? `：${escapeHtml(item.error)}` : ""}</div></div><div class="transfer-actions">${action}${cancel}</div></article>`;
  }), ...remote.map((item) => {
    const completed = Boolean(item.completed);
    const progress = item.size ? Math.min(100, Math.round(item.offset * 100 / item.size)) : 0;
    return `<article class="transfer-row"><div class="transfer-main"><strong class="transfer-name">${completed ? "已完成上传" : "未完成传输"}</strong><span class="transfer-path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</span><div class="transfer-meta"><span>${formatTransferBytes(item.offset)} / ${formatTransferBytes(item.size)}</span><span>${completed ? "远程文件已保留" : "重新选择同一文件可续传"}</span></div></div><div class="transfer-progress"><div class="transfer-bar"><i style="width:${progress}%"></i></div><div class="transfer-status ${completed ? "completed" : "paused"}">${completed ? "已完成" : "等待续传文件"}</div></div><div class="transfer-actions"><button type="button" data-remote-transfer-action="remove" data-transfer-id="${escapeHtml(item.id)}">${completed ? "删除记录" : "删除任务"}</button></div></article>`;
  })].join("");
  $("#transferQueue").innerHTML = rows;
  const active = local.filter((item) => ["preparing", "uploading", "retrying"].includes(item.status)).length;
  $("#transferSummary").textContent = local.length || remote.length ? `${active} 个传输中 · ${local.length + remote.length} 个任务` : "暂无任务";
  $("#showTransfers").textContent = active ? `上传中 ${active}` : `上传任务 ${local.length + remote.length}`;
  for (const button of $("#transferQueue").querySelectorAll("button[data-transfer-action]")) button.addEventListener("click", () => handleTransferAction(button.dataset.transferAction, button.dataset.transferId));
  for (const button of $("#transferQueue").querySelectorAll("button[data-remote-transfer-action]")) button.addEventListener("click", () => discardRemoteTransfer(button.dataset.transferId));
}
function queueTransfers(files) {
  if (!state.session) return;
  const base = state.currentDirectory || ".";
  let added = 0; let skipped = 0;
  for (const file of files) {
    try {
      const target = transferPathForFile(file, base);
      const targetExists = transferTargetExists(target);
      const overwrite = targetExists && confirmTransferOverwrite(target);
      if (targetExists && !overwrite) { skipped += 1; continue; }
      const idValue = `local-${crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
      state.transfers.set(idValue, { id: idValue, file, target, overwrite, bytes: 0, total: file.size, speed: 0, status: "queued", error: "", upload: null, lastProgressAt: 0, lastProgressBytes: 0 });
      added += 1;
    } catch (error) { showNotice(`跳过 ${file.name}：${error.message}`); }
  }
  if (added) { state.transferPanelClosed = false; state.transferPanelMinimized = false; }
  renderTransferQueue(); pumpTransfers();
  if (added) showNotice(`已加入 ${added} 个传输任务${skipped ? `，跳过 ${skipped} 个` : ""}`);
  else if (skipped) showNotice(`已取消覆盖，跳过 ${skipped} 个文件`);
}

class ResumableUploadFallback {
  constructor(file, options) { this.file = file; this.options = options; this.url = options.uploadUrl || null; this.offset = 0; this.xhr = null; this.aborted = false; this.fingerprint = null; }
  async getFingerprint() { if (!this.fingerprint) this.fingerprint = await this.options.fingerprint(this.file, this.options); return this.fingerprint; }
  storageKey() { return `remote-control-bridge.tus.${this.fingerprint}`; }
  async findPreviousUploads() { await this.getFingerprint(); try { const value = JSON.parse(localStorage.getItem(this.storageKey()) || "null"); return value?.uploadUrl ? [{ ...value, urlStorageKey: this.storageKey() }] : []; } catch { return []; } }
  resumeFromPreviousUpload(previous) { this.url = previous.uploadUrl; }
  encodeMetadata(metadata) { return Object.entries(metadata || {}).map(([key, value]) => `${key} ${btoa(unescape(encodeURIComponent(String(value))))}`).join(","); }
  responseError(message, response) {
    const error = new Error(`${message} (${response.status})`);
    error.originalResponse = { getStatus: () => response.status, getBody: () => response.body || "" };
    return error;
  }
  request(method, url, headers = {}, body = null, progress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); this.xhr = xhr; xhr.open(method, url, true);
      for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
      if (progress && xhr.upload) xhr.upload.onprogress = (event) => { if (event.lengthComputable) progress(event.loaded); };
      xhr.onload = () => resolve({ status: xhr.status, headers: (name) => xhr.getResponseHeader(name), body: xhr.responseText });
      xhr.onerror = () => reject(new Error("网络连接中断"));
      xhr.onabort = () => reject(Object.assign(new Error("传输已暂停"), { aborted: true }));
      xhr.send(body);
    });
  }
  async create() {
    const response = await this.request("POST", this.options.endpoint, { "Tus-Resumable": "1.0.0", "Upload-Length": String(this.file.size), "Upload-Metadata": this.encodeMetadata(this.options.metadata), "X-RCB-Session": this.options.headers["X-RCB-Session"] });
    if (response.status !== 201) throw this.responseError("创建传输失败", response);
    this.url = new URL(response.headers("Location"), location.href).href;
    localStorage.setItem(this.storageKey(), JSON.stringify({ uploadUrl: this.url, size: this.file.size, metadata: this.options.metadata, creationTime: new Date().toISOString() }));
  }
  async head() {
    const response = await this.request("HEAD", this.url, { "Tus-Resumable": "1.0.0", "X-RCB-Session": this.options.headers["X-RCB-Session"] });
    if (response.status !== 200) throw this.responseError("读取续传位置失败", response);
    this.offset = Number(response.headers("Upload-Offset") || 0); this.options.onProgress?.(this.offset, this.file.size);
  }
  async patch(start, end) {
    const chunk = this.file.slice(start, end); const total = end - start; let last = 0;
    const response = await this.request("PATCH", this.url, { "Tus-Resumable": "1.0.0", "Upload-Offset": String(start), "Content-Type": "application/offset+octet-stream", "X-RCB-Session": this.options.headers["X-RCB-Session"] }, chunk, (loaded) => { last = loaded; this.options.onProgress?.(start + loaded, this.file.size); });
    if (response.status !== 204) throw this.responseError("上传分块失败", response);
    const accepted = Number(response.headers("Upload-Offset") || start + last || start + total); this.options.onChunkComplete?.(accepted - start, accepted, this.file.size); return accepted;
  }
  async run() {
    try {
      if (!this.url) await this.create();
      await this.head();
      const chunkSize = Number(this.options.chunkSize) || 16 * 1024 * 1024;
      while (this.offset < this.file.size && !this.aborted) {
        const start = this.offset; const end = Math.min(this.file.size, start + chunkSize); let error;
        for (let attempt = 0; attempt <= (this.options.retryDelays || []).length; attempt += 1) {
          try { this.offset = await this.patch(start, end); error = null; break; }
          catch (cause) { error = cause; if (cause.aborted || this.aborted) break; const delay = this.options.retryDelays?.[attempt]; if (delay == null) break; await new Promise((resolve) => setTimeout(resolve, delay)); }
        }
        if (error) throw error;
      }
      if (!this.aborted) { if (this.options.removeFingerprintOnSuccess) localStorage.removeItem(this.storageKey()); this.options.onSuccess?.({ lastResponse: null }); }
    } catch (error) { if (!error.aborted && !this.aborted) this.options.onError?.(error); }
  }
  start() { this.aborted = false; this.run(); }
  async abort(terminate = false) { this.aborted = true; try { this.xhr?.abort(); } catch {} if (terminate && this.url) { try { await this.request("DELETE", this.url, { "Tus-Resumable": "1.0.0", "X-RCB-Session": this.options.headers["X-RCB-Session"] }); } catch {} try { localStorage.removeItem(this.storageKey()); } catch {} } }
}

async function startTransfer(item) {
  if (!state.session || item.status !== "queued") return;
  state.transferActiveCount = (state.transferActiveCount || 0) + 1;
  item.status = "preparing"; item.error = ""; renderTransferQueue();
  const finish = () => { state.transferActiveCount = Math.max(0, (state.transferActiveCount || 1) - 1); pumpTransfers(); renderTransferQueue(); };
  try {
    const TusUpload = globalThis.tus?.Upload || ResumableUploadFallback;
    const upload = new TusUpload(item.file, {
      endpoint: "/api/v1/transfers",
      chunkSize: 16 * 1024 * 1024,
      retryDelays: [0, 1000, 3000, 10000, 30000, 60000],
      metadata: { session: state.session, path: item.target, filename: item.file.name, overwrite: item.overwrite ? "true" : "false" },
      headers: { "X-RCB-Session": state.session },
      fingerprint: (file) => transferFingerprint(file, item.target, item.overwrite),
      removeFingerprintOnSuccess: true,
      onBeforeRequest: () => { if (["preparing", "retrying"].includes(item.status)) { item.status = "uploading"; item.error = ""; renderTransferQueue(); } },
      onShouldRetry: (error) => {
        const status = Number(error?.originalResponse?.getStatus?.() || 0);
        if (status >= 400 && status < 500) return false;
        if (item.status !== "paused" && item.status !== "cancelled") { item.status = "retrying"; item.error = "连接暂时不可用，将自动重试"; renderTransferQueue(); }
        return true;
      },
      onProgress: (sent, total) => { const now = Date.now(); const elapsed = now - (item.lastProgressAt || now); item.speed = elapsed > 300 ? Math.max(0, (sent - item.lastProgressBytes) * 1000 / elapsed) : item.speed; item.bytes = sent; item.total = total; item.lastProgressAt = now; item.lastProgressBytes = sent; renderTransferQueue(); },
      onSuccess: async () => {
        item.status = "completed"; item.bytes = item.total; item.remoteId = transferIdFromUpload(upload); item.upload = null; finish();
        const parent = parentRemotePath(item.target); state.fileTreeCache.delete(parent);
        try { await loadDirectory(parent, true); renderFileTree(); } catch {}
        refreshTransfers();
      },
      onError: (error) => {
        if (item.status === "paused" || item.status === "cancelled") return;
        if (!item.overwrite && transferHasTargetConflict(error) && confirmTransferOverwrite(item.target)) {
          const restart = async () => {
            try { if (upload.url) await upload.abort(true); } catch {}
            item.overwrite = true; item.status = "queued"; item.error = ""; item.upload = null; finish();
          };
          restart();
          return;
        }
        item.status = "failed"; item.error = transferErrorMessage(error); finish();
      },
    });
    item.upload = upload;
    const previous = await upload.findPreviousUploads();
    if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
    if (item.status !== "preparing" || item.upload !== upload) return;
    item.status = "uploading"; renderTransferQueue();
    upload.start();
  } catch (error) { item.status = "failed"; item.error = error.message || "传输初始化失败"; item.upload = null; finish(); }
}
function pumpTransfers() {
  const limit = 2;
  while ((state.transferActiveCount || 0) < limit) {
    const next = [...state.transfers.values()].find((item) => item.status === "queued");
    if (!next) break;
    startTransfer(next);
  }
  renderTransferQueue();
}
async function handleTransferAction(action, idValue) {
  const item = state.transfers.get(idValue); if (!item) return;
  if (action === "pause" && item.status === "queued") { item.status = "paused"; renderTransferQueue(); return; }
  if (action === "pause" && item.upload) { item.status = "paused"; await item.upload.abort(false); state.transferActiveCount = Math.max(0, (state.transferActiveCount || 1) - 1); pumpTransfers(); return; }
  if (action === "cancel") { const wasActive = ["preparing", "uploading", "retrying"].includes(item.status); item.status = "cancelled"; try { await item.upload?.abort(true); } catch {} state.transfers.delete(idValue); if (wasActive) state.transferActiveCount = Math.max(0, (state.transferActiveCount || 1) - 1); pumpTransfers(); return; }
  if (action === "remove" && item.status === "completed") {
    try {
      let remoteId = item.remoteId || state.remoteTransfers.find((remote) => remote.completed && remote.path === item.target)?.id;
      if (!remoteId) { await refreshTransfers(); remoteId = state.remoteTransfers.find((remote) => remote.completed && remote.path === item.target)?.id; }
      if (remoteId) await discardRemoteTransfer(remoteId, false);
      state.transfers.delete(idValue); renderTransferQueue();
    } catch (error) { showNotice(`上传记录删除失败：${error.message}`); }
    return;
  }
  if (action === "retry") { item.status = "queued"; item.error = ""; pumpTransfers(); }
}
async function discardRemoteTransfer(idValue, announce = true) {
  if (!state.session || !idValue) return;
  try {
    const result = await request(`/api/v1/sessions/${encodeURIComponent(state.session)}/transfers/${encodeURIComponent(idValue)}`, { method: "DELETE" });
    state.remoteTransfers = state.remoteTransfers.filter((item) => item.id !== idValue); renderTransferQueue();
    if (announce) showNotice(result.file_preserved ? "上传历史已删除，远程文件已保留" : "未完成上传及临时文件已删除");
  } catch (error) { showNotice(`上传任务删除失败：${error.message}`); throw error; }
}
async function refreshTransfers() {
  if (!state.session) return;
  try { state.remoteTransfers = (await request(`/api/v1/sessions/${encodeURIComponent(state.session)}/transfers`)).transfers || []; renderTransferQueue(); }
  catch (error) { showNotice(`传输任务读取失败：${error.message}`); }
}
function toggleTransferPanel() { state.transferPanelMinimized = !state.transferPanelMinimized; renderTransferQueue(); }
function closeTransferPanel() { state.transferPanelClosed = true; renderTransferQueue(); }
function showTransferPanel() { state.transferPanelClosed = false; state.transferPanelMinimized = false; renderTransferQueue(); }

function renderTerminalTabs() {
  const tabs = [...state.terminals.values()].sort((a, b) => a.index - b.index);
  $("#terminalTabs").innerHTML = tabs.map((terminal) => `<button type="button" data-terminal="${terminal.terminal_id}" class="terminal-tab${terminal.terminal_id === state.activeTerminal ? " active" : ""}" title="双击重命名终端">${escapeHtml(terminalLabel(terminal))}<span class="terminal-state ${terminal.busy ? "busy" : "idle"}"></span></button>`).join("");
  for (const button of $("#terminalTabs").querySelectorAll("button")) {
    button.addEventListener("click", () => { state.activeTerminal = button.dataset.terminal; renderTerminalTabs(); renderTerminalOutput(); });
    button.addEventListener("dblclick", () => renameTerminal(button.dataset.terminal));
  }
  const active = state.terminals.get(state.activeTerminal);
  $("#stopCommand").disabled = !active?.busy || !active.current_job_id;
  $("#renameTerminal").disabled = !active;
}

function renameTerminal(terminalId) {
  const terminal = state.terminals.get(terminalId); if (!terminal) return;
  const label = window.prompt("终端名称", terminalLabel(terminal));
  if (label === null) return;
  const next = label.trim().slice(0, 40);
  if (next && next !== `终端 ${terminal.index}`) state.terminalLabels.set(terminalId, next);
  else state.terminalLabels.delete(terminalId);
  saveTerminalLabels(); renderTerminalTabs();
}
function renameActiveTerminal() { if (state.activeTerminal) renameTerminal(state.activeTerminal); }

function renderTerminalLedger() {
  const ledger = $("#terminalLedger"); const terminal = state.terminals.get(state.activeTerminal);
  const jobs = terminal?.jobs ? [...terminal.jobs].reverse() : [];
  ledger.hidden = !jobs.length;
  if (!jobs.length) { ledger.innerHTML = ""; return; }
  ledger.innerHTML = `<div class="ledger-heading"><strong>最近任务</strong><span>${jobs.length} 条</span></div>${jobs.slice(0, 12).map((job) => `<article class="ledger-row"><div class="ledger-command"><code title="${escapeHtml(job.command)}">${escapeHtml(job.command)}</code><span class="job-status ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span></div><div class="ledger-meta"><span>${job.duration_ms == null ? "运行中" : `${escapeHtml(job.duration_ms)} ms`}</span><button class="rerun-command" type="button" data-command="${escapeHtml(job.command)}" title="重新执行此命令">↻</button></div></article>`).join("")}`;
  for (const button of ledger.querySelectorAll(".rerun-command")) button.addEventListener("click", () => { $("#commandInput").value = button.dataset.command; $("#terminalForm").requestSubmit(); });
}

function renderTerminalOutput() {
  const terminal = state.terminals.get(state.activeTerminal); const output = $("#terminalOutput");
  if (!terminal) { output.hidden = false; output.textContent = "尚无终端。执行第一条命令时会自动创建。"; renderTerminalLedger(); return; }
  const text = terminal.jobs.map((job) => {
    if (job.status === "queued" || job.status === "running") return `$ ${job.command}\n${job.stdout || ""}${job.stderr || ""}[${job.status === "queued" ? "等待执行" : `运行中，超时 ${job.timeout_seconds} 秒`}]\n`;
    const stdout = job.stdout || ""; const stderr = job.stderr || ""; const truncated = job.truncated ? "\n[输出已截断]" : "";
    return `$ ${job.command}\n${stdout}${stderr}${truncated}\n[${job.status}, exit ${job.exit_status}, ${job.duration_ms ?? "?"} ms]\n`;
  }).join("\n");
  output.hidden = false; output.textContent = text || "该终端尚未执行命令。"; output.scrollTop = output.scrollHeight; renderTerminalLedger();
}

async function syncTerminals() {
  if (!state.session) return;
  const data = await request(`/api/v1/sessions/${encodeURIComponent(state.session)}/terminals`);
  const seen = new Set();
  for (const summary of data.terminals) {
    seen.add(summary.terminal_id); let terminal = state.terminals.get(summary.terminal_id);
    if (!terminal) { terminal = { ...summary, jobs: [] }; state.terminals.set(summary.terminal_id, terminal); }
    terminal.index = summary.index; terminal.busy = summary.busy; terminal.current_job_id = summary.current_job_id;
    const jobs = [];
    for (const jobSummary of summary.jobs) {
      const previous = terminal.jobs.find((job) => job.job_id === jobSummary.job_id);
      const liveJob = RcbJobStream.mergeJobSummary(previous, jobSummary);
      jobs.push(liveJob);
      if (jobSummary.status === "queued" || jobSummary.status === "running") subscribeJob(liveJob.job_id, summary.terminal_id);
      else closeJobStream(jobSummary.job_id);
    }
    terminal.jobs = jobs;
  }
  for (const id of [...state.terminals.keys()]) if (!seen.has(id)) state.terminals.delete(id);
  if (!state.activeTerminal || !state.terminals.has(state.activeTerminal)) state.activeTerminal = [...state.terminals.values()].sort((a, b) => a.index - b.index)[0]?.terminal_id || null;
  renderTerminalTabs(); renderTerminalOutput(); renderJobOverview();
}

function findJob(jobId) {
  for (const terminal of state.terminals.values()) {
    const job = terminal.jobs.find((item) => item.job_id === jobId);
    if (job) return { terminal, job };
  }
  return null;
}

function closeJobStream(jobId) {
  const source = state.eventSources.get(jobId);
  if (source) source.close();
  state.eventSources.delete(jobId);
}

function subscribeJob(jobId, terminalId) {
  if (state.eventSources.has(jobId) || !state.session) return;
  const source = new EventSource(`/api/v1/sessions/${encodeURIComponent(state.session)}/jobs/${encodeURIComponent(jobId)}/events`);
  state.eventSources.set(jobId, source);
  source.addEventListener("snapshot", (event) => {
    const snapshot = JSON.parse(event.data); const found = findJob(jobId);
    if (found && RcbJobStream.acceptJobEvent(found.job, event)) { Object.assign(found.job, snapshot); renderTerminalOutput(); }
  });
  for (const stream of ["stdout", "stderr"]) source.addEventListener(stream, (event) => {
    const found = findJob(jobId); if (!found) return;
    if (!RcbJobStream.acceptJobEvent(found.job, event)) return;
    found.job[stream] = (found.job[stream] || "") + JSON.parse(event.data).chunk;
    if (found.terminal.terminal_id === state.activeTerminal) renderTerminalOutput();
  });
  source.addEventListener("status", (event) => {
    const found = findJob(jobId); if (!found) return;
    if (!RcbJobStream.acceptJobEvent(found.job, event)) return;
    found.job.status = JSON.parse(event.data).status; renderTerminalTabs(); renderTerminalOutput();
  });
  source.addEventListener("end", async (event) => { const found = findJob(jobId); if (found) RcbJobStream.acceptJobEvent(found.job, event); closeJobStream(jobId); try { await syncTerminals(); } catch (_) {} });
  source.onerror = () => { /* EventSource reconnects; polling remains the fallback. */ };
}

function startTerminalPolling() {
  clearTimeout(state.pollTimer);
  const poll = async () => { if (!state.session) return; try { await syncTerminals(); } catch (error) { if (error.status === 404) { clearSessionState(); showNotice("SSH 会话已失效，请重新连接一次。"); return; } showNotice(`终端同步失败：${error.message}`); } state.pollTimer = setTimeout(poll, 1500); };
  poll();
}

async function runCommand(event) {
  event.preventDefault(); if (!state.session || state.commandSubmitting) return; const command = $("#commandInput").value; if (!command.trim()) return;
  state.commandSubmitting = true;
  const payload = { command, timeout_seconds: Number($("#commandTimeout").value), new_terminal: state.forceNewTerminal };
  if (state.activeTerminal && !state.forceNewTerminal) payload.terminal_id = state.activeTerminal;
  $("#runCommand").disabled = true;
  try {
    const result = await request(`/api/v1/sessions/${encodeURIComponent(state.session)}/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    rememberCommand(command); state.activeTerminal = result.terminal_id; state.forceNewTerminal = false; $("#newTerminal").classList.remove("selected"); $("#newTerminal").setAttribute("aria-pressed", "false"); $("#commandInput").value = ""; await syncTerminals();
  } catch (error) { showNotice(`命令提交失败：${error.message}`); }
  finally { state.commandSubmitting = false; $("#runCommand").disabled = false; }
}

function requestNewTerminal() { state.forceNewTerminal = !state.forceNewTerminal; $("#newTerminal").classList.toggle("selected", state.forceNewTerminal); $("#newTerminal").setAttribute("aria-pressed", String(state.forceNewTerminal)); }

function renderCommandHistory() { $("#commandHistory").innerHTML = state.commandHistory.map((command) => `<option value="${escapeHtml(command)}"></option>`).join(""); }
function rememberCommand(command) {
  const value = command.trim(); if (!value) return;
  state.commandHistory = [value, ...state.commandHistory.filter((item) => item !== value)].slice(0, 30);
  state.historyCursor = -1; renderCommandHistory();
}
function navigateCommandHistory(event) {
  if (!state.commandHistory.length || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  if (event.key === "ArrowUp") state.historyCursor = Math.min(state.commandHistory.length - 1, state.historyCursor + 1);
  else state.historyCursor = Math.max(-1, state.historyCursor - 1);
  $("#commandInput").value = state.historyCursor < 0 ? "" : state.commandHistory[state.historyCursor];
}

async function stopCurrentCommand() {
  const terminal = state.terminals.get(state.activeTerminal);
  if (!state.session || !terminal?.current_job_id) return;
  $("#stopCommand").disabled = true;
  try {
    await request(`/api/v1/sessions/${encodeURIComponent(state.session)}/jobs/${encodeURIComponent(terminal.current_job_id)}`, { method: "DELETE" });
    showNotice("已请求停止当前任务…");
  } catch (error) { showNotice(`停止任务失败：${error.message}`); }
}

async function toggleAgent() {
  if (!state.session) return; const enabled = $("#agentEnabled").checked; $("#agentEnabled").disabled = true;
  try { await request(`/api/v1/sessions/${encodeURIComponent(state.session)}/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }); saveActiveSession(enabled); if (!enabled) { clearTimeout(state.taskStatusTimer); state.taskStatusTimer = null; clearTimeout(state.taskLogTimer); state.taskLogTimer = null; state.taskLoaded = false; state.taskStatusError = null; renderTaskObserverState(); $("#taskCapabilitySummary").textContent = "本地 Agent 权限已关闭"; } else if (state.workspaceView === "tasks") refreshTaskCenter({ resetHistory: true }); showNotice(enabled ? "已允许本地 Agent 使用当前 SSH 会话" : "已撤销本地 Agent 权限"); }
  catch (error) { $("#agentEnabled").checked = !enabled; showNotice(`Agent 授权失败：${error.message}`); }
  finally { $("#agentEnabled").disabled = false; }
}

async function disconnect() {
  if (!state.session) return; try { await request(`/api/v1/sessions/${encodeURIComponent(state.session)}`, { method: "DELETE" }); } catch (_) {}
  clearSessionState();
  $("#hostTitle").textContent = "尚未连接"; $("#hostMeta").textContent = ""; $("#dashboard").innerHTML = ""; $("#terminalTabs").innerHTML = ""; renderTerminalOutput(); showNotice("会话已断开");
}

async function activateRestoredSession(sessionId, status, { agentEnabled = true, message = "已恢复 SSH 会话" } = {}) {
  state.session = sessionId; state.terminals.clear(); state.activeTerminal = null; state.commandHistory = []; state.historyCursor = -1; state.currentDirectory = "."; state.openDirectories = new Set(["."]); state.fileTreeCache.clear(); clearFileEditor(); updateCurrentDirectory(); resetTaskState(); loadTerminalLabels(); state.monitoringPaused = false;
  connected(true); $("#agentEnabled").checked = agentEnabled; saveActiveSession(agentEnabled); renderStatus(status); $("#lastRefresh").textContent = `恢复于 ${new Date().toLocaleTimeString()}`;
  await syncTerminals(); startTerminalPolling(); scheduleMonitoring(); await listFiles(); await refreshTransfers();
  showNotice(message); return true;
}

async function restoreAgentSession() {
  try {
    const agent = await request("/api/v1/agent/session");
    const status = await request(`/api/v1/sessions/${encodeURIComponent(agent.session)}/status`);
    return activateRestoredSession(agent.session, status, { agentEnabled: true, message: "已恢复本机 Agent 授权的 SSH 会话" });
  } catch { return false; }
}

async function restoreBrowserSession() {
  try {
    const recovered = await request("/api/v1/sessions/recover");
    return activateRestoredSession(recovered.session, recovered.status, { agentEnabled: recovered.agent_enabled === true, message: "已恢复浏览器保留的 SSH 会话" });
  } catch { return false; }
}

async function restoreActiveSession() {
  if (await restoreBrowserSession()) return true;
  const saved = readActiveSession();
  if (!saved?.session) return restoreAgentSession();
  try {
    const status = await request(`/api/v1/sessions/${encodeURIComponent(saved.session)}/status`);
    return activateRestoredSession(saved.session, status, { agentEnabled: saved.agentEnabled !== false, message: "已恢复刷新前的 SSH 会话" });
  } catch (error) {
    if (error.status === 404) forgetActiveSession();
    if (await restoreAgentSession()) return true;
    showNotice(error.status === 404 ? "原 SSH 会话已失效，请重新连接" : `SSH 会话恢复失败：${error.message}`); return false;
  }
}

async function init() {
  try { await request("/api/v1/health"); $("#health").textContent = "本地服务在线"; }
  catch (error) { $("#health").textContent = `服务不可用：${error.message}`; }
  if (!(await restoreActiveSession())) renderTerminalOutput();
}

$("#connectForm").addEventListener("submit", connect); $("#authMethod").addEventListener("change", updateAuthMethod); $("#refresh").addEventListener("click", refresh); $("#refreshInterval").addEventListener("change", updateRefreshSchedule); $("#pauseMonitoring").addEventListener("click", toggleMonitoringPause); $("#readLog").addEventListener("click", readLog);
$("#refreshTasks").addEventListener("click", () => refreshTaskCenter({ resetHistory: true })); $("#loadMoreTasks").addEventListener("click", () => refreshTaskCenter({ resetHistory: false })); $("#taskStatusFilter").addEventListener("change", () => { if (state.taskMode === "history") refreshTaskCenter({ resetHistory: true }); }); $("#previewTaskCleanup").addEventListener("click", previewTaskCleanup); $("#pinTask").addEventListener("click", toggleSelectedTaskPin); $("#cancelTask").addEventListener("click", cancelSelectedTask); $("#reloadTaskLog").addEventListener("click", () => loadTaskLogs({ reset: true })); $("#taskLogStream").addEventListener("change", () => loadTaskLogs({ reset: true })); $("#taskLogFollow").addEventListener("change", scheduleTaskLogPolling); for (const button of document.querySelectorAll(".task-mode")) button.addEventListener("click", () => setTaskMode(button.dataset.taskMode));
$("#terminalForm").addEventListener("submit", runCommand); $("#newTerminal").addEventListener("click", requestNewTerminal); $("#renameTerminal").addEventListener("click", renameActiveTerminal); $("#stopCommand").addEventListener("click", stopCurrentCommand); $("#agentEnabled").addEventListener("change", toggleAgent); $("#disconnect").addEventListener("click", disconnect); $("#listFiles").addEventListener("click", listFiles); $("#parentFolder").addEventListener("click", openParentFolder); $("#newFolder").addEventListener("click", newFolder); $("#downloadFile").addEventListener("click", downloadFile); $("#renameFile").addEventListener("click", renameFile); $("#deleteFile").addEventListener("click", deleteFile); $("#chooseTransferFiles").addEventListener("click", () => $("#transferFileInput").click()); $("#chooseTransferFolder").addEventListener("click", () => $("#transferFolderInput").click()); $("#transferFileInput").addEventListener("change", (event) => { queueTransfers([...event.target.files]); event.target.value = ""; }); $("#transferFolderInput").addEventListener("change", (event) => { queueTransfers([...event.target.files]); event.target.value = ""; }); $("#refreshTransfers").addEventListener("click", refreshTransfers); $("#minimizeTransfers").addEventListener("click", toggleTransferPanel); $("#closeTransfers").addEventListener("click", closeTransferPanel); $("#showTransfers").addEventListener("click", showTransferPanel); $("#saveFile").addEventListener("click", saveFile); $("#toggleFileView").addEventListener("click", toggleFileView); $("#fileContent").addEventListener("input", renderFileEditor); $("#fileImagePreview").addEventListener("error", () => { if (state.fileEditorKind === "image") showNotice("图片预览失败：文件格式不受支持、文件过大或远程文件不可读"); }); $("#savedProfile").addEventListener("change", applyProfile); $("#deleteProfile").addEventListener("click", deleteProfile); connected(false); renderProfiles(); updateAuthMethod(); updateCurrentDirectory(); renderTransferQueue(); init();
$("#commandInput").addEventListener("keydown", navigateCommandHistory);
for (const tab of document.querySelectorAll(".workspace-tab")) tab.addEventListener("click", () => setWorkspaceView(tab.dataset.view));
