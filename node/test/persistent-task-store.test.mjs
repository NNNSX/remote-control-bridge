import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PersistentTaskStore } from "../lib/persistent-task-store.mjs";

test("persistent task records keep immutable UTC directories and remove only active markers on completion", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-task-store-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = new Date("2026-08-10T12:34:56.000Z");
  const store = new PersistentTaskStore({ root, now: () => now });
  const created = await store.create({ taskId: "task-training_001", launcher: "tmux", workdir: "AI/agent_test", displayCommand: "bash run_train.sh" });
  assert.equal(created.manifest.relative_dir, "history/2026/08/10/task-training_001");
  const taskDir = path.join(root, ...created.manifest.relative_dir.split("/"));
  assert.equal(JSON.parse(await fs.readFile(path.join(taskDir, "task.json"), "utf8")).schema_version, 1);

  now = new Date("2026-08-10T12:35:00.000Z");
  await store.updateStatus("task-training_001", "starting", { launcher_id: "tmux:rcb-task-training_001" });
  await store.updateStatus("task-training_001", "running", { pid: 123, pgid: 123, boot_id: "boot-a", process_start_ticks: 456 });
  now = new Date("2026-08-11T01:00:00.000Z");
  const completed = await store.updateStatus("task-training_001", "completed", { exit_code: 0 });
  assert.equal(completed.manifest.relative_dir, created.manifest.relative_dir);
  assert.equal(completed.status.status, "completed");
  assert.equal(JSON.parse(await fs.readFile(path.join(taskDir, "status.json"), "utf8")).exit_code, 0);
  await assert.rejects(() => fs.stat(path.join(root, "active", "task-training_001.json")), { code: "ENOENT" });
  assert.equal((await fs.stat(taskDir)).isDirectory(), true);
});

test("unresolved tasks remain discoverable and invalid transitions are rejected", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-task-store-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PersistentTaskStore({ root, now: () => new Date("2026-08-10T00:00:00.000Z") });
  await store.create({ taskId: "task-recovery_001", launcher: "setsid", workdir: "work", displayCommand: "train" });
  await store.updateStatus("task-recovery_001", "starting");
  await store.updateStatus("task-recovery_001", "interrupted", { boot_id: "boot-old" });
  const active = await store.listActive();
  assert.equal(active.tasks.length, 1);
  assert.equal(active.tasks[0].status.status, "interrupted");
  await assert.rejects(() => store.updateStatus("task-recovery_001", "running"), /invalid task transition/);
});

test("reopening the task store preserves active records and allows recovery to completion", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-task-store-reopen-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const createdAt = "2026-08-11T02:03:04.000Z";
  const first = new PersistentTaskStore({ root, now: () => new Date("2026-08-11T02:03:05.000Z") });
  await first.create({ taskId: "task-reopen_001", createdAt, launcher: "setsid-nohup", workdir: "AI/work", displayCommand: "python train.py" });
  await first.updateStatus("task-reopen_001", "starting");
  await first.updateStatus("task-reopen_001", "running", { pgid: 42, boot_id: "boot-a" });

  const reopened = new PersistentTaskStore({ root, now: () => new Date("2026-08-11T02:03:06.000Z") });
  const active = await reopened.listActive();
  assert.equal(active.errors.length, 0);
  assert.equal(active.tasks.length, 1);
  assert.equal(active.tasks[0].manifest.task_id, "task-reopen_001");
  assert.equal(active.tasks[0].status.status, "running");
  assert.equal(active.tasks[0].status.pgid, 42);

  const completed = await reopened.updateStatus("task-reopen_001", "completed", { exit_code: 0 });
  assert.equal(completed.status.status, "completed");
  assert.deepEqual((await reopened.listActive()).tasks, []);
  await assert.rejects(() => fs.stat(path.join(root, "active", "task-reopen_001.json")), { code: "ENOENT" });
});

test("active scans isolate corrupt and unsupported records", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-task-store-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PersistentTaskStore({ root, now: () => new Date("2026-08-10T00:00:00.000Z") });
  await store.create({ taskId: "task-healthy_001", launcher: "slurm", workdir: "work", displayCommand: "sbatch train.sh" });
  await fs.writeFile(path.join(root, "active", "task-corrupt_001.json"), "{broken", "utf8");
  await fs.writeFile(path.join(root, "active", "task-version_001.json"), JSON.stringify({ schema_version: 99, task_id: "task-version_001", relative_dir: "history/2026/08/10/task-version_001", status: "running", updated_at: new Date().toISOString() }), "utf8");
  const active = await store.listActive();
  assert.equal(active.tasks.length, 1);
  assert.equal(active.errors.length, 2);
  assert.match(active.errors.map((item) => item.error).join(" "), /cannot read|schema_version/);
});

test("task identifiers cannot escape the task store", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-task-store-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PersistentTaskStore({ root });
  await assert.rejects(() => store.create({ taskId: "../escape", launcher: "tmux", workdir: "work", displayCommand: "train" }), /safe task identifier/);
});
