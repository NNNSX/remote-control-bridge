import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parsePersistentTaskRequest, RemoteTaskService } from "../lib/remote-task-service.mjs";
import { TaskIndex } from "../lib/task-index.mjs";

class FakeRemote {
  constructor() { this.files = new Map(); this.directories = new Set(); this.commands = []; this.identityOutput = null; this.removals = []; this.writeFailurePattern = null; }
  async exec(command) {
    this.commands.push(command);
    if (command.startsWith("for name in bash")) return { code: 0, stdout: "bash=1\ndd=1\ncat=1\nmkfifo=1\nwc=1\nps=1\nawk=1\ndate=1\nmv=1\nrm=1\nchmod=1\nsetsid=1\nnohup=1\nsystemd_run=1\nsystemctl=1\nsystemd_user=running\nlinger=no\n", stderr: "" };
    if (command === "date -u +%Y-%m-%dT%H:%M:%SZ") return { code: 0, stdout: "2026-08-10T12:34:56Z\n", stderr: "" };
    if (command.startsWith("WRAPPER=")) return { code: 0, stdout: this.identityOutput || "", stderr: "" };
    if (command.includes("cancel-requested")) {
      const taskDir = [...this.directories].find((value) => value.endsWith("task-20260810-000102030405060708"));
      this.files.set(`${taskDir}/cancel-requested`, "{}\n");
    }
    return { code: 0, stdout: "1234\n", stderr: "" };
  }
  async mkdir(value) { this.directories.add(value); }
  async writeText(target, content) {
    if (this.writeFailurePattern && this.writeFailurePattern.test(target)) { const error = new Error("remote filesystem is read-only"); error.code = "EROFS"; throw error; }
    this.files.set(target, content);
  }
  async readText(target) { if (!this.files.has(target)) { const error = new Error("missing"); error.code = "ENOENT"; throw error; } return this.files.get(target); }
  async remove(target) { this.removals.push(target); this.files.delete(target); }
  async removeDirectory(target) { this.removals.push(`${target}/`); this.directories.delete(target); }
  async exists(target) { return this.files.has(target); }
  async readRange(target, offset, length) { return Buffer.from(this.files.get(target)).subarray(offset, offset + length); }
  async list(target) {
    const prefix = `${target}/`;
    const entries = new Map();
    for (const directory of this.directories) {
      if (!directory.startsWith(prefix)) continue;
      const relative = directory.slice(prefix.length);
      if (!relative || relative.includes("/")) continue;
      entries.set(relative, { name: relative, type: "directory", size: 0 });
    }
    for (const [file, content] of this.files) {
      if (!file.startsWith(prefix)) continue;
      const relative = file.slice(prefix.length);
      const [name, ...rest] = relative.split("/");
      if (rest.length) {
        if (!entries.has(name)) entries.set(name, { name, type: "directory", size: 0 });
      } else entries.set(name, { name, type: "file", size: Buffer.byteLength(content) });
    }
    return [...entries.values()];
  }
}

function seedTask(remote, { taskId, createdAt, status, active = false, pinned = false, log = "" }) {
  const match = taskId.match(/^task-(\d{4})(\d{2})(\d{2})-/);
  const relativeDir = `history/${match[1]}/${match[2]}/${match[3]}/${taskId}`;
  const dir = `.remote-control-bridge/tasks/${relativeDir}`;
  remote.directories.add(dir);
  remote.files.set(`${dir}/task.json`, `${JSON.stringify({ schema_version: 1, task_id: taskId, relative_dir: relativeDir, created_at: createdAt, launcher: "setsid-nohup", reliability: "best_effort", workdir: ".", display_command: "train", tags: [] })}\n`);
  remote.files.set(`${dir}/status.json`, `${JSON.stringify({ schema_version: 1, task_id: taskId, status, updated_at: createdAt })}\n`);
  remote.files.set(`${dir}/stdout.00000000000000000000.log`, log);
  if (active) remote.files.set(`.remote-control-bridge/tasks/active/${taskId}.json`, "{}\n");
  if (pinned) remote.files.set(`${dir}/pinned.json`, `${JSON.stringify({ schema_version: 1, task_id: taskId, pinned_at: createdAt })}\n`);
  return dir;
}

test("persistent task requests are structured and reject persisted secrets", () => {
  assert.deepEqual(parsePersistentTaskRequest({ argv: ["python", "train.py"], workdir: "AI/work" }).launcher, "auto");
  assert.throws(() => parsePersistentTaskRequest({ argv: ["train", "--token=secret"] }), /sensitive command arguments/);
  assert.throws(() => parsePersistentTaskRequest({ argv: ["train"], workdir: "../escape" }), /safe relative POSIX path/);
  assert.throws(() => parsePersistentTaskRequest({ argv: [] }), /between 1 and 256/);
});

test("remote task service creates dated records and selects an available launcher", async () => {
  const remote = new FakeRemote();
  const service = new RemoteTaskService({ remote, now: () => new Date("2026-08-10T12:34:56Z"), randomBytes: () => Buffer.from("000102030405060708", "hex") });
  const created = await service.create({ argv: ["python", "train.py"], workdir: "AI/work", environment: { CUDA_VISIBLE_DEVICES: "3,4" } });
  assert.equal(created.manifest.task_id, "task-20260810-000102030405060708");
  assert.equal(created.manifest.launcher, "systemd-run-user");
  assert.equal(created.manifest.reliability, "best_effort");
  assert.deepEqual(created.manifest.resources, { gpu_visibility: "restricted", gpu_devices: [3, 4] });
  assert.match(remote.commands.at(-1), /^systemd-run --user/);
  assert.ok(remote.files.has(".remote-control-bridge/tasks/history/2026/08/10/task-20260810-000102030405060708/launch.sh"));
  const active = await service.listActive();
  assert.equal(active.tasks.length, 1);
  assert.equal(active.tasks[0].status.status, "queued");
});

test("remote write failures do not launch a task without a recoverable active marker", async () => {
  const remote = new FakeRemote();
  remote.writeFailurePattern = /\/active\/.*\.json$/;
  const service = new RemoteTaskService({ remote, now: () => new Date("2026-08-11T03:00:00Z"), randomBytes: () => Buffer.from("111213141516171819", "hex") });
  await assert.rejects(() => service.create({ argv: ["python", "job.py"] }), (error) => error.code === "EROFS");
  assert.equal(remote.commands.some((command) => command.startsWith("systemd-run") || command.startsWith("setsid nohup")), false);
  assert.equal([...remote.files.keys()].some((file) => file.endsWith("/task.json")), true);
  assert.equal([...remote.files.keys()].some((file) => file.endsWith("/status.json")), true);
});

test("task manifests persist only normalized GPU resource hints", async () => {
  const cases = [
    ["3,4,3", { gpu_visibility: "restricted", gpu_devices: [3, 4] }],
    ["all", { gpu_visibility: "all" }],
    ["-1", { gpu_visibility: "none", gpu_devices: [] }],
    ["GPU-1234abcd", { gpu_visibility: "unresolved", gpu_selector_count: 1 }],
  ];
  for (const [visibleDevices, expected] of cases) {
    const remote = new FakeRemote();
    const service = new RemoteTaskService({ remote, randomBytes: () => Buffer.from("000102030405060708", "hex") });
    const created = await service.create({ argv: ["train"], environment: { CUDA_VISIBLE_DEVICES: visibleDevices } });
    assert.deepEqual(created.manifest.resources, expected);
    assert.equal(JSON.stringify(created.manifest).includes("CUDA_VISIBLE_DEVICES"), false, "environment variable names must not be copied into the manifest");
    if (visibleDevices.startsWith("GPU-")) assert.equal(JSON.stringify(created.manifest).includes(visibleDevices), false, "opaque GPU selectors must not be copied into the manifest");
  }
});

test("remote task cancellation verifies persisted process identity", async () => {
  const remote = new FakeRemote();
  const service = new RemoteTaskService({ remote, now: () => new Date("2026-08-10T12:34:56Z"), randomBytes: () => Buffer.from("000102030405060708", "hex") });
  const created = await service.create({ argv: ["train"], launcher: "setsid-nohup" });
  const dir = ".remote-control-bridge/tasks/history/2026/08/10/task-20260810-000102030405060708";
  remote.files.set(`${dir}/status.json`, `${JSON.stringify({ schema_version: 1, task_id: created.manifest.task_id, status: "running", updated_at: "2026-08-10T12:35:00Z", pgid: 1234, boot_id: "boot-a", process_start_ticks: 5678 })}\n`);
  const cancelled = await service.cancel(created.manifest.task_id);
  assert.equal(cancelled.status.status, "cancelling");
  assert.equal(cancelled.cancellation_requested, true);
  assert.match(remote.commands.at(-1), /EXPECTED_START_TICKS=5678/);
});

test("remote task logs preserve global offsets and report dropped cursors", async () => {
  const remote = new FakeRemote();
  const service = new RemoteTaskService({ remote });
  const dir = ".remote-control-bridge/tasks/history/2026/08/10/task-20260810-abcdef123456";
  remote.directories.add(dir);
  remote.files.set(`${dir}/stdout.00000000000000000010.log`, "abcdefghij");
  remote.files.set(`${dir}/stdout.00000000000000000020.log`, "klmnopqrst");
  const result = await service.readLogs("task-20260810-abcdef123456", { offset: 5, maxBytes: 12 });
  assert.equal(result.first_available_offset, 10);
  assert.equal(result.cursor_was_dropped, true);
  assert.equal(result.content, "abcdefghijkl");
  assert.equal(result.next_offset, 22);
  assert.equal(Buffer.from(result.content_base64, "base64").toString(), result.content);
});

test("reconciliation keeps verified processes running and marks missing processes interrupted", async () => {
  const remote = new FakeRemote();
  const service = new RemoteTaskService({ remote });
  const taskId = "task-20260810-abcdef123456";
  const dir = `.remote-control-bridge/tasks/history/2026/08/10/${taskId}`;
  const active = `.remote-control-bridge/tasks/active/${taskId}.json`;
  remote.directories.add(dir);
  remote.files.set(`${dir}/task.json`, `${JSON.stringify({ schema_version: 1, task_id: taskId, relative_dir: `history/2026/08/10/${taskId}`, created_at: "2026-08-10T12:00:00Z", launcher: "setsid-nohup", reliability: "best_effort", workdir: ".", display_command: "train", tags: [] })}\n`);
  remote.files.set(`${dir}/status.json`, `${JSON.stringify({ schema_version: 1, task_id: taskId, status: "running", updated_at: "2026-08-10T12:00:01Z", wrapper_pid: 100, wrapper_pgid: 100, wrapper_process_start_ticks: 200, pgid: 300, process_start_ticks: 400, boot_id: "boot-a", exit_code: null })}\n`);
  remote.files.set(active, "{}\n");
  remote.identityOutput = "boot_id=boot-a\nwrapper_exists=1\nwrapper_pgid=100\nwrapper_start_ticks=200\nprocess_exists=1\nprocess_pgid=300\nprocess_start_ticks=400\n";
  let result = await service.reconcile();
  assert.equal(result.running, 1);
  assert.equal(result.updated, 0);

  remote.identityOutput = "boot_id=boot-a\nwrapper_exists=0\nprocess_exists=0\n";
  result = await service.reconcile();
  assert.equal(result.updated, 1);
  assert.equal((await service.get(taskId)).status.status, "interrupted");
  assert.equal((await service.get(taskId)).status.reconciliation_reason, "processes_missing");
});

test("reconciliation rejects PID reuse and process start-time changes", async () => {
  const remote = new FakeRemote();
  const service = new RemoteTaskService({ remote });
  const taskId = "task-20260811-pidreuse0001";
  const dir = `.remote-control-bridge/tasks/history/2026/08/11/${taskId}`;
  const active = `.remote-control-bridge/tasks/active/${taskId}.json`;
  remote.directories.add(dir);
  remote.files.set(`${dir}/task.json`, `${JSON.stringify({ schema_version: 1, task_id: taskId, relative_dir: `history/2026/08/11/${taskId}`, created_at: "2026-08-11T02:00:00Z", launcher: "setsid-nohup", reliability: "best_effort", workdir: ".", display_command: "train", tags: [] })}\n`);
  remote.files.set(`${dir}/status.json`, `${JSON.stringify({ schema_version: 1, task_id: taskId, status: "running", updated_at: "2026-08-11T02:00:01Z", wrapper_pid: 100, wrapper_pgid: 100, wrapper_process_start_ticks: 200, pgid: 300, process_start_ticks: 400, boot_id: "boot-a" })}\n`);
  remote.files.set(active, "{}\n");
  remote.identityOutput = "boot_id=boot-a\nwrapper_exists=1\nwrapper_pgid=100\nwrapper_start_ticks=999\nprocess_exists=1\nprocess_pgid=300\nprocess_start_ticks=401\n";

  const result = await service.reconcile();
  assert.equal(result.updated, 1);
  assert.equal((await service.get(taskId)).status.status, "unknown");
  assert.equal((await service.get(taskId)).status.reconciliation_reason, "process_identity_mismatch");
  assert.equal(remote.files.has(active), true);
});

test("reconciliation treats a changed boot ID as an interrupted task", async () => {
  const remote = new FakeRemote();
  const service = new RemoteTaskService({ remote });
  const taskId = "task-20260811-bootchange01";
  const dir = `.remote-control-bridge/tasks/history/2026/08/11/${taskId}`;
  const active = `.remote-control-bridge/tasks/active/${taskId}.json`;
  remote.directories.add(dir);
  remote.files.set(`${dir}/task.json`, `${JSON.stringify({ schema_version: 1, task_id: taskId, relative_dir: `history/2026/08/11/${taskId}`, created_at: "2026-08-11T02:10:00Z", launcher: "setsid-nohup", reliability: "best_effort", workdir: ".", display_command: "job", tags: [] })}\n`);
  remote.files.set(`${dir}/status.json`, `${JSON.stringify({ schema_version: 1, task_id: taskId, status: "running", updated_at: "2026-08-11T02:10:01Z", wrapper_pid: 100, wrapper_pgid: 100, wrapper_process_start_ticks: 200, pgid: 300, process_start_ticks: 400, boot_id: "boot-before" })}\n`);
  remote.files.set(active, "{}\n");
  remote.identityOutput = "boot_id=boot-after\nwrapper_exists=1\nwrapper_pgid=100\nwrapper_start_ticks=200\nprocess_exists=1\nprocess_pgid=300\nprocess_start_ticks=400\n";

  const result = await service.reconcile();
  assert.equal(result.updated, 1);
  const record = await service.get(taskId);
  assert.equal(record.status.status, "interrupted");
  assert.equal(record.status.reconciliation_reason, "boot_id_changed");
  assert.equal(remote.files.has(active), true);
});

test("reconciliation removes stale markers for final tasks without touching task artifacts", async () => {
  const remote = new FakeRemote();
  const service = new RemoteTaskService({ remote });
  const taskId = "task-20260811-finalmarker01";
  const dir = seedTask(remote, { taskId, createdAt: "2026-08-11T01:00:00Z", status: "completed", log: "done" });
  const active = `.remote-control-bridge/tasks/active/${taskId}.json`;
  remote.files.set(active, JSON.stringify({ schema_version: 1, task_id: taskId, status: "completed" }));

  const result = await service.reconcile();
  assert.equal(result.checked, 1);
  assert.equal(result.updated, 1);
  assert.equal(remote.files.has(active), false);
  assert.equal(remote.files.has(`${dir}/task.json`), true);
  assert.equal(remote.files.has(`${dir}/status.json`), true);
  assert.equal(remote.files.has(`${dir}/stdout.00000000000000000000.log`), true);
});

test("reconciliation protects incomplete identities and dangling markers", async () => {
  const remote = new FakeRemote();
  const service = new RemoteTaskService({ remote });
  const taskId = "task-20260811-unknownid001";
  const dir = seedTask(remote, { taskId, createdAt: "2026-08-11T01:10:00Z", status: "running" });
  const active = `.remote-control-bridge/tasks/active/${taskId}.json`;
  remote.files.set(`${dir}/status.json`, `${JSON.stringify({ schema_version: 1, task_id: taskId, status: "running", updated_at: "2026-08-11T01:10:01Z" })}\n`);
  remote.files.set(active, "{}\n");
  remote.identityOutput = "boot_id=boot-a\n";

  const danglingId = "task-20260811-dangling0001";
  remote.files.set(`.remote-control-bridge/tasks/active/${danglingId}.json`, "{}\n");
  const result = await service.reconcile();
  assert.equal(result.updated, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].task_id, danglingId);
  assert.equal((await service.get(taskId)).status.status, "unknown");
  assert.equal((await service.get(taskId)).status.reconciliation_reason, "process_identity_missing");
  assert.equal(remote.files.has(active), true);
  assert.equal(remote.files.has(`.remote-control-bridge/tasks/active/${danglingId}.json`), true);
});

test("independent log observers can resume from their own cursors", async () => {
  const remote = new FakeRemote();
  const service = new RemoteTaskService({ remote });
  const taskId = "task-20260811-cursors00001";
  const dir = `.remote-control-bridge/tasks/history/2026/08/11/${taskId}`;
  remote.directories.add(dir);
  remote.files.set(`${dir}/stdout.00000000000000000000.log`, "0123456789");
  remote.files.set(`${dir}/stdout.00000000000000000010.log`, "abcdefghij");

  const [observerA, observerB] = await Promise.all([
    service.readLogs(taskId, { offset: 0, maxBytes: 6 }),
    service.readLogs(taskId, { offset: 10, maxBytes: 6 }),
  ]);
  assert.equal(observerA.content, "012345");
  assert.equal(observerA.next_offset, 6);
  assert.equal(observerB.content, "abcdef");
  assert.equal(observerB.next_offset, 16);
  assert.equal(observerA.cursor_was_dropped, false);
  assert.equal(observerB.cursor_was_dropped, false);
});

test("a new observer recovers history and resumes logs after the service instance is replaced", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-observer-recovery-"));
  const databaseFile = path.join(root, "tasks.sqlite");
  const ownerKey = "a".repeat(64);
  const remote = new FakeRemote();
  const taskId = "task-20260811-reconnect001";
  const dir = seedTask(remote, { taskId, createdAt: "2026-08-11T04:00:00Z", status: "running", active: true, log: "0123456789" });
  let index = await TaskIndex.open({ file: databaseFile });
  context.after(async () => { try { index.close(); } catch {} await fs.rm(root, { recursive: true, force: true }); });

  const firstObserver = new RemoteTaskService({ remote, index, ownerKey });
  await firstObserver.get(taskId);
  const firstChunk = await firstObserver.readLogs(taskId, { offset: 0, maxBytes: 6 });
  assert.equal(firstChunk.content, "012345");
  assert.equal(firstChunk.next_offset, 6);
  index.close();

  remote.files.set(`${dir}/stdout.00000000000000000010.log`, "abcdefghij");
  index = await TaskIndex.open({ file: databaseFile });
  const nextObserver = new RemoteTaskService({ remote, index, ownerKey });
  assert.deepEqual(nextObserver.history({ limit: 10 }).tasks.map((item) => item.manifest.task_id), [taskId]);
  const resumed = await nextObserver.readLogs(taskId, { offset: firstChunk.next_offset, maxBytes: 32 });
  assert.equal(resumed.content, "6789abcdefghij");
  assert.equal(resumed.next_offset, 20);
  assert.equal(resumed.cursor_was_dropped, false);
});

test("remote storage accounting is bounded and cleanup preview protects unresolved records", async () => {
  const remote = new FakeRemote();
  seedTask(remote, { taskId: "task-20260101-aaaaaaaaaaaa", createdAt: "2026-01-01T00:00:00Z", status: "completed", log: "old-final" });
  seedTask(remote, { taskId: "task-20260102-bbbbbbbbbbbb", createdAt: "2026-01-02T00:00:00Z", status: "interrupted", log: "old-unresolved" });
  seedTask(remote, { taskId: "task-20260103-cccccccccccc", createdAt: "2026-01-03T00:00:00Z", status: "completed", active: true, log: "stale-active" });
  seedTask(remote, { taskId: "task-20260809-dddddddddddd", createdAt: "2026-08-09T00:00:00Z", status: "completed", pinned: true, log: "pinned" });
  seedTask(remote, { taskId: "task-20260809-ffffffffffff", createdAt: "2026-08-09T01:00:00Z", status: "completed", log: "x".repeat(1100000) });
  const broken = seedTask(remote, { taskId: "task-20260104-eeeeeeeeeeee", createdAt: "2026-01-04T00:00:00Z", status: "failed", log: "broken" });
  remote.files.set(`${broken}/status.json`, "not-json\n");
  const index = { async stats() { return { total_rows: 0 }; } };
  const service = new RemoteTaskService({ remote, index, ownerKey: "a".repeat(64), now: () => new Date("2026-08-10T12:34:56Z") });

  const storage = await service.storage({ refresh: true });
  assert.equal(storage.remote_store.task_count, 5);
  assert.equal(storage.remote_store.unresolved_task_count, 1);
  assert.ok(storage.remote_store.unresolved_task_bytes > 0);
  assert.equal(storage.remote_store.active_marker_count, 1);
  assert.equal(storage.remote_cleanup_enabled, false);

  const preview = await service.cleanupPreview({ retentionDays: 30, quotaBytes: 1024 * 1024 * 1024, limit: 10 });
  assert.deepEqual(preview.candidates.map((candidate) => candidate.task_id), ["task-20260101-aaaaaaaaaaaa"]);
  assert.equal(preview.protected.active_marker, 1);
  assert.equal(preview.protected.pinned, 1);
  assert.equal(preview.protected.non_final_or_unresolved, 1);
  assert.equal(preview.protected.unresolved_record, 1);
  assert.equal(preview.remote_records_removed, 0);
  assert.equal(remote.removals.length, 0);

  const quotaPreview = await service.cleanupPreview({ retentionDays: 3650, quotaBytes: 1024 * 1024, limit: 10 });
  assert.deepEqual(quotaPreview.candidates.map((candidate) => candidate.task_id), ["task-20260101-aaaaaaaaaaaa", "task-20260809-ffffffffffff"]);
  assert.ok(quotaPreview.candidates.every((candidate) => candidate.reasons.includes("quota_exceeded")));
  assert.equal(quotaPreview.quota_satisfied, true);
  assert.equal(quotaPreview.projected_over_quota_bytes, 0);
});

test("pinning is reversible and explicit record deletion stays inside the managed task directory", async () => {
  const remote = new FakeRemote();
  const taskId = "task-20260101-aaaaaaaaaaaa";
  const dir = seedTask(remote, { taskId, createdAt: "2026-01-01T00:00:00Z", status: "completed", log: "finished" });
  const index = {
    pinned: null,
    removed: null,
    upsert(_owner, record) { this.pinned = record.pinned === true; },
    remove(_owner, id) { this.removed = id; return true; },
  };
  const service = new RemoteTaskService({ remote, index, ownerKey: "a".repeat(64), recordDeletionEnabled: true });

  const pinned = await service.pin(taskId);
  assert.equal(pinned.pinned, true);
  assert.equal(index.pinned, true);
  assert.ok(remote.files.has(`${dir}/pinned.json`));
  await assert.rejects(() => service.deleteRecord(taskId, { confirm_task_id: taskId, delete_scope: "bridge_task_record_only" }), /pinned task records/);

  const unpinned = await service.unpin(taskId);
  assert.equal(unpinned.pinned, false);
  assert.equal(index.pinned, false);
  await assert.rejects(() => service.deleteRecord(taskId, { confirm_task_id: "task-20260101-wrongwrongwrong", delete_scope: "bridge_task_record_only" }), /requires confirm_task_id/);

  const deleted = await service.deleteRecord(taskId, { confirm_task_id: taskId, delete_scope: "bridge_task_record_only" });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.user_artifacts_removed, 0);
  assert.equal(index.removed, taskId);
  assert.equal(remote.directories.has(dir), false);
  assert.equal([...remote.files.keys()].some((file) => file.startsWith(`${dir}/`)), false);
});

test("record deletion rejects disabled, active, unresolved, and unsupported task records", async () => {
  const remote = new FakeRemote();
  const finalId = "task-20260101-aaaaaaaaaaaa";
  const finalDir = seedTask(remote, { taskId: finalId, createdAt: "2026-01-01T00:00:00Z", status: "completed" });
  const disabled = new RemoteTaskService({ remote });
  await assert.rejects(() => disabled.deleteRecord(finalId, { confirm_task_id: finalId, delete_scope: "bridge_task_record_only" }), /deletion is disabled/);

  const enabled = new RemoteTaskService({ remote, recordDeletionEnabled: true });
  remote.files.set(`.remote-control-bridge/tasks/active/${finalId}.json`, "{}\n");
  await assert.rejects(() => enabled.deleteRecord(finalId, { confirm_task_id: finalId, delete_scope: "bridge_task_record_only" }), /active marker/);
  remote.files.delete(`.remote-control-bridge/tasks/active/${finalId}.json`);

  const unresolvedId = "task-20260102-bbbbbbbbbbbb";
  seedTask(remote, { taskId: unresolvedId, createdAt: "2026-01-02T00:00:00Z", status: "interrupted" });
  await assert.rejects(() => enabled.deleteRecord(unresolvedId, { confirm_task_id: unresolvedId, delete_scope: "bridge_task_record_only" }), /only completed/);

  remote.files.set(`${finalDir}/unexpected.bin`, "do-not-touch");
  const before = remote.removals.length;
  await assert.rejects(() => enabled.deleteRecord(finalId, { confirm_task_id: finalId, delete_scope: "bridge_task_record_only" }), /unsupported entry/);
  assert.equal(remote.removals.length, before);
  assert.ok(remote.files.has(`${finalDir}/unexpected.bin`));
});
