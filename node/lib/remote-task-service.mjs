import crypto from "node:crypto";
import path from "node:path";
import { renderDetachedCancelCommand, renderDetachedLaunchCommand, renderDetachedTaskWrapper } from "./detached-task-wrapper.mjs";

const TASK_ROOT = ".remote-control-bridge/tasks";
const FINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const REMOTE_RETENTION_DAYS = 30;
const REMOTE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
const REMOTE_SCAN_MAX_TASKS = 10000;
const REMOTE_SCAN_MAX_ENTRIES = 100000;
const TASK_RECORD_FILES = new Set(["task.json", "status.json", "launch.sh", "exit-code", "logging-degraded", "cancel-requested", "pinned", "pinned.json"]);
const TASK_LOG_FILE = /^(?:stdout|stderr)\.\d{20}\.log$/;
const LAUNCHERS = new Set(["auto", "systemd-run-user", "setsid-nohup"]);
const SENSITIVE_ARGUMENT = /^--?(?:access[-_]?key|api[-_]?key|credential|password|passwd|private[-_]?key|secret|token)(?:=|$)/i;

function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }

function safeRelative(value, name, allowDot = false) {
  if (typeof value !== "string" || (!allowDot && !value) || value.includes("\\") || value.includes("\0") || value.split("/").includes("..") || path.posix.isAbsolute(value)) throw new Error(`${name} must be a safe relative POSIX path`);
  if (!allowDot && value === ".") throw new Error(`${name} cannot be the remote root`);
  return value || ".";
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}

function parseTaskId(taskId) {
  const match = typeof taskId === "string" && taskId.match(/^task-(\d{4})(\d{2})(\d{2})-([a-z0-9]{12,48})$/i);
  if (!match) throw new Error("task_id must contain an encoded UTC date");
  return { taskId, year: match[1], month: match[2], day: match[3] };
}

function taskPaths(taskId) {
  const parsed = parseTaskId(taskId);
  const relativeDir = path.posix.join("history", parsed.year, parsed.month, parsed.day, taskId);
  const taskDir = path.posix.join(TASK_ROOT, relativeDir);
  return { ...parsed, relativeDir, taskDir, activeMarker: path.posix.join(TASK_ROOT, "active", `${taskId}.json`) };
}

function taskIdFor(date, randomBytes) {
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `task-${day}-${randomBytes(9).toString("hex")}`;
}

function displayCommand(argv) { return argv.map((value) => /[^a-z0-9_./:@%+=,-]/i.test(value) ? shellQuote(value) : value).join(" "); }

function taskResourceHints(environment) {
  if (!environment || !Object.prototype.hasOwnProperty.call(environment, "CUDA_VISIBLE_DEVICES")) return null;
  const value = environment.CUDA_VISIBLE_DEVICES;
  if (typeof value !== "string") return { gpu_visibility: "unresolved" };
  const normalized = value.trim();
  if (!normalized || /^(?:-1|none|void)$/i.test(normalized)) return { gpu_visibility: "none", gpu_devices: [] };
  if (/^all$/i.test(normalized)) return { gpu_visibility: "all" };
  const selectors = normalized.split(",").map((selector) => selector.trim()).filter(Boolean);
  if (selectors.length && selectors.length <= 256 && selectors.every((selector) => /^\d{1,4}$/.test(selector) && Number(selector) <= 1024)) {
    return { gpu_visibility: "restricted", gpu_devices: [...new Set(selectors.map(Number))] };
  }
  return { gpu_visibility: "unresolved", gpu_selector_count: Math.min(selectors.length, 256) };
}

export function parsePersistentTaskRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task request must be an object");
  if (!Array.isArray(value.argv) || !value.argv.length || value.argv.length > 256) throw new Error("argv must contain between 1 and 256 arguments");
  let total = 0;
  const argv = value.argv.map((argument) => {
    if (typeof argument !== "string" || !argument || argument.includes("\0") || argument.length > 4096) throw new Error("argv entries must be non-empty strings of at most 4096 characters");
    if (SENSITIVE_ARGUMENT.test(argument)) throw new Error("sensitive command arguments cannot be persisted");
    total += Buffer.byteLength(argument);
    return argument;
  });
  if (total > 65536) throw new Error("argv is too large");
  const launcher = value.launcher == null ? "auto" : value.launcher;
  if (!LAUNCHERS.has(launcher)) throw new Error("launcher must be auto, systemd-run-user, or setsid-nohup");
  const workdir = safeRelative(value.workdir || ".", "workdir", true);
  const environment = value.environment == null ? {} : value.environment;
  if (!environment || typeof environment !== "object" || Array.isArray(environment) || Object.keys(environment).length > 64) throw new Error("environment must be an object with at most 64 entries");
  const segmentBytes = value.segment_bytes == null ? 32 * 1024 * 1024 : integer(value.segment_bytes, "segment_bytes", 64 * 1024, 64 * 1024 * 1024);
  const stdoutSegments = value.stdout_segments == null ? 3 : integer(value.stdout_segments, "stdout_segments", 1, 64);
  const stderrSegments = value.stderr_segments == null ? 1 : integer(value.stderr_segments, "stderr_segments", 1, 64);
  const tags = value.tags == null ? [] : value.tags;
  if (!Array.isArray(tags) || tags.length > 16 || tags.some((tag) => typeof tag !== "string" || tag.length > 64)) throw new Error("tags must contain at most 16 short strings");
  return { argv, launcher, workdir, environment, segmentBytes, stdoutSegments, stderrSegments, tags };
}

function parseCapabilities(output) {
  const values = Object.fromEntries(String(output || "").split(/\r?\n/).map((line) => line.split("=", 2)).filter((parts) => parts.length === 2));
  const required = ["bash", "dd", "cat", "mkfifo", "wc", "ps", "awk", "date", "mv", "rm", "chmod"];
  const baseAvailable = required.every((name) => values[name] === "1");
  const linger = values.linger === "yes";
  const systemdAvailable = baseAvailable && values.systemd_run === "1" && values.systemctl === "1" && values.systemd_user === "running";
  const setsidAvailable = baseAvailable && values.setsid === "1" && values.nohup === "1";
  return {
    base_available: baseAvailable,
    launchers: {
      "systemd-run-user": { available: systemdAvailable, reliability: systemdAvailable && linger ? "persistent" : systemdAvailable ? "best_effort" : "unavailable", linger },
      "setsid-nohup": { available: setsidAvailable, reliability: setsidAvailable ? "best_effort" : "unavailable" },
    },
  };
}

function capabilityCommand() {
  return `for name in bash dd cat mkfifo wc ps awk date mv rm chmod setsid nohup; do if command -v "$name" >/dev/null 2>&1; then printf '%s=1\\n' "$name"; else printf '%s=0\\n' "$name"; fi; done; if command -v systemd-run >/dev/null 2>&1; then printf 'systemd_run=1\\n'; else printf 'systemd_run=0\\n'; fi; if command -v systemctl >/dev/null 2>&1; then printf 'systemctl=1\\n'; state="$(systemctl --user is-system-running 2>/dev/null || true)"; printf 'systemd_user=%s\\n' "$state"; else printf 'systemctl=0\\nsystemd_user=unavailable\\n'; fi; linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || printf unknown)"; printf 'linger=%s\\n' "$linger"`;
}

function selectLauncher(requested, capabilities) {
  if (requested === "systemd-run-user" && !capabilities.launchers[requested].available) throw new Error("systemd-run-user is unavailable");
  if (requested === "setsid-nohup" && !capabilities.launchers[requested].available) throw new Error("setsid-nohup is unavailable");
  if (requested !== "auto") return requested;
  if (capabilities.launchers["systemd-run-user"].available) return "systemd-run-user";
  if (capabilities.launchers["setsid-nohup"].available) return "setsid-nohup";
  throw new Error("no persistent task launcher is available");
}

function validateRemoteRecord(manifest, status, taskId) {
  if (!manifest || manifest.schema_version !== 1 || manifest.task_id !== taskId) throw new Error("invalid remote task manifest");
  if (!status || status.schema_version !== 1 || status.task_id !== taskId || typeof status.status !== "string") throw new Error("invalid remote task status");
  return { manifest, status };
}

function processIdentityCommand(status) {
  const values = [status.wrapper_pid, status.wrapper_process_start_ticks, status.pgid, status.process_start_ticks];
  if (!values.every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("task status does not contain a complete process identity");
  return `WRAPPER=${status.wrapper_pid}; PID=${status.pgid}; printf 'boot_id=%s\\n' "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf unknown)"; if [ -r "/proc/$WRAPPER/stat" ]; then printf 'wrapper_exists=1\\nwrapper_pgid=%s\\nwrapper_start_ticks=%s\\n' "$(ps -o pgid= -p "$WRAPPER" 2>/dev/null | tr -d ' ')" "$(awk '{print $22}' "/proc/$WRAPPER/stat" 2>/dev/null)"; else printf 'wrapper_exists=0\\n'; fi; if [ -r "/proc/$PID/stat" ]; then printf 'process_exists=1\\nprocess_pgid=%s\\nprocess_start_ticks=%s\\n' "$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d ' ')" "$(awk '{print $22}' "/proc/$PID/stat" 2>/dev/null)"; else printf 'process_exists=0\\n'; fi`;
}

function parseIdentity(output) { return Object.fromEntries(String(output || "").split(/\r?\n/).map((line) => line.split("=", 2)).filter((parts) => parts.length === 2)); }

function missing(error) { return [2, "ENOENT"].includes(error?.code); }

function statusCounts(records) {
  const counts = new Map();
  for (const record of records) {
    const current = counts.get(record.status.status) || { status: record.status.status, count: 0, bytes: 0 };
    current.count += 1;
    current.bytes += record.bytes;
    counts.set(current.status, current);
  }
  return [...counts.values()].sort((a, b) => a.status.localeCompare(b.status));
}

export class RemoteTaskService {
  constructor({ remote, now = () => new Date(), randomBytes = crypto.randomBytes, capabilityTtlMs = 60000, index = null, ownerKey = null, recordDeletionEnabled = false }) {
    this.remote = remote;
    this.now = now;
    this.randomBytes = randomBytes;
    this.capabilityTtlMs = capabilityTtlMs;
    this.capabilityCache = null;
    this.index = index;
    this.ownerKey = ownerKey;
    this.recordDeletionEnabled = recordDeletionEnabled === true;
    this.remoteStorageCache = null;
  }

  cache(record, options) { if (this.index && this.ownerKey) this.index.upsert(this.ownerKey, record, options); return record; }

  async capabilities({ refresh = false } = {}) {
    if (!refresh && this.capabilityCache && Date.now() - this.capabilityCache.checkedAt < this.capabilityTtlMs) return this.capabilityCache.value;
    const result = await this.remote.exec(capabilityCommand());
    if (result.code !== 0) throw new Error(`task capability probe failed: ${result.stderr || `exit ${result.code}`}`);
    const value = { ...parseCapabilities(result.stdout), checked_at: this.now().toISOString(), local_index_available: Boolean(this.index), remote_record_deletion_enabled: this.recordDeletionEnabled };
    this.capabilityCache = { checkedAt: Date.now(), value };
    return value;
  }

  async remoteNow() {
    const result = await this.remote.exec("date -u +%Y-%m-%dT%H:%M:%SZ");
    if (result.code !== 0) throw new Error(`remote UTC clock probe failed: ${result.stderr || `exit ${result.code}`}`);
    const value = String(result.stdout || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("remote UTC clock returned an invalid timestamp");
    return new Date(value);
  }

  async create(value) {
    const request = parsePersistentTaskRequest(value);
    const capabilities = await this.capabilities();
    const launcher = selectLauncher(request.launcher, capabilities);
    const remoteDate = await this.remoteNow();
    const createdAt = remoteDate.toISOString();
    const taskId = taskIdFor(remoteDate, this.randomBytes);
    const paths = taskPaths(taskId);
    const resources = taskResourceHints(request.environment);
    const manifest = {
      schema_version: 1,
      task_id: taskId,
      relative_dir: paths.relativeDir,
      created_at: createdAt,
      launcher,
      reliability: capabilities.launchers[launcher].reliability,
      workdir: request.workdir,
      display_command: displayCommand(request.argv),
      tags: request.tags,
      ...(resources ? { resources } : {}),
    };
    const status = { schema_version: 1, task_id: taskId, status: "queued", updated_at: createdAt };
    const active = { schema_version: 1, task_id: taskId, relative_dir: paths.relativeDir, status: "queued", updated_at: createdAt };
    const wrapper = renderDetachedTaskWrapper({
      taskId,
      taskDir: paths.taskDir,
      activeMarker: paths.activeMarker,
      workdir: request.workdir,
      argv: request.argv,
      environment: request.environment,
      segmentBytes: request.segmentBytes,
      stdoutSegments: request.stdoutSegments,
      stderrSegments: request.stderrSegments,
    });
    await this.remote.mkdir(paths.taskDir);
    await this.remote.mkdir(path.posix.dirname(paths.activeMarker));
    await this.remote.writeText(path.posix.join(paths.taskDir, "task.json"), `${JSON.stringify(manifest)}\n`);
    await this.remote.writeText(path.posix.join(paths.taskDir, "status.json"), `${JSON.stringify(status)}\n`);
    await this.remote.writeText(paths.activeMarker, `${JSON.stringify(active)}\n`);
    await this.remote.writeText(path.posix.join(paths.taskDir, "launch.sh"), wrapper);
    const wrapperPath = path.posix.join(paths.taskDir, "launch.sh");
    const unit = `rcb-${taskId}`;
    const command = launcher === "systemd-run-user"
      ? `systemd-run --user --unit=${unit} --no-block bash "$HOME/${wrapperPath}"`
      : renderDetachedLaunchCommand(wrapperPath);
    const launched = await this.remote.exec(command);
    if (launched.code !== 0) {
      const failed = { ...status, status: "failed", updated_at: this.now().toISOString(), error: launched.stderr || `launcher exited with ${launched.code}` };
      await this.remote.writeText(path.posix.join(paths.taskDir, "status.json"), `${JSON.stringify(failed)}\n`);
      await this.remote.remove(paths.activeMarker);
      throw new Error(failed.error);
    }
    this.cache({ manifest, status });
    return { manifest, status, launcher_output: launched.stdout.trim() || null };
  }

  async get(taskId) {
    const paths = taskPaths(taskId);
    const manifest = JSON.parse(await this.remote.readText(path.posix.join(paths.taskDir, "task.json"), 1024 * 1024));
    const status = JSON.parse(await this.remote.readText(path.posix.join(paths.taskDir, "status.json"), 1024 * 1024));
    const record = validateRemoteRecord(manifest, status, taskId);
    if (!FINAL_STATUSES.has(status.status) && await this.remote.exists(path.posix.join(paths.taskDir, "cancel-requested"))) record.status = { ...status, status: "cancelling" };
    record.pinned = await this.remote.exists(path.posix.join(paths.taskDir, "pinned.json")) || await this.remote.exists(path.posix.join(paths.taskDir, "pinned"));
    return this.cache(record);
  }

  async listActive() {
    let entries;
    try { entries = await this.remote.list(path.posix.join(TASK_ROOT, "active")); }
    catch (error) { if ([2, "ENOENT"].includes(error.code)) return { tasks: [], errors: [] }; throw error; }
    const tasks = [];
    const errors = [];
    for (const entry of entries.slice(0, 1000)) {
      if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
      const taskId = entry.name.slice(0, -5);
      try { tasks.push(await this.get(taskId)); }
      catch (error) { errors.push({ task_id: taskId, error: error.message }); }
    }
    tasks.sort((a, b) => b.manifest.created_at.localeCompare(a.manifest.created_at));
    return { tasks, errors };
  }

  async cancel(taskId) {
    const record = await this.get(taskId);
    if (FINAL_STATUSES.has(record.status.status)) return { ...record, cancellation_requested: false };
    const { pgid, boot_id: bootId, process_start_ticks: processStartTicks } = record.status;
    const paths = taskPaths(taskId);
    const command = renderDetachedCancelCommand({ taskDir: paths.taskDir, pgid, bootId, processStartTicks });
    const result = await this.remote.exec(command);
    if (result.code !== 0) throw new Error(`task cancellation failed: ${result.stderr || `exit ${result.code}`}`);
    const response = { ...record, status: { ...record.status, status: "cancelling" }, cancellation_requested: true };
    this.cache(response);
    return response;
  }

  async pin(taskId) {
    const record = await this.get(taskId);
    const paths = taskPaths(taskId);
    const pinnedAt = (await this.remoteNow()).toISOString();
    await this.remote.writeText(path.posix.join(paths.taskDir, "pinned.json"), `${JSON.stringify({ schema_version: 1, task_id: taskId, pinned_at: pinnedAt })}\n`);
    const response = { ...record, pinned: true, pinned_at: pinnedAt };
    this.remoteStorageCache = null;
    return this.cache(response);
  }

  async unpin(taskId) {
    const record = await this.get(taskId);
    const paths = taskPaths(taskId);
    await this.remote.remove(path.posix.join(paths.taskDir, "pinned.json"));
    await this.remote.remove(path.posix.join(paths.taskDir, "pinned"));
    const response = { ...record, pinned: false };
    this.remoteStorageCache = null;
    return this.cache(response);
  }

  async deleteRecord(taskId, confirmation) {
    if (!this.recordDeletionEnabled) { const error = new Error("remote task record deletion is disabled"); error.status_code = 404; throw error; }
    if (!confirmation || confirmation.confirm_task_id !== taskId || confirmation.delete_scope !== "bridge_task_record_only") { const error = new Error("record deletion requires confirm_task_id and delete_scope=bridge_task_record_only"); error.status_code = 400; throw error; }
    const record = await this.get(taskId);
    if (!FINAL_STATUSES.has(record.status.status)) { const error = new Error("only completed, failed, or cancelled task records can be deleted"); error.status_code = 409; throw error; }
    if (record.pinned) { const error = new Error("pinned task records cannot be deleted"); error.status_code = 409; throw error; }
    const paths = taskPaths(taskId);
    if (await this.remote.exists(paths.activeMarker)) { const error = new Error("task record still has an active marker"); error.status_code = 409; throw error; }
    const entries = await this.remote.list(paths.taskDir);
    if (entries.length > 1000) { const error = new Error("task record contains too many entries for explicit deletion"); error.status_code = 409; throw error; }
    for (const entry of entries) {
      if (entry.type !== "file" || (!TASK_RECORD_FILES.has(entry.name) && !TASK_LOG_FILE.test(entry.name))) { const error = new Error(`task record contains an unsupported entry: ${entry.name}`); error.status_code = 409; throw error; }
    }
    const removedBytes = entries.reduce((sum, entry) => sum + Number(entry.size || 0), 0);
    for (const entry of entries) await this.remote.remove(path.posix.join(paths.taskDir, entry.name));
    await this.remote.removeDirectory(paths.taskDir);
    const localIndexRemoved = this.index && this.ownerKey ? this.index.remove(this.ownerKey, taskId) : false;
    this.remoteStorageCache = null;
    return { task_id: taskId, deleted: true, delete_scope: "bridge_task_record_only", remote_files_removed: entries.length, remote_bytes_removed: removedBytes, local_index_removed: localIndexRemoved, user_artifacts_removed: 0 };
  }

  history(options = {}) {
    if (!this.index || !this.ownerKey) { const error = new Error("local task history index is unavailable on this Node.js runtime"); error.status_code = 501; throw error; }
    return this.index.list(this.ownerKey, options);
  }

  async scanRemoteStorage({ refresh = false } = {}) {
    if (!refresh && this.remoteStorageCache && Date.now() - this.remoteStorageCache.checkedAt < 60000) return this.remoteStorageCache.value;
    const errors = [];
    const records = [];
    const activeTaskIds = new Set();
    let activeMarkerBytes = 0;
    let activeMarkerCount = 0;
    let scannedEntries = 0;
    let truncated = false;
    let unrecognizedEntries = 0;
    let unresolvedTaskCount = 0;
    let unresolvedTaskBytes = 0;
    const boundedList = async (target) => {
      if (truncated) return [];
      let entries;
      try { entries = await this.remote.list(target); }
      catch (error) { if (missing(error)) return []; throw error; }
      const remaining = REMOTE_SCAN_MAX_ENTRIES - scannedEntries;
      if (entries.length > remaining) { truncated = true; entries = entries.slice(0, Math.max(0, remaining)); }
      scannedEntries += entries.length;
      return entries;
    };

    const rootEntries = await boundedList(TASK_ROOT);
    for (const entry of rootEntries) if (!((entry.name === "active" || entry.name === "history") && entry.type === "directory")) unrecognizedEntries += 1;

    for (const entry of await boundedList(path.posix.join(TASK_ROOT, "active"))) {
      if (entry.type !== "file" || !entry.name.endsWith(".json")) { unrecognizedEntries += 1; continue; }
      const currentTaskId = entry.name.slice(0, -5);
      try { parseTaskId(currentTaskId); }
      catch { unrecognizedEntries += 1; continue; }
      activeTaskIds.add(currentTaskId);
      activeMarkerCount += 1;
      activeMarkerBytes += Number(entry.size || 0);
    }

    outer: for (const yearEntry of await boundedList(path.posix.join(TASK_ROOT, "history"))) {
      if (yearEntry.type !== "directory" || !/^\d{4}$/.test(yearEntry.name)) { unrecognizedEntries += 1; continue; }
      for (const monthEntry of await boundedList(path.posix.join(TASK_ROOT, "history", yearEntry.name))) {
        if (monthEntry.type !== "directory" || !/^(?:0[1-9]|1[0-2])$/.test(monthEntry.name)) { unrecognizedEntries += 1; continue; }
        for (const dayEntry of await boundedList(path.posix.join(TASK_ROOT, "history", yearEntry.name, monthEntry.name))) {
          if (dayEntry.type !== "directory" || !/^(?:0[1-9]|[12]\d|3[01])$/.test(dayEntry.name)) { unrecognizedEntries += 1; continue; }
          const dayPath = path.posix.join(TASK_ROOT, "history", yearEntry.name, monthEntry.name, dayEntry.name);
          for (const taskEntry of await boundedList(dayPath)) {
            if (records.length >= REMOTE_SCAN_MAX_TASKS) { truncated = true; break outer; }
            if (taskEntry.type !== "directory") { unrecognizedEntries += 1; continue; }
            let parsed;
            try { parsed = parseTaskId(taskEntry.name); }
            catch { unrecognizedEntries += 1; continue; }
            if (parsed.year !== yearEntry.name || parsed.month !== monthEntry.name || parsed.day !== dayEntry.name) { unrecognizedEntries += 1; continue; }
            const taskDir = path.posix.join(dayPath, taskEntry.name);
            let bytes = 0;
            try {
              const entries = await boundedList(taskDir);
              const files = entries.filter((entry) => entry.type === "file");
              const nestedDirectories = entries.length - files.length;
              bytes = files.reduce((sum, entry) => sum + Number(entry.size || 0), 0);
              const manifest = JSON.parse(await this.remote.readText(path.posix.join(taskDir, "task.json"), 1024 * 1024));
              const status = JSON.parse(await this.remote.readText(path.posix.join(taskDir, "status.json"), 1024 * 1024));
              validateRemoteRecord(manifest, status, taskEntry.name);
              records.push({
                task_id: taskEntry.name,
                relative_dir: path.posix.join("history", yearEntry.name, monthEntry.name, dayEntry.name, taskEntry.name),
                created_at: manifest.created_at,
                status,
                bytes,
                file_count: files.length,
                active_marker: activeTaskIds.has(taskEntry.name),
                pinned: files.some((entry) => entry.name === "pinned" || entry.name === "pinned.json"),
              });
              if (nestedDirectories) unrecognizedEntries += nestedDirectories;
            } catch (error) {
              unresolvedTaskCount += 1;
              unresolvedTaskBytes += bytes;
              errors.push({ task_id: taskEntry.name, error: error.message });
            }
          }
        }
      }
    }

    const taskBytes = records.reduce((sum, record) => sum + record.bytes, 0);
    const value = {
      root: TASK_ROOT,
      task_count: records.length,
      task_bytes: taskBytes,
      unresolved_task_count: unresolvedTaskCount,
      unresolved_task_bytes: unresolvedTaskBytes,
      active_marker_count: activeMarkerCount,
      active_marker_bytes: activeMarkerBytes,
      managed_bytes: taskBytes + unresolvedTaskBytes + activeMarkerBytes,
      statuses: statusCounts(records),
      scanned_entries: scannedEntries,
      max_tasks: REMOTE_SCAN_MAX_TASKS,
      max_entries: REMOTE_SCAN_MAX_ENTRIES,
      complete: !truncated && errors.length === 0,
      truncated,
      unrecognized_entries: unrecognizedEntries,
      errors,
      records,
      checked_at: this.now().toISOString(),
    };
    this.remoteStorageCache = { checkedAt: Date.now(), value };
    return value;
  }

  async storage({ refresh = false } = {}) {
    if (!this.index || !this.ownerKey) { const error = new Error("local task history index is unavailable on this Node.js runtime"); error.status_code = 501; throw error; }
    const remote = await this.scanRemoteStorage({ refresh });
    const { records, ...remoteStore } = remote;
    return { local_index: await this.index.stats(this.ownerKey), remote_store: remoteStore, remote_cleanup_enabled: false, remote_record_deletion_enabled: this.recordDeletionEnabled };
  }

  async cleanupPreview({ refresh = false, retentionDays = REMOTE_RETENTION_DAYS, quotaBytes = REMOTE_QUOTA_BYTES, limit = 100 } = {}) {
    integer(retentionDays, "retention_days", 1, 3650);
    integer(quotaBytes, "quota_bytes", 1024 * 1024, 1024 * 1024 * 1024 * 1024);
    integer(limit, "limit", 1, 500);
    const snapshot = await this.scanRemoteStorage({ refresh });
    const remoteTimestamp = await this.remoteNow();
    const cutoff = new Date(remoteTimestamp.getTime() - retentionDays * 86400000);
    const eligible = snapshot.records.filter((record) => FINAL_STATUSES.has(record.status.status) && !record.active_marker && !record.pinned && Number.isFinite(Date.parse(record.created_at))).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id));
    const selected = new Map();
    for (const record of eligible) if (Date.parse(record.created_at) < cutoff.getTime()) selected.set(record.task_id, { record, reasons: ["retention_expired"] });
    let projectedBytes = snapshot.managed_bytes - [...selected.values()].reduce((sum, item) => sum + item.record.bytes, 0);
    if (projectedBytes > quotaBytes) {
      for (const record of eligible) {
        if (projectedBytes <= quotaBytes) break;
        const existing = selected.get(record.task_id);
        if (existing) { if (!existing.reasons.includes("quota_exceeded")) existing.reasons.push("quota_exceeded"); continue; }
        selected.set(record.task_id, { record, reasons: ["quota_exceeded"] });
        projectedBytes -= record.bytes;
      }
    }
    const candidates = [...selected.values()].map(({ record, reasons }) => ({ task_id: record.task_id, status: record.status.status, created_at: record.created_at, bytes: record.bytes, reasons }));
    const eligibleTaskIds = new Set(eligible.map((record) => record.task_id));
    const protectedRecords = snapshot.records.filter((record) => !eligibleTaskIds.has(record.task_id));
    return {
      dry_run: true,
      deletion_enabled: this.recordDeletionEnabled,
      scan_complete: snapshot.complete,
      checked_at: remoteTimestamp.toISOString(),
      policy: { retention_days: retentionDays, quota_bytes: quotaBytes },
      managed_bytes: snapshot.managed_bytes,
      candidate_count: candidates.length,
      candidate_bytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
      projected_managed_bytes: Math.max(0, projectedBytes),
      quota_satisfied: projectedBytes <= quotaBytes,
      projected_over_quota_bytes: Math.max(0, projectedBytes - quotaBytes),
      protected_count: protectedRecords.length + snapshot.unresolved_task_count,
      protected: {
        active_marker: protectedRecords.filter((record) => record.active_marker).length,
        pinned: protectedRecords.filter((record) => record.pinned).length,
        non_final_or_unresolved: protectedRecords.filter((record) => !FINAL_STATUSES.has(record.status.status)).length,
        invalid_timestamp: protectedRecords.filter((record) => !Number.isFinite(Date.parse(record.created_at))).length,
        unresolved_record: snapshot.unresolved_task_count,
      },
      candidates: candidates.slice(0, limit),
      candidates_truncated: candidates.length > limit,
      scan_errors: snapshot.errors,
      remote_records_removed: 0,
    };
  }

  maintenance() {
    if (!this.index || !this.ownerKey) { const error = new Error("local task history index is unavailable on this Node.js runtime"); error.status_code = 501; throw error; }
    return { local_index: this.index.maintain(this.ownerKey), remote_records_removed: 0 };
  }

  async reconcile() {
    let listing;
    try { listing = await this.remote.list(path.posix.join(TASK_ROOT, "active")); }
    catch (error) { if ([2, "ENOENT"].includes(error.code)) return { checked: 0, running: 0, updated: 0, errors: [] }; throw error; }
    const summary = { checked: 0, running: 0, updated: 0, errors: [] };
    for (const entry of listing.slice(0, 1000)) {
      if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
      const currentTaskId = entry.name.slice(0, -5);
      summary.checked += 1;
      try {
        let record = await this.get(currentTaskId);
        const paths = taskPaths(currentTaskId);
        if (FINAL_STATUSES.has(record.status.status)) {
          await this.remote.remove(paths.activeMarker);
          this.cache(record);
          summary.updated += 1;
          continue;
        }
        if (["queued", "starting"].includes(record.status.status)) {
          const remoteTimestamp = await this.remoteNow();
          if (remoteTimestamp.getTime() - Date.parse(record.status.updated_at) < 30000) {
            this.cache(record);
            summary.running += 1;
            continue;
          }
        }
        let identity;
        try {
          const inspected = await this.remote.exec(processIdentityCommand(record.status));
          if (inspected.code !== 0) throw new Error(inspected.stderr || `identity probe exited with ${inspected.code}`);
          identity = parseIdentity(inspected.stdout);
        } catch (error) {
          if (/complete process identity/.test(error.message)) identity = { incomplete: "1" };
          else throw error;
        }
        const bootMatches = identity.boot_id != null && identity.boot_id === record.status.boot_id;
        const wrapperMatches = identity.wrapper_exists === "1" && Number(identity.wrapper_pgid) === record.status.wrapper_pgid && Number(identity.wrapper_start_ticks) === record.status.wrapper_process_start_ticks;
        const processMatches = identity.process_exists === "1" && Number(identity.process_pgid) === record.status.pgid && Number(identity.process_start_ticks) === record.status.process_start_ticks;
        if (bootMatches && wrapperMatches && processMatches) {
          this.cache(record);
          summary.running += 1;
          continue;
        }
        record = await this.get(currentTaskId);
        if (FINAL_STATUSES.has(record.status.status)) {
          await this.remote.remove(paths.activeMarker);
          this.cache(record);
          summary.updated += 1;
          continue;
        }
        const updatedAt = (await this.remoteNow()).toISOString();
        const status = {
          ...record.status,
          status: identity.incomplete ? "unknown" : !bootMatches || (identity.wrapper_exists === "0" && identity.process_exists === "0") ? "interrupted" : "unknown",
          updated_at: updatedAt,
          reconciliation_reason: identity.incomplete ? "process_identity_missing" : !bootMatches ? "boot_id_changed" : identity.wrapper_exists === "0" && identity.process_exists === "0" ? "processes_missing" : "process_identity_mismatch",
        };
        const next = { manifest: record.manifest, status, pinned: record.pinned === true };
        await this.remote.writeText(path.posix.join(paths.taskDir, "status.json"), `${JSON.stringify(status)}\n`);
        await this.remote.writeText(paths.activeMarker, `${JSON.stringify({ schema_version: 1, task_id: currentTaskId, relative_dir: paths.relativeDir, status: status.status, updated_at: updatedAt })}\n`);
        this.cache(next);
        summary.updated += 1;
      } catch (error) { summary.errors.push({ task_id: currentTaskId, error: error.message }); }
    }
    if (this.index && this.ownerKey) summary.local_index_maintenance = this.index.maintain(this.ownerKey);
    return summary;
  }

  async readLogs(taskId, { stream = "stdout", offset = 0, maxBytes = 64 * 1024 } = {}) {
    if (!new Set(["stdout", "stderr"]).has(stream)) throw new Error("stream must be stdout or stderr");
    integer(offset, "offset", 0, Number.MAX_SAFE_INTEGER);
    integer(maxBytes, "max_bytes", 1, 1024 * 1024);
    const paths = taskPaths(taskId);
    const pattern = new RegExp(`^${stream}\\.(\\d{20})\\.log$`);
    const entries = (await this.remote.list(paths.taskDir)).map((entry) => {
      const match = entry.type === "file" && entry.name.match(pattern);
      return match ? { name: entry.name, start: Number(match[1]), end: Number(match[1]) + Number(entry.size || 0) } : null;
    }).filter(Boolean).sort((a, b) => a.start - b.start);
    const firstAvailable = entries[0]?.start ?? 0;
    const streamEnd = entries.at(-1)?.end ?? firstAvailable;
    const start = Math.max(offset, firstAvailable);
    const end = Math.min(streamEnd, start + maxBytes);
    const chunks = [];
    for (const segment of entries) {
      if (segment.end <= start || segment.start >= end) continue;
      const from = Math.max(start, segment.start);
      const to = Math.min(end, segment.end);
      chunks.push(await this.remote.readRange(path.posix.join(paths.taskDir, segment.name), from - segment.start, to - from));
    }
    const content = Buffer.concat(chunks);
    return {
      task_id: taskId,
      stream,
      first_available_offset: firstAvailable,
      next_offset: start + content.length,
      stream_end_offset: streamEnd,
      dropped_before: firstAvailable,
      cursor_was_dropped: offset < firstAvailable,
      content: content.toString("utf8"),
      content_base64: content.toString("base64"),
    };
  }
}

export const persistentTaskInternals = { TASK_ROOT, parseCapabilities, parseIdentity, processIdentityCommand, taskPaths };
