import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskIndex, taskOwnerKey } from "../lib/task-index.mjs";

function record(id, createdAt, status = "completed", pinned = false) {
  return {
    manifest: { schema_version: 1, task_id: id, relative_dir: `history/2026/08/10/${id}`, created_at: createdAt, launcher: "setsid-nohup", reliability: "best_effort", workdir: "AI/work", display_command: "train", tags: [] },
    status: { schema_version: 1, task_id: id, status, updated_at: createdAt, logging_status: "ok", exit_code: status === "completed" ? 0 : null },
    pinned,
  };
}

test("SQLite task index isolates owners and paginates with stable cursors", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-task-index-"));
  const index = await TaskIndex.open({ file: path.join(root, "tasks.sqlite") });
  context.after(async () => { index.close(); await fs.rm(root, { recursive: true, force: true }); });
  const ownerA = taskOwnerKey({ host: "host-a", port: 22, username: "user", fingerprint: "SHA256:a" });
  const ownerB = taskOwnerKey({ host: "host-b", port: 22, username: "user", fingerprint: "SHA256:b" });
  index.upsert(ownerA, record("task-20260810-aaaaaaaaaaaa", "2026-08-10T12:00:00Z"));
  index.upsert(ownerA, record("task-20260810-bbbbbbbbbbbb", "2026-08-10T13:00:00Z", "failed"));
  index.upsert(ownerA, record("task-20260810-cccccccccccc", "2026-08-10T14:00:00Z"));
  index.upsert(ownerB, record("task-20260810-dddddddddddd", "2026-08-10T15:00:00Z"));

  const first = index.list(ownerA, { limit: 2 });
  assert.deepEqual(first.tasks.map((item) => item.manifest.task_id), ["task-20260810-cccccccccccc", "task-20260810-bbbbbbbbbbbb"]);
  assert.ok(first.next_cursor);
  const second = index.list(ownerA, { limit: 2, cursor: first.next_cursor });
  assert.deepEqual(second.tasks.map((item) => item.manifest.task_id), ["task-20260810-aaaaaaaaaaaa"]);
  assert.equal(second.next_cursor, null);
  assert.deepEqual(index.list(ownerA, { status: "failed" }).tasks.map((item) => item.manifest.task_id), ["task-20260810-bbbbbbbbbbbb"]);
});

test("task owner keys include the confirmed SSH fingerprint", () => {
  const base = { host: "host", port: 22, username: "user" };
  assert.notEqual(taskOwnerKey({ ...base, fingerprint: "SHA256:a" }), taskOwnerKey({ ...base, fingerprint: "SHA256:b" }));
});

test("SQLite task history survives reopening the Session process", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-task-reopen-"));
  const file = path.join(root, "tasks.sqlite");
  const ownerKey = taskOwnerKey({ host: "host", port: 22, username: "user", fingerprint: "SHA256:stable" });
  let index = await TaskIndex.open({ file });
  index.upsert(ownerKey, record("task-20260810-eeeeeeeeeeee", "2026-08-10T16:00:00Z"));
  index.close();
  index = await TaskIndex.open({ file });
  try { assert.deepEqual(index.list(ownerKey).tasks.map((item) => item.manifest.task_id), ["task-20260810-eeeeeeeeeeee"]); }
  finally { index.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("local maintenance bounds final history without deleting unresolved tasks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-task-maintain-"));
  const index = await TaskIndex.open({ file: path.join(root, "tasks.sqlite") });
  const ownerKey = taskOwnerKey({ host: "host", port: 22, username: "user", fingerprint: "SHA256:maintain" });
  try {
    index.upsert(ownerKey, record("task-20260101-aaaaaaaaaaaa", "2026-01-01T00:00:00Z"));
    index.upsert(ownerKey, record("task-20260808-bbbbbbbbbbbb", "2026-08-08T00:00:00Z"));
    index.upsert(ownerKey, record("task-20260809-cccccccccccc", "2026-08-09T00:00:00Z"));
    index.upsert(ownerKey, record("task-20260101-dddddddddddd", "2026-01-01T00:00:00Z", "interrupted"));
    index.upsert(ownerKey, record("task-20260102-eeeeeeeeeeee", "2026-01-02T00:00:00Z", "completed", true));
    const result = index.maintain(ownerKey, { now: new Date("2026-08-10T00:00:00Z"), retentionDays: 90, maxFinalRows: 1 });
    assert.equal(result.expired_removed, 1);
    assert.equal(result.excess_removed, 1);
    assert.deepEqual(index.list(ownerKey, { limit: 10 }).tasks.map((item) => item.manifest.task_id), ["task-20260809-cccccccccccc", "task-20260102-eeeeeeeeeeee", "task-20260101-dddddddddddd"]);
    const stats = await index.stats(ownerKey);
    assert.equal(stats.total_rows, 3);
    assert.equal(stats.pinned_rows, 1);
    assert.ok(stats.files_bytes > 0);
    assert.equal(index.remove(ownerKey, "task-20260102-eeeeeeeeeeee"), true);
    assert.equal(index.remove(ownerKey, "task-20260102-eeeeeeeeeeee"), false);
  } finally { index.close(); await fs.rm(root, { recursive: true, force: true }); }
});
