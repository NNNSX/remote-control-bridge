import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const TASK_SCHEMA_VERSION = 1;

const FINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const KNOWN_STATUSES = new Set([
  "queued", "starting", "running", "cancelling",
  "completed", "failed", "cancelled", "cancel_incomplete", "interrupted", "unknown",
]);
const TRANSITIONS = new Map([
  ["queued", new Set(["starting", "cancelled", "failed", "unknown"])],
  ["starting", new Set(["running", "cancelling", "failed", "interrupted", "unknown"])],
  ["running", new Set(["cancelling", "completed", "failed", "interrupted", "unknown"])],
  ["cancelling", new Set(["cancelled", "cancel_incomplete", "failed", "unknown"])],
  ["cancel_incomplete", new Set(["cancelling", "cancelled", "failed", "unknown"])],
  ["interrupted", new Set(["cancelled", "failed", "unknown"])],
  ["unknown", new Set(["running", "cancelling", "completed", "failed", "cancelled", "interrupted"])],
]);

function assertTaskId(taskId) {
  if (typeof taskId !== "string" || !/^task-[a-z0-9][a-z0-9_-]{7,95}$/i.test(taskId)) throw new Error("task_id must be a safe task identifier");
  return taskId;
}

function assertIsoDate(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function assertRelativeDirectory(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.split("/").includes("..") || path.posix.isAbsolute(value)) throw new Error("relative_dir must be a safe relative POSIX path");
  return value;
}

function utcParts(isoTimestamp) {
  const date = new Date(isoTimestamp);
  return [String(date.getUTCFullYear()).padStart(4, "0"), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")];
}

function validateStatus(status) {
  if (!KNOWN_STATUSES.has(status)) throw new Error(`unknown task status: ${status}`);
  return status;
}

function validateManifest(manifest) {
  if (!manifest || manifest.schema_version !== TASK_SCHEMA_VERSION) throw new Error("unsupported task manifest schema_version");
  assertTaskId(manifest.task_id);
  assertIsoDate(manifest.created_at, "created_at");
  assertRelativeDirectory(manifest.relative_dir);
  if (typeof manifest.launcher !== "string" || !manifest.launcher) throw new Error("launcher is required");
  if (typeof manifest.workdir !== "string" || !manifest.workdir) throw new Error("workdir is required");
  if (typeof manifest.display_command !== "string" || !manifest.display_command) throw new Error("display_command is required");
  return manifest;
}

function validateStatusRecord(record, taskId) {
  if (!record || record.schema_version !== TASK_SCHEMA_VERSION) throw new Error("unsupported task status schema_version");
  if (record.task_id !== taskId) throw new Error("task status belongs to another task");
  validateStatus(record.status);
  assertIsoDate(record.updated_at, "updated_at");
  return record;
}

async function atomicWriteJson(target, value) {
  const temporary = `${target}.tmp-${crypto.randomBytes(8).toString("hex")}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, target);
}

async function readJson(target) {
  try { return JSON.parse(await fs.readFile(target, "utf8")); }
  catch (error) { throw new Error(`cannot read ${path.basename(target)}: ${error.message}`, { cause: error }); }
}

export function isResolvedTaskStatus(status) { return FINAL_STATUSES.has(status); }

export class PersistentTaskStore {
  constructor({ root, now = () => new Date() }) {
    this.root = path.resolve(root);
    this.now = now;
    this.activeDir = path.join(this.root, "active");
    this.historyDir = path.join(this.root, "history");
    this.ready = Promise.all([
      fs.mkdir(this.activeDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.historyDir, { recursive: true, mode: 0o700 }),
    ]);
  }

  activePath(taskId) { return path.join(this.activeDir, `${assertTaskId(taskId)}.json`); }

  resolveRelative(relativeDir) {
    const safe = assertRelativeDirectory(relativeDir);
    const resolved = path.resolve(this.root, ...safe.split("/"));
    if (resolved !== this.root && !resolved.startsWith(`${this.root}${path.sep}`)) throw new Error("task directory escapes store root");
    return resolved;
  }

  async create({ taskId, createdAt, launcher, workdir, displayCommand, creatorId = null, tags = [] }) {
    await this.ready;
    const task_id = assertTaskId(taskId);
    const created_at = assertIsoDate(createdAt || this.now().toISOString(), "created_at");
    const relative_dir = path.posix.join("history", ...utcParts(created_at), task_id);
    const taskDir = this.resolveRelative(relative_dir);
    await fs.mkdir(path.dirname(taskDir), { recursive: true, mode: 0o700 });
    await fs.mkdir(taskDir, { mode: 0o700 });
    const manifest = validateManifest({
      schema_version: TASK_SCHEMA_VERSION,
      task_id,
      relative_dir,
      created_at,
      launcher,
      workdir,
      display_command: displayCommand,
      creator_id: creatorId,
      tags: Array.isArray(tags) ? tags.map(String).slice(0, 16) : [],
    });
    const status = { schema_version: TASK_SCHEMA_VERSION, task_id, status: "queued", updated_at: created_at };
    await atomicWriteJson(path.join(taskDir, "task.json"), manifest);
    await atomicWriteJson(path.join(taskDir, "status.json"), status);
    await atomicWriteJson(this.activePath(task_id), { schema_version: TASK_SCHEMA_VERSION, task_id, relative_dir, status: status.status, updated_at: status.updated_at });
    return { manifest, status };
  }

  async readActiveMarker(taskId) {
    await this.ready;
    const marker = await readJson(this.activePath(taskId));
    if (marker.schema_version !== TASK_SCHEMA_VERSION) throw new Error("unsupported active marker schema_version");
    if (marker.task_id !== taskId) throw new Error("active marker belongs to another task");
    assertRelativeDirectory(marker.relative_dir);
    validateStatus(marker.status);
    return marker;
  }

  async readByRelative(relativeDir) {
    await this.ready;
    const taskDir = this.resolveRelative(relativeDir);
    const manifest = validateManifest(await readJson(path.join(taskDir, "task.json")));
    const status = validateStatusRecord(await readJson(path.join(taskDir, "status.json")), manifest.task_id);
    return { manifest, status };
  }

  async readActive(taskId) {
    const marker = await this.readActiveMarker(taskId);
    return this.readByRelative(marker.relative_dir);
  }

  async updateStatus(taskId, nextStatus, details = {}) {
    validateStatus(nextStatus);
    const marker = await this.readActiveMarker(taskId);
    const current = await this.readByRelative(marker.relative_dir);
    if (current.status.status !== nextStatus && !TRANSITIONS.get(current.status.status)?.has(nextStatus)) throw new Error(`invalid task transition: ${current.status.status} -> ${nextStatus}`);
    const updated_at = this.now().toISOString();
    const status = {
      ...current.status,
      ...details,
      schema_version: TASK_SCHEMA_VERSION,
      task_id: current.manifest.task_id,
      status: nextStatus,
      updated_at,
    };
    validateStatusRecord(status, taskId);
    const taskDir = this.resolveRelative(marker.relative_dir);
    await atomicWriteJson(path.join(taskDir, "status.json"), status);
    if (isResolvedTaskStatus(nextStatus)) await fs.rm(this.activePath(taskId), { force: true });
    else await atomicWriteJson(this.activePath(taskId), { schema_version: TASK_SCHEMA_VERSION, task_id: taskId, relative_dir: marker.relative_dir, status: nextStatus, updated_at });
    return { manifest: current.manifest, status };
  }

  async listActive() {
    await this.ready;
    const tasks = [];
    const errors = [];
    for (const name of await fs.readdir(this.activeDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const taskId = name.slice(0, -5);
        const marker = await this.readActiveMarker(taskId);
        const record = await this.readByRelative(marker.relative_dir);
        tasks.push(record);
      } catch (error) { errors.push({ file: name, error: error.message }); }
    }
    tasks.sort((a, b) => b.manifest.created_at.localeCompare(a.manifest.created_at));
    return { tasks, errors };
  }
}
