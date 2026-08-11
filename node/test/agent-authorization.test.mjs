import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ssh2 from "ssh2";

const { Server: SshServer, utils: { sftp: { OPEN_MODE, STATUS_CODE } } } = ssh2;

const nodeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); }); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }
async function freePort() { const probe = http.createServer(); const port = await listen(probe); await close(probe); return port; }
function launch(script, args) { return spawn(process.execPath, [path.join(nodeDir, script), ...args], { cwd: nodeDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
}

async function waitFor(check, children, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const failed = children.find((child) => child.exitCode !== null);
    if (failed) throw new Error(`runtime child exited with ${failed.exitCode}`);
    try { const result = await check(); if (result) return result; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("runtime did not become ready");
}

function commandResult(command) {
  if (command.startsWith("for name in bash")) return ["bash=1\ndd=1\ncat=1\nmkfifo=1\nwc=1\nps=1\nawk=1\ndate=1\nmv=1\nrm=1\nchmod=1\nsetsid=1\nnohup=1\nsystemd_run=0\nsystemctl=0\nsystemd_user=unavailable\nlinger=no\n", 0];
  if (command === "hostname") return ["mock-host\n", 0];
  if (command.includes("/proc/uptime")) return ["123\n", 0];
  if (command.includes("/proc/loadavg")) return ["0.10 0.20 0.30\n", 0];
  if (command.includes("_NPROCESSORS_ONLN")) return ["4\n", 0];
  if (command.includes("/proc/stat")) return ["100 20\n200 30\n", 0];
  if (command.includes("/proc/meminfo")) return ["1000 400 600 40.0\n", 0];
  if (command.startsWith("df -Pk")) return ["/dev/root 1000 400 600 40% /home/user\n", 0];
  if (command.includes("nvidia-smi")) return ["", 1];
  if (command === "printf authorized") return ["authorized", 0];
  return ["", 0];
}

test("Agent access requires a fingerprint-bound Control grant and revokes immediately", async (context) => {
  const agentFile = Buffer.from("line 1\nline 2\nline 3\n", "utf8");
  const fileAttrs = () => ({ mode: 0o100644, uid: 1000, gid: 1000, size: agentFile.length, atime: Math.floor(Date.now() / 1000), mtime: Math.floor(Date.now() / 1000) });
  const privateKey = await fs.readFile(path.join(nodeDir, "node_modules", "ssh2", "test", "fixtures", "ssh_host_ecdsa_key"));
  const ssh = new SshServer({ hostKeys: [privateKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (auth) => auth.method === "password" && auth.username === "user" && auth.password === "pass" ? auth.accept() : auth.reject());
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        const [output, exitCode] = commandResult(info.command);
        if (output) stream.write(output);
        stream.exit(exitCode);
        stream.end();
      });
      session.on("sftp", (acceptSftp) => {
        const sftp = acceptSftp();
        const handles = new Map();
        let nextHandle = 1;
        const openHandle = (value) => { const handle = Buffer.alloc(4); handle.writeUInt32BE(nextHandle, 0); handles.set(nextHandle, value); nextHandle += 1; return handle; };
        const getHandle = (handle) => handle.length === 4 ? handles.get(handle.readUInt32BE(0)) : null;
        sftp.on("REALPATH", (reqid, remotePath) => sftp.name(reqid, [{ filename: remotePath || ".", longname: remotePath || ".", attrs: { mode: 0o040755 } }]));
        sftp.on("OPENDIR", (reqid, remotePath) => remotePath === "." ? sftp.handle(reqid, openHandle({ type: "directory", sent: false })) : sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
        sftp.on("READDIR", (reqid, handle) => {
          const entry = getHandle(handle);
          if (!entry || entry.type !== "directory") return sftp.status(reqid, STATUS_CODE.FAILURE);
          if (entry.sent) return sftp.status(reqid, STATUS_CODE.EOF);
          entry.sent = true;
          sftp.name(reqid, [{ filename: "agent.txt", longname: "-rw-r--r-- 1 user user 21 agent.txt", attrs: fileAttrs() }]);
        });
        sftp.on("OPEN", (reqid, remotePath, flags) => remotePath === "agent.txt" && (flags & OPEN_MODE.READ) ? sftp.handle(reqid, openHandle({ type: "file" })) : sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
        sftp.on("STAT", (reqid, remotePath) => remotePath === "agent.txt" ? sftp.attrs(reqid, fileAttrs()) : sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
        sftp.on("LSTAT", (reqid, remotePath) => remotePath === "agent.txt" ? sftp.attrs(reqid, fileAttrs()) : sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
        sftp.on("FSTAT", (reqid, handle) => getHandle(handle)?.type === "file" ? sftp.attrs(reqid, fileAttrs()) : sftp.status(reqid, STATUS_CODE.FAILURE));
        sftp.on("READ", (reqid, handle, offset, length) => {
          if (getHandle(handle)?.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
          if (offset >= agentFile.length) return sftp.status(reqid, STATUS_CODE.EOF);
          sftp.data(reqid, agentFile.subarray(offset, Math.min(agentFile.length, offset + length)));
        });
        sftp.on("CLOSE", (reqid, handle) => { if (handle.length === 4) handles.delete(handle.readUInt32BE(0)); sftp.status(reqid, STATUS_CODE.OK); });
      });
    }));
  });
  const sshPort = await listen(ssh);
  const [controlPort, sessionPort, bridgePort] = await Promise.all([freePort(), freePort(), freePort()]);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-agent-"));
  const children = [];
  context.after(async () => { for (const child of [...children].reverse()) await stopChild(child); await close(ssh); await fs.rm(dataDir, { recursive: true, force: true }); });

  children.push(launch("bridge-control.mjs", ["--port", String(controlPort), "--data-dir", dataDir]));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${controlPort}/api/v1/health`)).ok, children);
  children.push(launch("sessiond.mjs", ["--port", String(sessionPort), "--control-port", String(controlPort), "--data-dir", dataDir, "--persistent-tasks", "true"]));
  await waitFor(async () => fs.stat(path.join(dataDir, "sessiond.key")), children);
  children.push(launch("bridge-api.mjs", ["--port", String(bridgePort), "--session-port", String(sessionPort), "--data-dir", dataDir]));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${bridgePort}/api/v1/health`)).ok, children);

  const api = `http://127.0.0.1:${bridgePort}/api/v1`;
  const connectBody = { host: "127.0.0.1", port: sshPort, username: "user", auth_method: "password", password: "pass" };
  let response = await fetch(`${api}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(connectBody) });
  assert.equal(response.status, 409);
  const trust = await response.json();
  assert.equal(trust.trust_required, true);

  response = await fetch(`${api}/host-keys/trust`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: trust.token }) });
  assert.equal(response.status, 200);
  assert.match(await fs.readFile(path.join(dataDir, "known_hosts"), "utf8"), new RegExp(`^\\[127\\.0\\.0\\.1\\]:${sshPort} `));

  response = await fetch(`${api}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(connectBody) });
  assert.equal(response.status, 201);
  const recoveryCookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.match(recoveryCookie || "", /^rcb_session_recovery=[A-Za-z0-9_-]+$/);
  const created = await response.json();
  assert.match(created.fingerprint, /^SHA256:/);
  assert.equal(created.expires_in_seconds, null);
  assert.equal(created.idle_timeout_enabled, false);
  assert.equal(created.keepalive_interval_seconds, 30);
  assert.equal(created.keepalive_failure_threshold, 10);
  const sessionId = created.session;

  response = await fetch(`${api}/sessions/recover`, { headers: { cookie: recoveryCookie } });
  assert.equal(response.status, 200);
  const recovered = await response.json();
  assert.equal(recovered.session, sessionId);
  assert.equal(recovered.status.host, "127.0.0.1");
  assert.match(response.headers.get("set-cookie") || "", /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(`${api}/sessions/recover`, { headers: { cookie: "rcb_session_recovery=invalid" } })).status, 404);

  response = await fetch(`${api}/agent/session`);
  assert.equal(response.status, 403);
  assert.equal((await fetch(`${api}/agent/files?path=.`)).status, 403);

  response = await fetch(`${api}/sessions/${sessionId}/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).enabled, true);
  let grants = JSON.parse(await fs.readFile(path.join(dataDir, "control_grants.json"), "utf8"));
  const activeGrant = Object.values(grants).find((grant) => !grant.revoked);
  assert.deepEqual(activeGrant.scopes, ["files:read", "jobs:cancel", "jobs:execute", "jobs:read", "status:read", "tasks:cancel", "tasks:execute", "tasks:read"]);
  assert.equal(activeGrant.scopes.includes("files:write"), false);
  response = await fetch(`${api}/agent/session`);
  assert.equal(response.status, 200);
  const discovered = await response.json();
  assert.equal(discovered.expires_in_seconds, null);
  assert.equal(discovered.idle_timeout_enabled, false);

  response = await fetch(`${api}/agent/tasks/capabilities`);
  assert.equal(response.status, 200);
  const capabilities = await response.json();
  assert.equal(capabilities.base_available, true);
  assert.equal(capabilities.launchers["setsid-nohup"].available, true);
  assert.equal(capabilities.launchers["systemd-run-user"].available, false);

  response = await fetch(`${api}/agent/tasks/history?limit=10`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).tasks, []);

  response = await fetch(`${api}/agent/tasks/reconcile`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).checked, 0);

  response = await fetch(`${api}/agent/files?path=.`);
  assert.equal(response.status, 200);
  const listing = await response.json();
  assert.equal(listing.path, ".");
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["agent.txt"]);

  response = await fetch(`${api}/agent/files/preview?path=agent.txt`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, agentFile.toString("utf8"));

  response = await fetch(`${api}/agent/files/download?path=agent.txt`);
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString("utf8"), agentFile.toString("utf8"));

  response = await fetch(`${api}/agent/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "agent.txt", lines: 2 }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, "line 2\nline 3\n");

  assert.equal((await fetch(`${api}/agent/files/preview?path=.ssh/id_ed25519`)).status, 400);
  assert.equal((await fetch(`${api}/agent/files?path=.`, { method: "DELETE" })).status, 404);

  response = await fetch(`${api}/agent/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "pwd", timeout_seconds: 0 }) });
  assert.equal(response.status, 400);

  response = await fetch(`${api}/agent/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "printf authorized" }) });
  assert.equal(response.status, 202);
  const submitted = await response.json();
  const completed = await waitFor(async () => {
    const jobResponse = await fetch(`${api}/agent/jobs/${submitted.job_id}`);
    if (!jobResponse.ok) return null;
    const job = await jobResponse.json();
    return ["completed", "failed", "cancelled", "timed_out"].includes(job.status) ? job : null;
  }, children);
  assert.equal(completed.status, "completed");
  assert.equal(completed.stdout, "authorized");
  assert.equal(completed.timeout_seconds, 120);

  response = await fetch(`${api}/sessions/${sessionId}/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
  assert.equal(response.status, 200);
  assert.equal((await fetch(`${api}/agent/session`)).status, 403);
  grants = JSON.parse(await fs.readFile(path.join(dataDir, "control_grants.json"), "utf8"));
  assert.equal(Object.values(grants).every((grant) => grant.revoked), true);

  response = await fetch(`${api}/sessions/${sessionId}/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
  assert.equal(response.status, 200);
  grants = JSON.parse(await fs.readFile(path.join(dataDir, "control_grants.json"), "utf8"));
  assert.equal(Object.values(grants).some((grant) => !grant.revoked), true);
  response = await fetch(`${api}/sessions/${sessionId}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") || "", /Max-Age=0/);
  response = await fetch(`${api}/sessions/${sessionId}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).closed, false);
  assert.match(response.headers.get("set-cookie") || "", /Max-Age=0/);
  assert.equal((await fetch(`${api}/sessions/recover`, { headers: { cookie: recoveryCookie } })).status, 404);
  grants = JSON.parse(await fs.readFile(path.join(dataDir, "control_grants.json"), "utf8"));
  assert.equal(Object.values(grants).every((grant) => grant.revoked), true);
});
