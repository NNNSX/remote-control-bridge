---
name: remote-control-bridge
description: Operate user-authorized SSH hosts through a loopback-only Node.js bridge with a browser dashboard, bounded asynchronous command jobs, scoped local-Agent access, guarded SFTP file operations, and resumable tus uploads. Use when Codex needs to inspect or control a remote development, operations, laboratory, GPU, or deep-learning server without opening direct SSH connections from the sandbox.
---

# Remote Control Bridge

## Respect the runtime boundary

- Treat Control, Session, and Bridge as host-side processes.
- Ask the user to start, restart, or stop them from a normal host terminal. Never launch them from a Codex or sandboxed shell.
- Never make direct SSH connections from the sandbox. Use the loopback API only after the host services are running.
- Diagnose `connect EACCES host:22` as a host launch-context or network-policy failure before authentication.

## Prepare the runtime

Resolve the directory containing this file as `<skill-root>`.

1. Require Node.js 20 or newer.
2. Run `npm ci` in `<skill-root>/node` after a fresh install or dependency change.
3. Start services in Control, Session, Bridge order.

On Windows, have the user run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<skill-root>\manage-services-node.ps1" Start All
powershell -NoProfile -ExecutionPolicy Bypass -File "<skill-root>\manage-services-node.ps1" Status All
```

On any supported host with Node.js, use:

```text
node <skill-root>/node/manage-services-node.mjs Start All
node <skill-root>/node/manage-services-node.mjs Status All
```

Use `--data-dir <absolute-path>` with the Node launcher or `-DataDir <absolute-path>` with PowerShell when runtime state should not use the default sibling `node-data` directory.

## Use the browser workspace

Open `http://127.0.0.1:8877/` after all services report running.

- Confirm an unknown SSH SHA-256 fingerprint through a trusted channel before accepting it.
- Prefer Ed25519 key authentication. Treat passwords as connection-only secrets and never store or repeat them.
- Use Overview for host metrics, Terminal for bounded jobs, Tasks for persistent-task discovery and monitoring, Files for guarded SFTP browsing, downloads, image previews, and resumable uploads to the currently opened directory, and Logs for bounded text reads.
- In Tasks, use Current or History as appropriate, filter history before paging, select a record for metadata and offset logs, switch stdout/stderr independently, and use 从头读取 only when the earlier retained log is required. Selected non-final task status is verified every five seconds while the view is open, independently of the log auto-follow checkbox. Leaving Tasks or reaching a final state stops the corresponding observer; stopping observation does not cancel the task.
- Treat the task GPU panel as an observation, not process attribution. New tasks with a numeric `CUDA_VISIBLE_DEVICES` store only normalized physical indices in `manifest.resources`; the complete environment and opaque selectors are not copied to the manifest. Old or unmappable records show an explicitly unbound host snapshot.
- Treat storage cleanup in Tasks as preview-only. Pin/unpin and task cancellation are available, but the browser intentionally exposes no task-record deletion control.
- A fresh browser tab may recover the existing SSH session through `GET /api/v1/agent/session` only while the user-authorized, fingerprint-bound Agent grant is active. This recovery does not retrieve or persist an SSH password; otherwise use the normal connection form.
- Expect a 15-minute sliding idle lifetime for SSH sessions and at most four reusable terminal slots per session.
- Refresh the page for frontend-only changes. Restart Bridge for API proxy changes, Session for SSH/session changes, and Control for authorization changes.

## Use scoped Agent access

Require the user to enable local Agent access for the active SSH session in the browser. Control grants are bound to host, port, username, and confirmed SSH fingerprint, expire within 24 hours, and are checked on every Agent operation.

- Use `status:read` for session discovery and host status.
- Use `jobs:read` for terminals, job status, and event streams.
- Use `jobs:execute` for command submission.
- Use `jobs:cancel` for cancellation.
- Use `files:read` for guarded directory listings, text previews, image/media reads, downloads, and bounded log tails.
- When the explicitly enabled experimental Task API is present, use `tasks:read`, `tasks:execute`, and `tasks:cancel` only for Bridge-managed records under `~/.remote-control-bridge/tasks`. The separately gated `tasks:delete` scope is only for confirmed deletion of one final Bridge task record.
- Do not expect Agent file writes, uploads, renames, or deletes; those remain browser-session operations requiring direct user interaction.
- Treat disabling Agent access as immediate grant revocation.

Use the loopback endpoints:

```text
GET    /api/v1/agent/session
GET    /api/v1/agent/status
GET    /api/v1/agent/terminals
POST   /api/v1/agent/commands
GET    /api/v1/agent/jobs/<job-id>
GET    /api/v1/agent/jobs/<job-id>/events
DELETE /api/v1/agent/jobs/<job-id>
GET    /api/v1/agent/files?path=<relative-path>
GET    /api/v1/agent/files/preview?path=<relative-path>
GET    /api/v1/agent/files/media?path=<relative-path>
GET    /api/v1/agent/files/download?path=<relative-path>
POST   /api/v1/agent/logs
GET    /api/v1/agent/tasks/capabilities
POST   /api/v1/agent/tasks
GET    /api/v1/agent/tasks
GET    /api/v1/agent/tasks/history
GET    /api/v1/agent/tasks/storage
GET    /api/v1/agent/tasks/cleanup-preview
GET    /api/v1/agent/tasks/<task-id>
GET    /api/v1/agent/tasks/<task-id>/logs
POST   /api/v1/agent/tasks/<task-id>/cancel
POST   /api/v1/agent/tasks/<task-id>/pin
POST   /api/v1/agent/tasks/<task-id>/unpin
POST   /api/v1/agent/tasks/<task-id>/delete-record
POST   /api/v1/agent/tasks/maintenance
POST   /api/v1/agent/tasks/reconcile
```

Submit short commands as structured JSON, follow their job events until a terminal state, and cancel explicitly when requested.

### Choose Jobs Or Persistent Tasks

Use the two execution surfaces deliberately:

- Use `POST /api/v1/agent/commands` for bounded interactive work, PTY-like terminal use, or commands expected to finish within the normal command timeout.
- Use `POST /api/v1/agent/tasks` for work expected to exceed 120 seconds, long builds, experiments, data processing, or anything that must survive the browser, Agent observation, or SSH Session going away. Persistent Tasks require safe structured `argv`, `workdir`, and environment data; they are not a replacement for interactive terminal input.
- A successful Task creation returns `202` and a `task_id`. Record that ID immediately. Do not keep the creating request or an Agent turn open until the remote process finishes.
- After creation, observe the task for at most 30 seconds by default, polling status about every 5 seconds and reading bounded log chunks from the current byte offset. If it is still non-final, return a snapshot containing the task ID, status, latest log summary, next offset, launcher reliability, and the exact follow-up endpoints, then stop observing. Stopping observation never cancels the task and does not impose a remote runtime limit.
- Resume observation only when the user asks, when a later turn has the task ID, or when the browser Task Center is opened. Prefer the task ID and history/reconcile endpoints over creating a duplicate task.
- If the Agent grant or SSH Session disappears, recover the authorized session when possible, then query current tasks or history. Never infer that the remote task stopped merely because the local request, browser, or computer stopped.
- Send `POST /api/v1/agent/tasks/<task-id>/cancel` only after an explicit user request or a clearly authorized safety action. Report `best_effort` launcher reliability as such; do not promise survival across host shutdown or user-manager logout.
- If the Task API is disabled, the request contains secrets or requires interactive input, or no persistent launcher is available, use a bounded Job only with an explicit warning that it is tied to the current session and observation window.

Keep task handling domain-neutral. Do not add training, checkpoint, model, dataset, compiler, or framework-specific fields to task requests or manifests. If a project-specific continuation or recovery command is needed, inspect the project instructions and submit a new ordinary task with caller-supplied argv; never infer resume flags or parse artifact contents. Use the guarded Files API only for exact user- or project-provided paths, and preserve the existing binary and large-file preview limits.

Local task-history maintenance is bounded per confirmed SSH owner: final summaries are retained for 90 days and capped at 10,000 rows. Only `completed`, `failed`, and `cancelled` SQLite summaries may be pruned. Never treat this as remote cleanup: `active`, `unknown`, and `interrupted` records, remote Bridge task records and logs, and all user checkpoints, datasets, weights, code, work directories, and output directories remain untouched.

Remote storage statistics and cleanup previews are read-only. They scan only the fixed Bridge-managed task tree, cache results for 60 seconds, and stop at 10,000 task records or 100,000 entries. Treat incomplete scans, corrupt records, active markers, pinned records, and non-final states as protected. The preview may identify final records by retention age or quota pressure. Never infer permission to delete from a preview.

Pinning writes only `pinned.json` inside the validated task record. Explicit record deletion is unavailable by default and requires `--remote-task-deletion true` or `-EnableRemoteTaskDeletion`, a newly issued `tasks:delete` grant, an exact task-ID confirmation, and `delete_scope=bridge_task_record_only`. It can remove only a final, unpinned record with no active marker and only recognized regular management files. Never enable or invoke it as a way to delete the task workdir, outputs, checkpoints, weights, datasets, or code. No bulk or automatic remote deletion is supported.

Persistent Task endpoints are disabled by default. Enable them only from the normal host launcher with `--persistent-tasks true` or `-EnablePersistentTasks`, then renew the browser Agent grant so the new task scopes are explicit. Enabling record deletion requires a full Control and Session reload plus `--remote-task-deletion true` or `-EnableRemoteTaskDeletion`; old grants never acquire `tasks:delete`. Treat launcher reliability as capability-specific; never describe best-effort setsid/nohup or a `Linger=no` systemd user manager as a strong persistence guarantee.

## Preserve safety boundaries

- Keep every service bound to `127.0.0.1`.
- Do not expose a SOCKS, HTTP, or general-purpose network proxy.
- Use SFTP APIs for files instead of interpolating paths into shell commands.
- Reject traversal and sensitive paths such as `.ssh`, private keys, credential files, `.env*`, cloud configuration, and secret files.
- Ask for confirmation before writes, overwrites, deletes, bulk changes, or remote network egress.
- Never include passwords, private keys, service keys, capability tokens, PID files, logs, `data/`, `node-data/`, `.runtime/`, `.deps/`, or `node_modules/` in skill output or distribution bundles.

## Validate changes

### Fault-test isolation

- Fault and recovery tests must run against local fakes, temporary directories, isolated ports, or disposable child processes.
- Do not reboot, suspend, fill, remount, corrupt, or otherwise disrupt a user's remote host to simulate failure.
- Do not install a remote daemon or test agent solely for fault injection.
- Simulate remote reboot with changed boot/process identity records; simulate network loss with failing SSH/SFTP streams; simulate quota and read-only errors with bounded local test doubles.
- Real remote smoke tests may use only a short, explicitly authorized command and must not modify user code, data, checkpoints, weights, outputs, or task records.

Run from `<skill-root>/node`:

```text
npm test
node --check sessiond.mjs
node --check bridge-control.mjs
node --check bridge-api.mjs
```

Use isolated temporary ports for service tests. Do not restart the user's live host services from the sandbox.
