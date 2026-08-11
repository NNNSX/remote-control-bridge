# Remote Control Bridge

Loopback-only local bridge for temporary SSH sessions, server dashboards, bounded parallel command jobs, log reads, and optional staging of a small, preconfigured set of verified artifacts. It does not store passwords, accept arbitrary download URLs, bind a public port, or provide a general proxy.

See [`OPTIMIZATION_PLAN.md`](OPTIMIZATION_PLAN.md) for the staged reliability, security, PTY, SFTP, dashboard, and persistence roadmap.
See [`FINAL_REFACTOR_PLAN.md`](FINAL_REFACTOR_PLAN.md) for the final cross-platform Node.js architecture and migration plan.
See [`UI_QA_CHECKLIST.md`](UI_QA_CHECKLIST.md) for the required desktop/mobile and nested-container layout checks.

## Node.js Runtime

The cross-platform replacement lives in `node/` and requires Node.js 20 or newer. It keeps the same loopback-only split: Control (`8878`), Session (`8879`), and browser API (`8877`). The three services are host-side processes: start, stop, and restart them from a normal host terminal, never from a Codex/sandboxed shell. A sandbox may use the loopback API after startup, but must not launch the services or open SSH sockets directly. After a fresh install, run `npm ci` in `node/`. On Windows, set `$SkillRoot` to this directory and run:

```powershell
$SkillRoot = (Resolve-Path ".").Path
powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillRoot\manage-services-node.ps1" Start All
powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillRoot\manage-services-node.ps1" Status All
```

Persistent Task APIs are experimental and disabled by default. Enable them explicitly when starting or restarting the host services:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillRoot\manage-services-node.ps1" Start All -EnablePersistentTasks
```

Existing Agent grants do not silently gain task permissions. After enabling the feature, turn `允许本地 Agent` off and on once for the active SSH session to issue a new fingerprint-bound grant.

Explicit deletion of one Bridge-managed remote task record has a separate, default-off gate. It also adds the separately scoped `tasks:delete` permission, so enable it only with a full Control and Session restart, then renew the Agent grant:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillRoot\manage-services-node.ps1" Restart All -EnablePersistentTasks -EnableRemoteTaskDeletion
```

The Node API supports password or Ed25519 key authentication, explicit host-key trust, 15-minute sliding SSH sessions, bounded asynchronous jobs with SSE output, up to four reusable terminal slots, scoped Control grants for local-Agent access, status collection, and guarded SFTP file operations. The browser workspace provides Overview, Terminal, Tasks, Files, and Logs views, with resumable upload management integrated into Files. Runtime PID metadata, generated service keys, grants, transfer metadata, and logs use a sibling `node-data` directory by default; pass a custom data directory to the launcher when needed. SSH passwords are never persisted.

### Restart scope

- Frontend-only changes (`assets/`) are loaded per request; refresh the browser and do not restart any service.
- Session backend changes (`node/sessiond.mjs`) require restarting **Session**; this intentionally drops current SSH sessions.
- Browser API changes (`node/bridge-api.mjs`) require restarting **Bridge**, but do not need to drop Session when Session is left running.
- Authorization changes (`node/bridge-control.mjs`) require restarting **Control** only when its process code changes.

When the target is on a campus or private LAN, start/restart **Session** from a normal Windows PowerShell window rather than a restricted Codex shell. A Session process inherits its launcher's network policy; if it was started inside a restricted environment, SSH may fail before authentication with `connect EACCES host:22`. The browser and loopback Bridge can remain unchanged.

Stop the Node services before switching runtimes:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillRoot\manage-services-node.ps1" Stop All
```

## Prepare SSH First

The default page accepts an SSH host, port, username, and password for one temporary session, with password authentication selected by default. “保存连接配置” and “允许本地 Agent” are enabled by default; saved profiles contain only host, port, username, protocol, and authentication method, and matching profiles are updated instead of duplicated. The SSH password is never stored. Selecting a saved profile fills those fields and leaves the password blank for fresh entry. The remote user's home directory is used automatically. Passwords are sent only to the loopback bridge, used for the SSH handshake, cleared from the browser after success, and never written to configuration, audit output, or disk. On a first connection, the bridge shows the SSH SHA-256 host-key fingerprint. Verify it through a trusted channel before confirming; the bridge then stores that public host key in its own `known_hosts` trust file, without reading or changing the system OpenSSH key store. A page refresh preserves the active daemon-owned SSH connection by keeping only its random session ID in tab-scoped `sessionStorage`; the refreshed page validates that ID and restores status, terminals, files, monitoring, tasks, and Agent UI state. A newly opened tab has no tab-scoped session ID, so it may adopt the existing SSH session through `GET /api/v1/agent/session` only while that exact fingerprint-bound Agent grant remains active. No password is recovered or persisted. Clicking Disconnect, disabling Agent access, or restarting Session invalidates the corresponding recovery path.

Do not put passwords, private keys, tokens, shell commands, or `HTTP_PROXY` settings in the optional bridge configuration.

## Local Agent Commands

After connecting, enable `允许本地 Agent` in the page. A loopback-only agent can then discover the authorized session, execute commands, and use guarded read-only file operations:

```text
GET  /api/v1/agent/session
POST /api/v1/agent/commands
Content-Type: application/json

{"command":"pwd && nvidia-smi","timeout_seconds":120}
```

Commands are asynchronous and return a job ID plus a terminal ID. Poll `GET /api/v1/agent/jobs/<job-id>` for completion and use `GET /api/v1/agent/terminals` to inspect the controlled parallel terminal slots. The browser uses the equivalent session-scoped endpoints.

Use `GET /api/v1/agent/jobs/<job-id>/events` for an SSE stream of `status`, `stdout`, `stderr`, and `end` events. Cancel a running job with `DELETE /api/v1/agent/jobs/<job-id>`.

Read-only Agent file endpoints are:

```text
GET  /api/v1/agent/files?path=.
GET  /api/v1/agent/files/preview?path=<relative-path>
GET  /api/v1/agent/files/media?path=<relative-path>
GET  /api/v1/agent/files/download?path=<relative-path>
POST /api/v1/agent/logs
Content-Type: application/json

{"path":"logs/train.log","lines":200}
```

Agent access does not include file writes, uploads, renames, or deletes. Those operations remain session-scoped browser actions so the user can confirm them directly.

When the experimental persistent-task flag is enabled, Agent access also exposes a managed task namespace. It accepts structured argv and writes only Bridge-owned records under `~/.remote-control-bridge/tasks`; it does not grant general remote file-write access:

```text
GET  /api/v1/agent/tasks/capabilities
POST /api/v1/agent/tasks
GET  /api/v1/agent/tasks
GET  /api/v1/agent/tasks/history?status=completed&limit=50&cursor=<cursor>
GET  /api/v1/agent/tasks/storage?refresh=true
GET  /api/v1/agent/tasks/cleanup-preview?retention_days=30&quota_bytes=2147483648&limit=100
GET  /api/v1/agent/tasks/<task-id>
GET  /api/v1/agent/tasks/<task-id>/logs?stream=stdout&offset=0&max_bytes=65536
POST /api/v1/agent/tasks/<task-id>/cancel
POST /api/v1/agent/tasks/<task-id>/pin
POST /api/v1/agent/tasks/<task-id>/unpin
POST /api/v1/agent/tasks/<task-id>/delete-record
POST /api/v1/agent/tasks/maintenance
POST /api/v1/agent/tasks/reconcile
```

Task creation, reconciliation, and explicit maintenance use `tasks:execute`; history, storage statistics, cleanup previews, and offset logs use `tasks:read`; cancellation uses `tasks:cancel`. Launchers are capability-probed per SSH session; unavailable or unverified adapters are not selected. On Node.js runtimes with `node:sqlite`, non-sensitive history summaries use a local WAL database partitioned by the confirmed SSH binding and paginated with opaque cursors. Local maintenance keeps final summaries for 90 days and at most 10,000 final rows per owner. It can prune only `completed`, `failed`, and `cancelled` summaries; `active`, `unknown`, and `interrupted` rows are protected.

Bridge task records are domain-neutral. They persist execution metadata, status, bounded logs, resource hints, and lifecycle state only; they do not model training checkpoints, model formats, resume flags, datasets, or other project-specific semantics. The Agent may use the guarded Files API when the user or project explicitly provides a path, but the Bridge never scans, guesses, parses, hashes, or automatically resumes domain artifacts.

Agent observation is intentionally separate from task execution. Use ordinary Agent jobs for bounded interactive commands; use Persistent Tasks for work expected to exceed 120 seconds or survive browser/SSH observation loss. Task creation returns immediately with a `task_id`. The Agent observes for at most 30 seconds by default, then returns the current status, bounded log snapshot, byte offset, launcher reliability, and follow-up endpoints without cancelling the remote task. Later turns or the browser Task Center can resume observation by task ID; a local timeout or disconnected session is not evidence that the remote task stopped.

Remote storage accounting scans only the fixed Bridge-managed tree `~/.remote-control-bridge/tasks/{active,history/YYYY/MM/DD/task-*}`. Scans are cached for 60 seconds and bounded to 10,000 task records and 100,000 directory entries; `refresh=true` bypasses the cache. Corrupt or unrecognized records are counted as protected storage and are never cleanup candidates. The cleanup-preview endpoint applies a default 30-day retention policy and 2 GiB quota, but it is strictly read-only: `remote_records_removed` is always zero, while `deletion_enabled` only reports whether the separate explicit single-record gate is active. A preview never removes remote task records, logs, checkpoints, datasets, weights, code, work directories, or output directories. Node.js 20 runtimes without `node:sqlite` keep the core remote Task API available but return an explicit error for local history, combined storage, and maintenance queries.

The browser Task Center exposes current and historical records, status filtering with cursor pagination, remote/local storage summaries, task metadata, independent stdout/stderr offset reads, running-log auto-follow, cancellation, pin/unpin, read-only cleanup preview, and a compact GPU snapshot. Selected non-final tasks are status-verified every five seconds while the Tasks view remains open. Status observation is independent from log auto-follow, backs off after an error, and stops when the task reaches a final state or the user leaves the view. It deliberately exposes no task-record delete control, even when the backend's separate deletion gate exists. At normal desktop height the view fills the browser workspace; short desktop windows use a minimum-height scrolling fallback, and narrow screens stack the task list and detail panes.

For newly created tasks, a numeric `CUDA_VISIBLE_DEVICES` value is reduced to a non-sensitive manifest hint such as `resources.gpu_devices=[3,4]`; the full environment object, variable name, opaque GPU UUID, and original selector are not copied into `task.json` or SQLite. The Task Center uses that hint to select physical GPU cards from the latest host-status sample. Existing records and selectors that cannot be mapped to physical indices show the host GPU snapshot with an explicit “未记录任务绑定” or “无法映射” warning. GPU utilization is observational host data, not proof that a process belongs to the task. This manifest change is in the Session backend and takes effect for new tasks only after Session is reloaded.

Pin and unpin use `tasks:execute`. A pinned record is protected from local maintenance, cleanup previews, and explicit deletion. Single-record deletion uses `tasks:delete`, is unavailable unless `-EnableRemoteTaskDeletion` or `--remote-task-deletion true` was supplied, and requires this exact confirmation body:

```json
{"confirm_task_id":"task-YYYYMMDD-...","delete_scope":"bridge_task_record_only"}
```

Deletion accepts only `completed`, `failed`, or `cancelled` records with no active marker and no pin. It refuses nested directories, special files, unknown filenames, mismatched confirmation, and unresolved states. It removes only the validated task directory under `~/.remote-control-bridge/tasks/history`; `workdir`, output directories, checkpoints, weights, datasets, code, and every other user path are outside the operation. There is no bulk or automatic remote deletion endpoint.

Commands start in the remote user's home directory. A session has at most four terminal slots, reuses idle slots, and opens another slot only when the selected slot is busy or `new_terminal: true` is requested. Commands are limited to 64 KiB, each output stream to 4 MiB, and a caller-selected integer timeout from 1 to 3600 seconds with a 120-second default. Disabling Agent access or disconnecting immediately removes status, command, and read-only file access.

The Files tab uses SFTP rather than shell-built paths. Uploads stream through the loopback Bridge and are limited to 64 MiB per file. Text edits remain limited to 1 MiB and previews to 256 KiB. Downloads are streamed as attachments; delete handles files and empty directories only, and the configured tree root cannot be deleted. Sensitive paths such as `.ssh`, `.env*`, cloud credentials, private keys, and secret files remain blocked.

## Configure And Run

An optional config file enables reusable allowlisted profiles and artifact staging. Limit every configured log and artifact to an exact path or immutable HTTPS URL with a SHA-256.

The configured `artifact_root` must already exist on the remote host. The bridge never creates it implicitly.

```text
python bridge.py --port 8877
python bridge.py --config PATH --port 8877
```

### Optional Authorization Control Plane

Run the authorization service separately when Agent approval should survive a Bridge feature-service restart:

```text
python control_plane.py --port 8878
python bridge.py --config PATH --port 8877 --control-url http://127.0.0.1:8878
```

The control plane is loopback-only. It stores signed, host-bound grants in `data/control_grants.json` and the signing key in `data/control_signing.key`; it never receives SSH passwords and never executes remote commands. Enabling Agent access creates a 24-hour grant for status and bounded job operations, while disabling it revokes that grant immediately. Without `--control-url`, the legacy in-memory authorization mode remains active.

Keep port 8878 private and restrict the signing-key file ACL to the Windows account running the services.

### SSH Session Daemon

`sessiond.py` owns `BridgeState`, SSH clients, jobs, and terminal slots behind a key-protected loopback API on port 8879. The browser-facing Bridge can proxy all session and Agent operations to it:

```text
python sessiond.py --port 8879 --control-url http://127.0.0.1:8878 --control-key-file data/control_signing.key
python bridge.py --port 8877 --session-url http://127.0.0.1:8879 --session-key-file data/sessiond.key
```

Its internal API requires `X-Session-Key`, backed by the generated `data/sessiond.key`. In this mode, restarting only `bridge.py` preserves SSH connections and running jobs in `sessiond`. Restarting `sessiond.py` still drops ordinary SSH sessions because passwords are intentionally not persisted. Existing sessions created by an older, embedded Bridge process are not migrated automatically.

On Windows, `manage-services.ps1` starts the three services independently in hidden processes in this order: Control, Session, Bridge. It stores only PID metadata and service logs under `data`; it never reads or stores SSH passwords.

```powershell
# Start both services, then inspect their status.
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-services.ps1 Start All
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-services.ps1 Status All

# Restart only the browser/API service while leaving SSH sessions and grants available.
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-services.ps1 Restart Bridge

# Restart sessiond only when dropping current SSH sessions is acceptable.
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-services.ps1 Restart Session

# Stop either service, or stop both (Bridge is stopped first).
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-services.ps1 Stop Bridge
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-services.ps1 Stop All
```

Use `-ConfigPath PATH`, `-BridgePort`, or `-ControlPort` when overriding defaults. PID files protect against killing a reused PID by recording and checking the process start time. A service which does not stop within 10 seconds is reported and is not force-killed.

Open the printed `http://127.0.0.1:8877/` URL locally. Enter the temporary SSH session details, then read its status or a bounded log. Artifact staging requires an explicit local browser confirmation, downloads only a configured HTTPS URL, verifies its configured SHA-256 and size cap, then transfers it to the configured remote root.

### Windows `EACCES` troubleshooting

If the page reports `connect EACCES <host>:22` while ordinary PowerShell `ssh` works, the three Node services were started inside a restricted network context. Stop and restart them from a normal or elevated PowerShell window:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillRoot\manage-services-node.ps1" Stop All
powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillRoot\manage-services-node.ps1" Start All
```

This error occurs before SSH authentication and does not indicate a bad password or an untrusted host key. Confirm the path with `Test-NetConnection <host> -Port 22` before retrying the web page.

## Boundaries

### Fault-test safety

Recovery testing is isolated from the user's remote environment. Automated tests use local mocks, temporary storage, disposable service processes, and injected stream/filesystem failures. They do not reboot the remote server, fill or remount its filesystem, corrupt remote task records, install a remote helper, or alter user artifacts. A real remote smoke test is limited to a short authorized read-only command; remote reboot, disk-pressure, and destructive fault injection are out of scope.

- The HTTP server binds only to `127.0.0.1` and rejects foreign `Host` and `Origin` headers.
- Arbitrary commands require an already-authenticated temporary SSH session. Local Agent discovery and execution remain disabled until explicitly enabled in the page.
- Read operations use `BatchMode=yes`, bounded SSH timeouts, configured paths, and 64 KiB redacted log output.
- A configured artifact is still a write operation. Review its URL, SHA-256, destination, and disk impact before confirming it.
- This bridge is an accidental-misuse guard. Strong remote enforcement requires a separate restricted remote account and an administrator-owned forced-command gateway.

## Verify

```text
python -m unittest discover -s tests -v
python -m compileall -q .
```
