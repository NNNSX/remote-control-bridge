import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const KNOWN_STATUSES = new Set(["queued", "starting", "running", "cancelling", "completed", "failed", "cancelled", "cancel_incomplete", "interrupted", "unknown"]);
const FINAL_STATUSES = ["completed", "failed", "cancelled"];

function owner(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("owner_key must be a SHA-256 hex digest");
  return value;
}

function taskId(value) {
  if (typeof value !== "string" || !/^task-[a-z0-9-]{12,96}$/i.test(value)) throw new Error("invalid task_id");
  return value;
}

function encodeCursor(record) { return Buffer.from(JSON.stringify({ created_at: record.created_at, task_id: record.task_id })).toString("base64url"); }
function decodeCursor(value) {
  if (value == null || value === "") return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof parsed.created_at !== "string" || !Number.isFinite(Date.parse(parsed.created_at))) throw new Error();
    taskId(parsed.task_id);
    return parsed;
  } catch { throw new Error("invalid history cursor"); }
}

export function taskOwnerKey({ host, port, username, fingerprint }) {
  if (![host, username, fingerprint].every((value) => typeof value === "string" && value) || !Number.isInteger(Number(port))) throw new Error("complete SSH binding is required");
  return crypto.createHash("sha256").update(`${host}|${Number(port)}|${username}|${fingerprint}`).digest("hex");
}

export class TaskIndex {
  static async open({ file }) {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import("node:sqlite")); }
    catch { const error = new Error("local task history requires Node.js with node:sqlite support"); error.code = "SQLITE_UNAVAILABLE"; throw error; }
    await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
    return new TaskIndex({ file, DatabaseSync });
  }

  constructor({ file, DatabaseSync }) {
    this.file = path.resolve(file);
    this.database = new DatabaseSync(this.file);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=67108864;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        owner_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        relative_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        launcher TEXT NOT NULL,
        reliability TEXT NOT NULL,
        workdir TEXT NOT NULL,
        display_command TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        logging_status TEXT,
        exit_code INTEGER,
        remote_verified INTEGER NOT NULL,
        last_verified_at TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        status_json TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner_key, task_id)
      );
      CREATE INDEX IF NOT EXISTS tasks_owner_status_updated ON tasks(owner_key, status, updated_at DESC, task_id DESC);
      CREATE INDEX IF NOT EXISTS tasks_owner_created ON tasks(owner_key, created_at DESC, task_id DESC);
    `);
    const columns = this.database.prepare("PRAGMA table_info(tasks)").all();
    if (!columns.some((column) => column.name === "pinned")) this.database.exec("ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    this.upsertStatement = this.database.prepare(`
      INSERT INTO tasks (owner_key, task_id, relative_dir, created_at, launcher, reliability, workdir, display_command, tags_json, status, updated_at, logging_status, exit_code, remote_verified, last_verified_at, manifest_json, status_json, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_key, task_id) DO UPDATE SET
        relative_dir=excluded.relative_dir, created_at=excluded.created_at, launcher=excluded.launcher,
        reliability=excluded.reliability, workdir=excluded.workdir, display_command=excluded.display_command,
        tags_json=excluded.tags_json, status=excluded.status, updated_at=excluded.updated_at,
        logging_status=excluded.logging_status, exit_code=excluded.exit_code,
        remote_verified=excluded.remote_verified, last_verified_at=excluded.last_verified_at,
        manifest_json=excluded.manifest_json, status_json=excluded.status_json, pinned=excluded.pinned
    `);
  }

  upsert(ownerKey, record, { remoteVerified = true, verifiedAt = new Date().toISOString() } = {}) {
    const checkedOwner = owner(ownerKey);
    const { manifest, status } = record || {};
    taskId(manifest?.task_id);
    if (status?.task_id !== manifest.task_id || !KNOWN_STATUSES.has(status.status)) throw new Error("invalid indexed task record");
    this.upsertStatement.run(
      checkedOwner, manifest.task_id, manifest.relative_dir, manifest.created_at, manifest.launcher,
      manifest.reliability || "unknown", manifest.workdir, manifest.display_command,
      JSON.stringify(Array.isArray(manifest.tags) ? manifest.tags : []), status.status, status.updated_at,
      status.logging_status || null, Number.isInteger(status.exit_code) ? status.exit_code : null,
      remoteVerified ? 1 : 0, verifiedAt, JSON.stringify(manifest), JSON.stringify(status), record.pinned === true ? 1 : 0,
    );
    return record;
  }

  list(ownerKey, { status = null, limit = 50, cursor = null } = {}) {
    const checkedOwner = owner(ownerKey);
    if (status != null && !KNOWN_STATUSES.has(status)) throw new Error("unknown task status filter");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
    const decoded = decodeCursor(cursor);
    const where = ["owner_key = ?"];
    const parameters = [checkedOwner];
    if (status) { where.push("status = ?"); parameters.push(status); }
    if (decoded) { where.push("(created_at < ? OR (created_at = ? AND task_id < ?))"); parameters.push(decoded.created_at, decoded.created_at, decoded.task_id); }
    parameters.push(limit + 1);
    const rows = this.database.prepare(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY created_at DESC, task_id DESC LIMIT ?`).all(...parameters);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const tasks = selected.map((row) => ({
      manifest: JSON.parse(row.manifest_json),
      status: JSON.parse(row.status_json),
      pinned: Boolean(row.pinned),
      remote_verified: Boolean(row.remote_verified),
      last_verified_at: row.last_verified_at,
    }));
    return { tasks, next_cursor: hasMore ? encodeCursor(selected.at(-1)) : null };
  }

  maintain(ownerKey, { now = new Date(), retentionDays = 90, maxFinalRows = 10000 } = {}) {
    const checkedOwner = owner(ownerKey);
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("maintenance now must be a valid Date");
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error("retentionDays must be between 1 and 3650");
    if (!Number.isInteger(maxFinalRows) || maxFinalRows < 1 || maxFinalRows > 1000000) throw new Error("maxFinalRows must be between 1 and 1000000");
    const cutoff = new Date(now.getTime() - retentionDays * 86400000).toISOString();
    const placeholders = FINAL_STATUSES.map(() => "?").join(",");
    const expired = this.database.prepare(`DELETE FROM tasks WHERE owner_key = ? AND pinned = 0 AND status IN (${placeholders}) AND created_at < ?`).run(checkedOwner, ...FINAL_STATUSES, cutoff);
    const excess = this.database.prepare(`DELETE FROM tasks WHERE owner_key = ? AND pinned = 0 AND status IN (${placeholders}) AND task_id IN (SELECT task_id FROM tasks WHERE owner_key = ? AND pinned = 0 AND status IN (${placeholders}) ORDER BY created_at DESC, task_id DESC LIMIT -1 OFFSET ?)`).run(checkedOwner, ...FINAL_STATUSES, checkedOwner, ...FINAL_STATUSES, maxFinalRows);
    this.database.exec("PRAGMA wal_checkpoint(PASSIVE)");
    return { expired_removed: Number(expired.changes), excess_removed: Number(excess.changes), retention_days: retentionDays, max_final_rows: maxFinalRows };
  }

  async stats(ownerKey) {
    const checkedOwner = owner(ownerKey);
    const rows = this.database.prepare("SELECT status, COUNT(*) AS count FROM tasks WHERE owner_key = ? GROUP BY status ORDER BY status").all(checkedOwner);
    let filesBytes = 0;
    for (const file of [this.file, `${this.file}-wal`, `${this.file}-shm`]) {
      try { filesBytes += Number((await fs.stat(file)).size || 0); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const pinned = this.database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE owner_key = ? AND pinned = 1").get(checkedOwner);
    return { rows: rows.map((row) => ({ status: row.status, count: Number(row.count) })), total_rows: rows.reduce((sum, row) => sum + Number(row.count), 0), pinned_rows: Number(pinned.count), files_bytes: filesBytes, retention_days: 90, max_final_rows: 10000 };
  }

  remove(ownerKey, id) { return Number(this.database.prepare("DELETE FROM tasks WHERE owner_key = ? AND task_id = ?").run(owner(ownerKey), taskId(id)).changes) > 0; }

  close() { this.database.close(); }
}

export const taskIndexInternals = { decodeCursor, encodeCursor, FINAL_STATUSES };
