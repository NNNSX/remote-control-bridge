#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Client } from "ssh2";
import { Server as TusServer } from "@tus/server";
import { authorized, loadOrCreateKey } from "./lib/auth.mjs";
import { agentScopeForRequest, enabledAgentScopes, parseCommandRequest, tailTextLines } from "./lib/agent-api.mjs";
import { createControlClient } from "./lib/control-client.mjs";
import { mediaTypeForPath } from "./lib/file-media.mjs";
import { decodeTextPreview, isKnownBinaryPath, MAX_IMAGE_PREVIEW_BYTES, MAX_TEXT_PREVIEW_BYTES } from "./lib/file-preview.mjs";
import { AGENT_GRANT_TTL_SECONDS, createTerminal, ensureTerminal, scheduleAgentGrantRenewal, sessionConnectionPolicy, sshKeepaliveOptions, stopAgentGrantRenewal } from "./lib/session-policy.mjs";
import { clearRecoveryCookie, issueSessionRecovery, recoverSession, recoveryCookie } from "./lib/session-recovery.mjs";
import { SftpTusStore } from "./lib/sftp-tus-store.mjs";
import { authorizeTusRequest } from "./lib/tus-request.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const options = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const item = process.argv[i];
  if (item.startsWith("--")) options[item.slice(2)] = process.argv[i + 1]?.startsWith("--") ? true : process.argv[++i];
}
const port = Number(options.port || 8879);
const controlPort = Number(options["control-port"] || 8878);
const dataDir = path.resolve(String(options["data-dir"] || path.join(root, "..", "data")));
const knownHostsPath = path.join(dataDir, "known_hosts");
const keyPath = path.join(dataDir, "sessiond.key");
const persistentTasksEnabled = ["1", "true", "yes"].includes(String(options["persistent-tasks"] || process.env.RCB_PERSISTENT_TASKS || "").toLowerCase());
const remoteTaskDeletionEnabled = persistentTasksEnabled && ["1", "true", "yes"].includes(String(options["remote-task-deletion"] || process.env.RCB_REMOTE_TASK_DELETION || "").toLowerCase());
const agentGrantScopes = enabledAgentScopes({ persistentTasksEnabled, remoteTaskDeletionEnabled });
let RemoteTaskService;
let createSftpTaskRemote;
let TaskIndex;
let taskOwnerKey;
if (persistentTasksEnabled) {
  ({ RemoteTaskService } = await import("./lib/remote-task-service.mjs"));
  ({ createSftpTaskRemote } = await import("./lib/sftp-task-remote.mjs"));
  ({ TaskIndex, taskOwnerKey } = await import("./lib/task-index.mjs"));
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be between 1024 and 65535");
if (!Number.isInteger(controlPort) || controlPort < 1024 || controlPort > 65535) throw new Error("--control-port must be between 1024 and 65535");

const serviceKey = await loadOrCreateKey(keyPath);
const control = await createControlClient({ dataDir, port: controlPort });
let localTaskIndex = null;
let localTaskIndexError = null;
if (persistentTasksEnabled) {
  try { localTaskIndex = await TaskIndex.open({ file: path.join(dataDir, "task-history.sqlite") }); }
  catch (error) { localTaskIndexError = error.message; }
}
const sessions = new Map();
const pendingHostKeys = new Map();
let nextJob = 1;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  try {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", ...headers });
    response.end(body);
  } catch (error) {
    if (!['EPIPE', 'ECONNRESET', 'ECONNABORTED'].includes(error?.code)) throw error;
  }
}

async function readBody(request, maxBytes = 131072) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes) throw new Error("request body is too large");
  }
  const value = JSON.parse(raw || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
  return value;
}

function id(prefix) { return `${prefix}-${crypto.randomBytes(18).toString("base64url")}`; }
function fingerprintBuffer(value) { return `SHA256:${Buffer.from(value).toString("base64").replace(/=+$/, "")}`; }
function bindingKey(host, port, username) { return `${host}|${port}|${username}`; }

async function knownFingerprints(host, port) {
  let text;
  try { text = await fs.readFile(knownHostsPath, "utf8"); } catch (error) { if (error.code === "ENOENT") return new Set(); throw error; }
  const names = new Set([host, port === 22 ? host : `[${host}]:${port}`]);
  const result = new Set();
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[0].startsWith("#")) continue;
    if (fields[0].split(",").some((name) => names.has(name))) {
      try { result.add(fingerprintBuffer(crypto.createHash("sha256").update(Buffer.from(fields[2], "base64")).digest())); } catch {}
    }
  }
  return result;
}

async function trustPending(token) {
  const pending = pendingHostKeys.get(token);
  if (!pending || pending.expires < Date.now()) throw new Error("host key confirmation expired");
  pendingHostKeys.delete(token);
  await fs.mkdir(path.dirname(knownHostsPath), { recursive: true });
  const knownHostName = pending.port === 22 ? pending.host : `[${pending.host}]:${pending.port}`;
  await fs.appendFile(knownHostsPath, `${knownHostName} ${pending.keyType} ${pending.keyBase64}\n`, { encoding: "utf8", mode: 0o600 });
  return { trusted: true, host: pending.host, port: pending.port, fingerprint: pending.fingerprint, key_type: pending.keyType };
}

async function connectSsh(data) {
  const known = await knownFingerprints(data.host, Number(data.port || 22));
  let trustError;
  let acceptedFingerprint;
  const client = new Client();
  const connection = await new Promise((resolve, reject) => {
    client.once("ready", () => resolve(client));
    client.once("error", reject);
    const config = {
      host: data.host, port: Number(data.port || 22), username: data.username,
      readyTimeout: 90000,
      ...sshKeepaliveOptions(),
      hostVerifier: (rawKey) => {
        const fp = fingerprintBuffer(crypto.createHash("sha256").update(rawKey).digest());
        if (known.has(fp)) { acceptedFingerprint = fp; return true; }
        trustError = { host: data.host, port: Number(data.port || 22), keyType: "ssh-unknown", keyBase64: Buffer.from(rawKey).toString("base64"), fingerprint: fp };
        return false;
      },
    };
    if (data.auth_method === "key") config.privateKey = requireKey();
    else config.password = data.password;
    client.connect(config);
  }).catch((error) => {
    if (trustError) {
      const token = id("trust");
      pendingHostKeys.set(token, { ...trustError, expires: Date.now() + 120000 });
      const result = new Error("SSH host key is not trusted yet");
      result.trustRequired = { token, ...trustError };
      throw result;
    }
    throw error;
  });
  return { client: connection, fingerprint: acceptedFingerprint };
}

function requireKey() {
  const file = process.env.RCB_SSH_KEY || path.join(process.env.USERPROFILE || process.env.HOME || "", ".ssh", "id_ed25519");
  return requireKeyCache(file);
}
const keyCache = new Map();
function requireKeyCache(file) {
  if (!keyCache.has(file)) keyCache.set(file, fsSync.readFileSync(file));
  return keyCache.get(file);
}

function sessionBinding(session) { return { host: session.host, port: session.port, username: session.username, fingerprint: session.fingerprint }; }
function startAgentGrantRenewal(session) {
  if (!session.agentEnabled || !session.controlGrantId) return;
  scheduleAgentGrantRenewal(session, (grantId) => control.renew(grantId, sessionBinding(session), AGENT_GRANT_TTL_SECONDS));
}
function applyAgentGrant(session, grant, restartRenewal = true) {
  session.agentEnabled = true;
  session.controlGrantId = grant.grant_id;
  session.controlGrantExpiresAt = grant.expires_at ?? grant.exp ?? null;
  if (restartRenewal || !session.agentRenewTimer) startAgentGrantRenewal(session);
  return grant;
}
async function revokeAgentGrant(session) {
  stopAgentGrantRenewal(session);
  const grantId = session.controlGrantId;
  session.agentEnabled = false;
  session.controlGrantId = null;
  session.controlGrantExpiresAt = null;
  if (grantId) { try { await control.revoke(grantId); } catch {} }
}
async function closeSession(session, endClient = true) { if (session.taskReconcileTimer) clearTimeout(session.taskReconcileTimer); sessions.delete(session.id); for (const job of session.jobs.values()) { job.cancel = true; job.stream?.close(); } if (endClient) { try { session.client.end(); } catch {} } await revokeAgentGrant(session); }
function sessionInfo(session) { return { session: session.id, host: session.host, port: session.port, username: session.username, fingerprint: session.fingerprint, agent_enabled: session.agentEnabled, ...sessionConnectionPolicy() }; }
function getSession(idValue) { const session = sessions.get(idValue); if (!session) throw new Error("unknown or disconnected session"); return session; }
async function agentSession(scope) {
  for (const session of [...sessions.values()].reverse()) {
    let authorization;
    try { authorization = await control.authorize(sessionBinding(session)); }
    catch { continue; }
    let grant = authorization.grant;
    if (!authorization.authorized && session.agentEnabled && session.controlGrantId) {
      try { grant = await control.renew(session.controlGrantId, sessionBinding(session), AGENT_GRANT_TTL_SECONDS); authorization = { authorized: true, grant }; }
      catch { stopAgentGrantRenewal(session); session.agentEnabled = false; session.controlGrantId = null; session.controlGrantExpiresAt = null; continue; }
    }
    const allowed = Boolean(authorization.authorized && grant?.scopes?.includes(scope));
    if (allowed) { applyAgentGrant(session, grant, false); return session; }
  }
  const error = new Error(`no Agent-authorized SSH session includes ${scope}`);
  error.status_code = 403;
  throw error;
}

function execOnce(client, command) {
  return new Promise((resolve, reject) => client.exec(command, (error, stream) => {
    if (error) return reject(error);
    let output = "";
    stream.on("data", (chunk) => { output += chunk.toString(); });
    stream.stderr.on("data", () => {});
    stream.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`remote status command exited with ${code}`)));
  }));
}

async function collectStatus(session) {
  let hostname = session.host;
  let uptime = null;
  let loadAverage = null;
  let cpu = null;
  let memory = null;
  let rootDisk = null;
  let gpus = [];
  try { hostname = await execOnce(session.client, "hostname"); } catch {}
  try { uptime = Number(await execOnce(session.client, "awk '{print int($1)}' /proc/uptime")); if (!Number.isFinite(uptime)) uptime = null; } catch {}
  try { loadAverage = (await execOnce(session.client, "awk '{print $1\" \"$2\" \"$3}' /proc/loadavg")).trim(); } catch {}
  try {
    const cores = Number(await execOnce(session.client, "getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 1"));
    const sample = await execOnce(session.client, "awk '/^cpu / {print $2+$3+$4+$6+$7+$8+$9+$10+$11, $5; exit}' /proc/stat; sleep 0.2; awk '/^cpu / {print $2+$3+$4+$6+$7+$8+$9+$10+$11, $5; exit}' /proc/stat");
    const rows = sample.split(/\r?\n/).map((row) => row.trim().split(/\s+/).map(Number)).filter((row) => row.length >= 2 && row.every(Number.isFinite));
    if (rows.length >= 2) {
      const totalDelta = rows[1][0] - rows[0][0];
      const busyDelta = totalDelta - (rows[1][1] - rows[0][1]);
      cpu = { cores: Number.isFinite(cores) ? cores : null, usage_percent: totalDelta > 0 ? Math.max(0, Math.min(100, Number((busyDelta * 100 / totalDelta).toFixed(1)))) : null };
    }
  } catch {}
  try {
    const fields = (await execOnce(session.client, "awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{if(t){u=t-a; printf \"%d %d %d %.1f\", t,u,a,u*100/t}}' /proc/meminfo")).split(/\s+/).map(Number);
    if (fields.length >= 4 && fields.slice(0, 4).every(Number.isFinite)) memory = { total_kib: fields[0], used_kib: fields[1], available_kib: fields[2], used_percent: fields[3] };
  } catch {}
  try {
    const disk = await execOnce(session.client, "df -Pk \"$HOME\" | tail -n 1");
    const fields = disk.trim().split(/\s+/);
    if (fields.length >= 5) rootDisk = { total_kib: Number(fields[1]), used_kib: Number(fields[2]), available_kib: Number(fields[3]), used_percent: Number(String(fields[4]).replace("%", "")) };
  } catch {}
  try {
    const csv = await execOnce(session.client, "command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits");
    gpus = csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const fields = line.split(/\s*,\s*/);
      if (fields.length < 6) return null;
      const number = (value) => { const result = Number(String(value).replace(/[^0-9.+-]/g, "")); return Number.isFinite(result) ? result : null; };
      return { index: number(fields[0]), name: fields[1], utilization_percent: number(fields[2]), memory_used_mib: number(fields[3]), memory_total_mib: number(fields[4]), temperature_c: number(fields[5]) };
    }).filter(Boolean);
  } catch {}
  return { host: session.host, port: session.port, username: session.username, hostname, uptime_seconds: uptime, workdir: "$HOME", load_average: loadAverage, cpu, memory, root_disk: rootDisk, gpus, collected_at: Math.floor(Date.now() / 1000) };
}

function appendEvent(job, type, data) { job.events.push({ id: ++job.lastEvent, type, data }); if (job.events.length > 512) job.events.shift(); }
function startJob(session, data) {
  const command = parseCommandRequest(data);
  const terminal = ensureTerminal(session, command, () => id("term"));
  const job = { id: id("job"), command: command.command, status: "queued", stdout: "", stderr: "", events: [], lastEvent: 0, startedAt: null, finishedAt: null, cancel: false, terminalId: terminal.terminal_id, timeoutSeconds: command.timeout_seconds };
  session.jobs.set(job.id, job);
  terminal.jobs.push(job);
  terminal.current_job_id = job.id;
  terminal.busy = true;
  appendEvent(job, "status", { status: "queued" });
  session.client.exec(command.command, (error, stream) => {
    if (error) return finishJob(job, "failed", { error: error.message });
    if (job.cancel) { try { stream.close(); } catch {} return finishJob(job, "cancelled"); }
    job.status = "running"; job.startedAt = Date.now(); appendEvent(job, "status", { status: "running" });
    const appendOutput = (field, chunk, eventName) => {
      const current = Buffer.byteLength(job[field], "utf8");
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - current);
      if (!remaining) { job.truncated = true; return; }
      const text = chunk.toString("utf8");
      const bytes = Buffer.from(text, "utf8");
      const accepted = bytes.subarray(0, remaining).toString("utf8");
      job[field] += accepted;
      if (accepted.length < text.length) job.truncated = true;
      if (accepted) appendEvent(job, eventName, { chunk: accepted });
    };
    stream.on("data", (chunk) => appendOutput("stdout", chunk, "stdout"));
    stream.stderr.on("data", (chunk) => appendOutput("stderr", chunk, "stderr"));
    const timeout = command.timeout_seconds;
    job.timeoutTimer = setTimeout(() => { if (!job.finishedAt) { job.cancel = true; job.timedOut = true; stream.close(); finishJob(job, "timed_out", { error: `command timed out after ${timeout}s`, timed_out: true }); } }, timeout * 1000);
    stream.on("close", (code, signal) => finishJob(job, job.timedOut ? "timed_out" : job.cancel ? "cancelled" : code === 0 ? "completed" : "failed", { exit_status: code, signal, timed_out: Boolean(job.timedOut) }));
    job.stream = stream;
  });
  return { job_id: job.id, terminal_id: terminal.terminal_id, status: job.status };
}
function finishJob(job, status, result = {}) { if (job.finishedAt) return; if (job.timeoutTimer) clearTimeout(job.timeoutTimer); job.status = status; job.finishedAt = Date.now(); job.result = result; const terminal = [...sessions.values()].flatMap((item) => [...item.terminals.values()]).find((item) => item.terminal_id === job.terminalId); if (terminal) { terminal.busy = false; terminal.current_job_id = null; } appendEvent(job, "status", { status }); appendEvent(job, "end", { status, ...result }); }
function jobInfo(job) { return { job_id: job.id, command: job.command, status: job.status, stdout: job.stdout, stderr: job.stderr, started_at: job.startedAt, finished_at: job.finishedAt, events: job.events, exit_status: job.result?.exit_status ?? null, duration_ms: job.startedAt && job.finishedAt ? job.finishedAt - job.startedAt : null, timeout_seconds: job.timeoutSeconds, truncated: Boolean(job.truncated) }; }

function streamJobEvents(request, response, job) {
  const last = Number(request.headers["last-event-id"] || 0);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });
  let cursor = Number.isFinite(last) ? last : 0;
  let closed = false;
  const send = (event) => {
    if (event.id <= cursor) return;
    response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    cursor = event.id;
  };
  const pump = () => {
    for (const event of job.events) send(event);
    if (job.finishedAt && cursor >= job.lastEvent) {
      response.end();
      closed = true;
    }
  };
  const timer = setInterval(() => {
    if (closed) return;
    response.write(": keep-alive\n\n");
    pump();
  }, 1500);
  const onClose = () => { closed = true; clearInterval(timer); };
  request.once("close", onClose);
  pump();
  return () => { clearInterval(timer); request.removeListener("close", onClose); };
}

const sensitivePart = /(^|\/)(\.ssh|\.git|\.gnupg|\.kube|\.aws|\.env[^/]*|authorized_keys|id_(rsa|ed25519|ecdsa|dsa)|credentials(?:\.json)?|secrets(?:\.json)?)(\/|$)/i;
function safeRelative(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || value.split("/").includes("..")) throw new Error("path must be a safe relative POSIX path");
  if (sensitivePart.test(value)) throw new Error("sensitive paths are not accessible");
  return value === "." ? "." : value.replace(/^\.\//, "");
}
function sftpCall(session, method, ...args) {
  return new Promise((resolve, reject) => session.client.sftp((error, sftp) => {
    if (error) return reject(error);
    sftp[method](...args, (callError, result) => callError ? reject(callError) : resolve({ sftp, result }));
  }));
}
function openSftp(session) {
  return new Promise((resolve, reject) => session.client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)));
}
function closeSftp(sftp) { try { sftp.end(); } catch {} }
function taskService(session) {
  if (!persistentTasksEnabled) { const error = new Error("persistent tasks are disabled"); error.status_code = 404; throw error; }
  if (!session.taskService) session.taskService = new RemoteTaskService({ remote: createSftpTaskRemote({ session, openSftp, closeSftp }), index: localTaskIndex, ownerKey: taskOwnerKey(sessionBinding(session)), recordDeletionEnabled: remoteTaskDeletionEnabled });
  return session.taskService;
}
function scheduleTaskReconcile(session, delayMs = 1000) {
  if (!persistentTasksEnabled) return;
  if (session.taskReconcileTimer) clearTimeout(session.taskReconcileTimer);
  session.taskReconcileState = { status: "scheduled", scheduled_at: new Date().toISOString() };
  session.taskReconcileTimer = setTimeout(async () => {
    session.taskReconcileTimer = null;
    session.taskReconcileState = { status: "running", started_at: new Date().toISOString() };
    try { session.taskReconcileState = { status: "completed", completed_at: new Date().toISOString(), ...(await taskService(session).reconcile()) }; }
    catch (error) { session.taskReconcileState = { status: "failed", completed_at: new Date().toISOString(), error: error.message }; }
  }, delayMs);
  session.taskReconcileTimer.unref();
}
async function fileList(session, relative) {
  const safe = safeRelative(relative);
  const { sftp, result } = await sftpCall(session, "readdir", safe);
  const response = { path: safe, entries: result.map((entry) => ({ name: entry.filename, type: entry.attrs.isDirectory() ? "directory" : "file", size: entry.attrs.size, modified_at: entry.attrs.mtime * 1000, mode: entry.attrs.mode })) };
  closeSftp(sftp);
  return response;
}
async function filePreview(session, relative) {
  const safe = safeRelative(relative);
  if (isKnownBinaryPath(safe)) throw new Error("binary file types cannot be previewed; download the file instead");
  const { sftp, result: handle } = await sftpCall(session, "open", safe, "r");
  try {
    const stat = await new Promise((resolve, reject) => sftp.fstat(handle, (error, value) => error ? reject(error) : resolve(value)));
    if (stat.isDirectory()) throw new Error("directories cannot be previewed");
    const size = Number(stat.size || 0);
    const limit = Math.min(size, MAX_TEXT_PREVIEW_BYTES);
    const buffer = Buffer.alloc(limit);
    const bytes = limit ? await new Promise((resolve, reject) => sftp.read(handle, buffer, 0, limit, 0, (error, count) => error ? reject(error) : resolve(count))) : 0;
    const truncated = size > bytes;
    return { path: safe, size, truncated, content: decodeTextPreview(buffer.subarray(0, bytes), truncated) };
  } finally {
    await new Promise((resolve) => sftp.close(handle, () => resolve()));
    closeSftp(sftp);
  }
}
async function fileWrite(session, relative, content) {
  const safe = safeRelative(relative);
  if (typeof content !== "string") throw new Error("text content must be a string");
  const { sftp, result: handle } = await sftpCall(session, "open", safe, "w");
  const buffer = Buffer.from(content, "utf8");
  try { if (buffer.length) await new Promise((resolve, reject) => sftp.write(handle, buffer, 0, buffer.length, 0, (error) => error ? reject(error) : resolve())); }
  finally { await new Promise((resolve) => sftp.close(handle, () => resolve())); closeSftp(sftp); }
  return { path: safe, written: true, bytes: Buffer.byteLength(content, "utf8") };
}
async function fileUpload(session, relative, request) {
  const safe = safeRelative(relative);
  const sftp = await openSftp(session);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(request, limiter, sftp.createWriteStream(safe, { flags: "w", mode: 0o644 }));
    return { path: safe, uploaded: true, bytes };
  } catch (error) {
    try { await new Promise((resolve) => sftp.unlink(safe, () => resolve())); } catch {}
    throw error;
  } finally { closeSftp(sftp); }
}
async function fileDownload(session, relative, response) {
  const safe = safeRelative(relative);
  const sftp = await openSftp(session);
  try {
    const stat = await new Promise((resolve, reject) => sftp.stat(safe, (error, value) => error ? reject(error) : resolve(value)));
    if (stat.isDirectory()) throw new Error("directories cannot be downloaded");
    const name = path.posix.basename(safe).replace(/[\r\n"]/g, "_") || "download";
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": Number(stat.size || 0),
      "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    await pipeline(sftp.createReadStream(safe), response);
  } finally { closeSftp(sftp); }
}
async function fileMedia(session, relative, response) {
  const safe = safeRelative(relative);
  const contentType = mediaTypeForPath(safe);
  if (!contentType) throw new Error("file type is not supported for image preview");
  const sftp = await openSftp(session);
  try {
    const stat = await new Promise((resolve, reject) => sftp.stat(safe, (error, value) => error ? reject(error) : resolve(value)));
    if (stat.isDirectory()) throw new Error("directories cannot be previewed");
    const size = Number(stat.size || 0);
    if (size > MAX_IMAGE_PREVIEW_BYTES) throw new Error("image preview must be at most 16 MiB");
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": size,
      "content-disposition": "inline",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    await pipeline(sftp.createReadStream(safe), response);
  } finally { closeSftp(sftp); }
}
async function fileDelete(session, relative) {
  const safe = safeRelative(relative);
  if (safe === ".") throw new Error("the file tree root cannot be deleted");
  const { sftp: statSftp, result: stat } = await sftpCall(session, "lstat", safe);
  closeSftp(statSftp);
  const method = stat.isDirectory() ? "rmdir" : "unlink";
  const { sftp } = await sftpCall(session, method, safe);
  closeSftp(sftp);
  return { path: safe, type: stat.isDirectory() ? "directory" : "file", deleted: true };
}

const transferStore = new SftpTusStore({ metadataDir: path.join(dataDir, "transfers"), getSession, safeRelative, openSftp, closeSftp });
const tusServer = new TusServer({
  path: "/internal/v1/transfers",
  datastore: transferStore,
  allowedOrigins: ["http://127.0.0.1:8877"],
  allowedHeaders: ["X-RCB-Session"],
  exposedHeaders: ["Location", "Tus-Resumable", "Tus-Version", "Tus-Extension", "Upload-Offset", "Upload-Length", "Upload-Metadata"],
  disableTerminationForFinishedUploads: true,
  postReceiveInterval: 1000,
  onIncomingRequest: (request, uploadId) => authorizeTusRequest(request, uploadId, { getSession, transferStore }),
  onUploadCreate: async (_request, upload) => {
    if (!Number.isFinite(Number(upload.size)) || Number(upload.size) < 0) throw { status_code: 400, body: "Upload-Length is required" };
    if (!upload.metadata?.session || !upload.metadata?.path) throw { status_code: 400, body: "session and path metadata are required" };
    return {};
  },
});

const server = http.createServer(async (request, response) => {
  const authority = `127.0.0.1:${server.address()?.port || port}`;
  if (!authorized(request, serviceKey, authority)) return json(response, 403, { error: "session-daemon authorization required" });
  const url = new URL(request.url, `http://${authority}`);
  try {
    if (request.method === "GET" && url.pathname === "/internal/v1/health") return json(response, 200, { ok: true, mode: "ssh-session-daemon", sessions: sessions.size });
    if (url.pathname.startsWith("/internal/v1/transfers")) return await tusServer.handle(request, response);
    if (request.method === "POST" && url.pathname === "/internal/v1/host-keys/trust") return json(response, 200, await trustPending((await readBody(request)).token));
    if (request.method === "GET" && url.pathname === "/internal/v1/sessions/recover") {
      const recovered = recoverSession(sessions, request.headers.cookie);
      if (!recovered) return json(response, 404, { error: "no recoverable SSH session" }, { "set-cookie": clearRecoveryCookie() });
      return json(response, 200, { ...sessionInfo(recovered.session), status: await collectStatus(recovered.session) }, { "set-cookie": recoveryCookie(recovered.token) });
    }
    if (url.pathname.startsWith("/internal/v1/agent")) {
      const suffix = url.pathname.slice("/internal/v1/agent".length).replace(/^\//, "");
      const taskEndpoint = suffix === "tasks" || suffix.startsWith("tasks/");
      if (taskEndpoint && !persistentTasksEnabled) return json(response, 404, { error: "persistent tasks are disabled" });
      if (/^tasks\/task-[a-z0-9-]+\/delete-record$/i.test(suffix) && !remoteTaskDeletionEnabled) return json(response, 404, { error: "remote task record deletion is disabled" });
      const scope = agentScopeForRequest(request.method, suffix);
      if (!scope) return json(response, 404, { error: "unknown Agent endpoint" });
      const session = await agentSession(scope);
      if (request.method === "GET" && suffix === "session") return json(response, 200, { session: session.id, host: session.host, port: session.port, username: session.username, enabled: true, ...sessionConnectionPolicy() });
      if (request.method === "GET" && suffix === "status") return json(response, 200, { ...(await collectStatus(session)), session: session.id });
      if (request.method === "GET" && suffix === "terminals") return json(response, 200, { session: session.id, terminals: [...session.terminals.values()].map((terminal) => ({ ...terminal, jobs: terminal.jobs.map(jobInfo) })) });
      if (request.method === "POST" && suffix === "commands") return json(response, 202, startJob(session, await readBody(request)));
      const jobMatch = suffix.match(/^jobs\/([^/]+)$/);
      if (jobMatch && request.method === "GET") { const job = session.jobs.get(jobMatch[1]); if (!job) return json(response, 404, { error: "unknown job" }); return json(response, 200, jobInfo(job)); }
      if (jobMatch && request.method === "DELETE") { const job = session.jobs.get(jobMatch[1]); if (!job) return json(response, 404, { error: "unknown job" }); job.cancel = true; job.stream?.close(); if (!job.stream) finishJob(job, "cancelled"); return json(response, 202, { cancelled: true, job_id: job.id }); }
      const eventsMatch = suffix.match(/^jobs\/([^/]+)\/events$/);
      if (eventsMatch && request.method === "GET") { const job = session.jobs.get(eventsMatch[1]); if (!job) return json(response, 404, { error: "unknown job" }); return streamJobEvents(request, response, job); }
      if (request.method === "GET" && suffix === "files") return json(response, 200, { ...(await fileList(session, url.searchParams.get("path") || ".")), session: session.id });
      if (request.method === "GET" && suffix === "files/preview") return json(response, 200, { ...(await filePreview(session, url.searchParams.get("path") || "")), session: session.id });
      if (request.method === "GET" && suffix === "files/media") return await fileMedia(session, url.searchParams.get("path") || "", response);
      if (request.method === "GET" && suffix === "files/download") return await fileDownload(session, url.searchParams.get("path") || "", response);
      if (request.method === "PUT" && suffix === "files/content") { const data = await readBody(request, Number.MAX_SAFE_INTEGER); return json(response, 200, await fileWrite(session, data.path, data.content)); }
      if (request.method === "PUT" && suffix === "files/upload") return json(response, 201, await fileUpload(session, url.searchParams.get("path") || "", request));
      if (request.method === "POST" && suffix === "files/mkdir") { const data = await readBody(request); const safe = safeRelative(data.path); const { sftp } = await sftpCall(session, "mkdir", safe); closeSftp(sftp); return json(response, 201, { path: safe, created: true }); }
      if (request.method === "POST" && suffix === "files/rename") { const data = await readBody(request); const from = safeRelative(data.from); const to = safeRelative(data.to); const { sftp } = await sftpCall(session, "rename", from, to); closeSftp(sftp); return json(response, 200, { from, to, renamed: true }); }
      if (request.method === "DELETE" && suffix === "files") return json(response, 200, await fileDelete(session, url.searchParams.get("path") || ""));
      if (request.method === "POST" && suffix === "logs") {
        const data = await readBody(request); const safe = safeRelative(data.path || ""); const preview = await filePreview(session, safe); return json(response, 200, { path: safe, content: tailTextLines(preview.content, data.lines), truncated: preview.truncated, session: session.id });
      }
      if (request.method === "GET" && suffix === "tasks/capabilities") return json(response, 200, { ...(await taskService(session).capabilities({ refresh: url.searchParams.get("refresh") === "true" })), local_index_error: localTaskIndexError, reconciliation: session.taskReconcileState || null, session: session.id });
      if (request.method === "GET" && suffix === "tasks") return json(response, 200, { ...(await taskService(session).listActive()), session: session.id });
      if (request.method === "GET" && suffix === "tasks/history") return json(response, 200, { ...(taskService(session).history({ status: url.searchParams.get("status") || null, limit: Number(url.searchParams.get("limit") || 50), cursor: url.searchParams.get("cursor") || null })), session: session.id });
      if (request.method === "GET" && suffix === "tasks/storage") return json(response, 200, { ...(await taskService(session).storage({ refresh: url.searchParams.get("refresh") === "true" })), session: session.id });
      if (request.method === "GET" && suffix === "tasks/cleanup-preview") return json(response, 200, { ...(await taskService(session).cleanupPreview({ refresh: url.searchParams.get("refresh") === "true", retentionDays: Number(url.searchParams.get("retention_days") || 30), quotaBytes: Number(url.searchParams.get("quota_bytes") || 2 * 1024 * 1024 * 1024), limit: Number(url.searchParams.get("limit") || 100) })), session: session.id });
      if (request.method === "POST" && suffix === "tasks") return json(response, 202, { ...(await taskService(session).create(await readBody(request))), session: session.id });
      if (request.method === "POST" && suffix === "tasks/maintenance") return json(response, 200, { ...(taskService(session).maintenance()), session: session.id });
      if (request.method === "POST" && suffix === "tasks/reconcile") {
        session.taskReconcileState = { status: "running", started_at: new Date().toISOString() };
        try { const result = await taskService(session).reconcile(); session.taskReconcileState = { status: "completed", completed_at: new Date().toISOString(), ...result }; return json(response, 200, { ...result, session: session.id }); }
        catch (error) { session.taskReconcileState = { status: "failed", completed_at: new Date().toISOString(), error: error.message }; throw error; }
      }
      const taskLogsMatch = suffix.match(/^tasks\/(task-[a-z0-9-]+)\/logs$/i);
      if (taskLogsMatch && request.method === "GET") return json(response, 200, { ...(await taskService(session).readLogs(taskLogsMatch[1], { stream: url.searchParams.get("stream") || "stdout", offset: Number(url.searchParams.get("offset") || 0), maxBytes: Number(url.searchParams.get("max_bytes") || 65536) })), session: session.id });
      const taskMatch = suffix.match(/^tasks\/(task-[a-z0-9-]+)$/i);
      if (taskMatch && request.method === "GET") return json(response, 200, { ...(await taskService(session).get(taskMatch[1])), session: session.id });
      const taskCancelMatch = suffix.match(/^tasks\/(task-[a-z0-9-]+)\/cancel$/i);
      if (taskCancelMatch && request.method === "POST") return json(response, 202, { ...(await taskService(session).cancel(taskCancelMatch[1])), session: session.id });
      const taskPinMatch = suffix.match(/^tasks\/(task-[a-z0-9-]+)\/(pin|unpin)$/i);
      if (taskPinMatch && request.method === "POST") return json(response, 200, { ...(await taskService(session)[taskPinMatch[2].toLowerCase()](taskPinMatch[1])), session: session.id });
      const taskDeleteMatch = suffix.match(/^tasks\/(task-[a-z0-9-]+)\/delete-record$/i);
      if (taskDeleteMatch && request.method === "POST") return json(response, 200, { ...(await taskService(session).deleteRecord(taskDeleteMatch[1], await readBody(request))), session: session.id });
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/sessions") {
      const data = await readBody(request);
      const connection = await connectSsh(data);
      try {
        const session = { id: id("session"), client: connection.client, host: data.host, port: Number(data.port || 22), username: data.username, fingerprint: connection.fingerprint, jobs: new Map(), terminals: new Map([["term-1", { terminal_id: "term-1", index: 1, busy: false, current_job_id: null, jobs: [] }]]), agentEnabled: false, controlGrantId: null, controlGrantExpiresAt: null, agentRenewTimer: null };
        const authorization = await control.authorize(sessionBinding(session));
        session.agentEnabled = Boolean(authorization.authorized && agentGrantScopes.every((scope) => authorization.grant?.scopes?.includes(scope)));
        session.controlGrantId = session.agentEnabled ? authorization.grant.grant_id : null;
        session.controlGrantExpiresAt = session.agentEnabled ? authorization.grant.exp : null;
        sessions.set(session.id, session);
        startAgentGrantRenewal(session);
        scheduleTaskReconcile(session);
        session.client.once("close", () => {
          if (sessions.has(session.id)) void closeSession(session, false);
        });
        const recoveryToken = issueSessionRecovery(session);
        return json(response, 201, { ...sessionInfo(session), status: await collectStatus(session) }, { "set-cookie": recoveryCookie(recoveryToken) });
      } catch (error) {
        try { connection.client.end(); } catch {}
        throw error;
      }
    }
    const match = url.pathname.match(/^\/internal\/v1\/sessions\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      if (request.method === "DELETE" && !match[2]) {
        const existing = sessions.get(match[1]);
        if (existing) await closeSession(existing);
        return json(response, 200, { closed: Boolean(existing) }, { "set-cookie": clearRecoveryCookie() });
      }
      const session = getSession(match[1]); const suffix = match[2] || "";
      if (request.method === "GET" && suffix === "status") return json(response, 200, { ...(await collectStatus(session)), jobs: [...session.jobs.values()].map(jobInfo) });
      if (request.method === "GET" && suffix === "terminals") return json(response, 200, { terminals: [...session.terminals.values()].map((terminal) => ({ ...terminal, jobs: terminal.jobs.map(jobInfo) })) });
      if (request.method === "GET" && suffix === "transfers") return json(response, 200, { transfers: await transferStore.listForSession(session) });
      const transferMatch = suffix.match(/^transfers\/([^/]+)$/);
      if (transferMatch && request.method === "DELETE") return json(response, 200, await transferStore.discardForSession(transferMatch[1], session));
      if (request.method === "POST" && suffix === "terminals") return json(response, 201, createTerminal(session, () => id("term")));
      if (request.method === "GET" && suffix === "files") return json(response, 200, await fileList(session, url.searchParams.get("path") || "."));
      if (request.method === "GET" && suffix === "files/preview") return json(response, 200, await filePreview(session, url.searchParams.get("path") || ""));
      if (request.method === "GET" && suffix === "files/media") return await fileMedia(session, url.searchParams.get("path") || "", response);
      if (request.method === "GET" && suffix === "files/download") return await fileDownload(session, url.searchParams.get("path") || "", response);
      if (request.method === "GET" && suffix.startsWith("jobs/") && suffix.endsWith("/events")) {
        const job = session.jobs.get(suffix.split("/")[1]); if (!job) throw new Error("unknown job"); return streamJobEvents(request, response, job);
      }
      if (request.method === "GET" && suffix.startsWith("jobs/")) { const job = session.jobs.get(suffix.split("/")[1]); if (!job) throw new Error("unknown job"); return json(response, 200, jobInfo(job)); }
      if (request.method === "POST" && suffix === "commands") { const data = await readBody(request); const result = startJob(session, data); return json(response, 202, result); }
      if (request.method === "POST" && suffix === "agent") {
        const data = await readBody(request);
        if (typeof data.enabled !== "boolean") throw new Error("agent enabled must be a boolean");
        if (data.enabled) {
          const existing = await control.authorize(sessionBinding(session));
          let grant = existing.authorized && agentGrantScopes.every((scope) => existing.grant?.scopes?.includes(scope)) ? existing.grant : null;
          if (!grant && session.controlGrantId) { try { grant = await control.renew(session.controlGrantId, sessionBinding(session), AGENT_GRANT_TTL_SECONDS); } catch {} }
          if (!grant || !agentGrantScopes.every((scope) => grant.scopes?.includes(scope))) grant = await control.grant(sessionBinding(session), agentGrantScopes, AGENT_GRANT_TTL_SECONDS);
          applyAgentGrant(session, grant);
        } else {
          await revokeAgentGrant(session);
        }
        return json(response, 200, { enabled: session.agentEnabled, session: session.id });
      }
      if (request.method === "POST" && suffix === "logs") {
        const data = await readBody(request); const safe = safeRelative(data.path || ""); const preview = await filePreview(session, safe); return json(response, 200, { path: safe, content: tailTextLines(preview.content, data.lines), truncated: preview.truncated });
      }
      if (request.method === "PUT" && suffix === "files/content") { const data = await readBody(request); return json(response, 200, await fileWrite(session, data.path, data.content)); }
      if (request.method === "PUT" && suffix === "files/upload") return json(response, 201, await fileUpload(session, url.searchParams.get("path") || "", request));
      if (request.method === "POST" && suffix === "files/mkdir") { const data = await readBody(request); const safe = safeRelative(data.path); const { sftp } = await sftpCall(session, "mkdir", safe); closeSftp(sftp); return json(response, 201, { path: safe, created: true }); }
      if (request.method === "POST" && suffix === "files/rename") { const data = await readBody(request); const from = safeRelative(data.from); const to = safeRelative(data.to); const { sftp } = await sftpCall(session, "rename", from, to); closeSftp(sftp); return json(response, 200, { from, to, renamed: true }); }
      if (request.method === "DELETE" && suffix === "files") return json(response, 200, await fileDelete(session, url.searchParams.get("path") || ""));
      if (request.method === "DELETE" && suffix.startsWith("jobs/")) { const job = session.jobs.get(suffix.split("/")[1]); if (!job) throw new Error("unknown job"); job.cancel = true; job.stream?.close(); return json(response, 202, { cancelled: true, job_id: job.id }); }
    }
    return json(response, 404, { error: "not found" });
  } catch (error) {
    if (response.headersSent) { response.destroy(); return; }
    if (error.trustRequired) return json(response, 409, { error: error.message, trust_required: true, ...error.trustRequired });
    return json(response, Number(error?.status_code) || 400, { error: error instanceof Error ? error.message : "session-daemon error" });
  }
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`${JSON.stringify({ ok: true, mode: "ssh-session-daemon", url: `http://127.0.0.1:${server.address().port}` })}\n`));
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([...sessions.values()].map((session) => closeSession(session)));
  server.close(() => { try { localTaskIndex?.close(); } catch {} process.exit(0); });
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
