---
name: remote-control-bridge
description: Operate user-authorized SSH hosts through a loopback-only Node.js SSH/SFTP bridge with a browser workspace, Agent APIs, command execution, file operations, and optional long-task observation. Use when Codex needs remote shell or SFTP access without making direct SSH connections from the sandbox.
---

# Remote Control Bridge

## Positioning

Treat this skill as a local SSH/SFTP proxy. The remote operating system, shell, SFTP server, account permissions, quotas, and network policy are authoritative. Do not invent training-, checkpoint-, dataset-, compiler-, or framework-specific behavior.

Core surfaces are SSH sessions, commands, terminals, SFTP files, and scoped Agent access. Persistent Tasks and host metrics are optional enhancements layered on top of the same session.

## Runtime boundary

- Control, Session, and Bridge are host-side processes. Ask the user to start, restart, or stop them from a normal host terminal.
- Never make direct SSH connections from the sandbox. Use the loopback API after the host services are running.
- The Node runtime is the supported implementation for Windows, Linux, and macOS. Remote metrics and optional Persistent Tasks currently target POSIX/Linux hosts.
- Do not claim that a real SSH transport loss can be automatically reconnected: passwords are never persisted.

## Start and inspect

Resolve the directory containing this file as `<skill-root>`.

1. Require Node.js 20 or newer.
2. Run `npm ci` in `<skill-root>/node` after a fresh install or dependency change.
3. Start services in Control, Session, Bridge order.

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<skill-root>\manage-services-node.ps1" Start All
powershell -NoProfile -ExecutionPolicy Bypass -File "<skill-root>\manage-services-node.ps1" Status All
```

Other hosts with Node.js:

```text
node <skill-root>/node/manage-services-node.mjs Start All
node <skill-root>/node/manage-services-node.mjs Status All
```

Open `http://127.0.0.1:8877/` after the services report ready. Use `--data-dir <absolute-path>` or `-DataDir <absolute-path>` when runtime state must live outside the skill directory.

## Browser workspace

- Confirm an unknown SSH SHA-256 host fingerprint before accepting it.
- Prefer Ed25519 key authentication. Passwords are connection-only secrets.
- Use Overview for optional host status, Terminal for commands, Files for SFTP operations, and Tasks only when the optional Persistent Task API is enabled.
- Uploads target the currently opened directory in the browser. Downloads and transfers use the active SSH session.
- Browser recovery restores a still-live Session through a host-only HttpOnly cookie. It does not recover passwords or recreate a dead SSH transport.
- SSH protocol keepalives keep an otherwise healthy idle connection alive. Explicit disconnect, Session shutdown, or a real transport loss ends it.

## Agent access

Require the user to enable Agent access for the active SSH session. Grants are bound to host, port, username, and confirmed SSH fingerprint; Session renews an enabled grant indefinitely while the SSH transport remains alive.

- `status:read`: session discovery and host status.
- `jobs:read`: terminal inventory, job state, and event streams.
- `jobs:execute`: command submission.
- `jobs:cancel`: job cancellation.
- `files:read`: directory listings, previews, media, downloads, and log reads.
- `files:write`: direct SFTP file writes, uploads, directory creation, renames, and deletes.
- `tasks:read`, `tasks:execute`, `tasks:cancel`: optional Bridge-managed task records.
- `tasks:delete`: separately enabled deletion of one final Bridge task record, if the optional feature is explicitly enabled.

Use these loopback endpoints:

```text
GET    /api/v1/agent/session
GET    /api/v1/agent/status
GET    /api/v1/agent/terminals
GET    /api/v1/agent/proxy
POST   /api/v1/agent/proxy
DELETE /api/v1/agent/proxy
POST   /api/v1/agent/commands
GET    /api/v1/agent/jobs/<job-id>
GET    /api/v1/agent/jobs/<job-id>/events
DELETE /api/v1/agent/jobs/<job-id>
GET    /api/v1/agent/files?path=<relative-path>
GET    /api/v1/agent/files/preview?path=<relative-path>
GET    /api/v1/agent/files/media?path=<relative-path>
GET    /api/v1/agent/files/download?path=<relative-path>
PUT    /api/v1/agent/files/content
PUT    /api/v1/agent/files/upload?path=<relative-path>
POST   /api/v1/agent/files/mkdir
POST   /api/v1/agent/files/rename
DELETE /api/v1/agent/files?path=<relative-path>
POST   /api/v1/agent/logs
```

File operations do not add business-level size, overwrite, or permission policy. Remote SFTP/SSH responses are authoritative. The bridge only rejects path traversal and keeps services loopback-only.

## Jobs and optional Persistent Tasks

- Use `POST /api/v1/agent/commands` to submit commands. Commands have no automatic timeout by default; pass a positive `timeout_seconds` only when an explicit command-level timeout is desired. Observe the returned job until a terminal state or cancel it explicitly.
- Use `POST /api/v1/agent/proxy` to create a session-scoped SOCKS5 proxy on the remote loopback interface. Pass `proxy: true` in a command request to inject temporary `ALL_PROXY`/`HTTP_PROXY`/`HTTPS_PROXY` variables for that command. Use `DELETE /api/v1/agent/proxy` when finished.
- A proxy-enabled command request looks like `{ "command": "python -m pip install ...", "proxy": true }`; the bridge also sets `PIP_PROXY` for pip-compatible clients. SOCKS support still depends on the remote client and its installed dependencies.
- Use `POST /api/v1/agent/tasks` only for work expected to outlive the current observation turn. Record the returned `task_id`, stop observing after a short snapshot, and query it later through task status/history/log endpoints.
- Persistent Tasks are disabled by default and must be enabled by the host launcher. They are domain-neutral and do not imply checkpoint recovery or any training behavior.
- A task continuing after browser closure depends on remote launcher and operating-system behavior. Never infer that a task stopped merely because local observation stopped.

## Safety and validation

- Keep every service on `127.0.0.1`; do not expose a general-purpose network proxy.
- The SOCKS proxy is reachable only from the connected remote SSH session's loopback interface, uses the existing SSH connection, and is never installed as a remote service. Its remote port is temporary and is removed when the proxy is stopped or the SSH session closes.
- Never put passwords, private keys, tokens, runtime state, logs, `data/`, `node-data/`, `.runtime/`, `.deps/`, or `node_modules/` in skill output.
- Run from `<skill-root>/node`:

```text
npm test
node --check sessiond.mjs
node --check bridge-control.mjs
node --check bridge-api.mjs
```

Use local fakes, temporary directories, and isolated ports for fault tests. Do not reboot or modify a user's real remote host merely to simulate failure.
