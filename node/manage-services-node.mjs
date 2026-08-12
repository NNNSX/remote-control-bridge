#!/usr/bin/env node
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeDir = path.join(root, "node");
const args = process.argv.slice(2);
const action = args[0] || "Status";
const selected = args[1] || "All";
const values = Object.fromEntries(args.slice(2).reduce((all, item, index, source) => item.startsWith("--") ? all.concat([[item.slice(2), source[index + 1]]]) : all, []));
const dataDir = path.resolve(values["data-dir"] || path.resolve(root, "..", "node-data"));
const persistentTaskArgs = values["persistent-tasks"] ? ["--persistent-tasks", String(values["persistent-tasks"])] : [];
const remoteTaskDeletionArgs = values["remote-task-deletion"] ? ["--remote-task-deletion", String(values["remote-task-deletion"])] : [];
const config = { Bridge: { script: "bridge-api.mjs", port: Number(values["bridge-port"] || 8877), extra: ["--session-port", String(values["session-port"] || 8879), "--data-dir", dataDir] }, Session: { script: "sessiond.mjs", port: Number(values["session-port"] || 8879), extra: ["--control-port", String(values["control-port"] || 8878), "--data-dir", dataDir, ...persistentTaskArgs, ...remoteTaskDeletionArgs] }, Control: { script: "bridge-control.mjs", port: Number(values["control-port"] || 8878), extra: ["--data-dir", dataDir] } };
await fs.mkdir(dataDir, { recursive: true });
const services = selected === "All" ? ["Control", "Session", "Bridge"] : [selected];
const file = (name) => path.join(dataDir, `node-${name.toLowerCase()}.pid.json`);
async function read(name) { try { return JSON.parse(await fs.readFile(file(name), "utf8")); } catch { return null; } }
function alive(pid) { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch { return false; } }
function healthRequest(name) {
  const item = config[name];
  if (name === "Session") {
    const keyPath = path.join(dataDir, "sessiond.key");
    let key;
    try { key = fsSync.readFileSync(keyPath).toString("hex"); } catch { return null; }
    return { url: `http://127.0.0.1:${item.port}/internal/v1/health`, headers: { "x-session-key": key } };
  }
  return { url: `http://127.0.0.1:${item.port}/api/v1/health`, headers: {} };
}
async function healthy(name) {
  const request = healthRequest(name);
  if (!request) return false;
  try {
    const response = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch { return false; }
}
async function waitReady(name, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  const onExit = () => { exited = true; };
  child.once("exit", onExit);
  while (Date.now() < deadline) {
    if (exited) break;
    if (await healthy(name)) { child.off("exit", onExit); return true; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.off("exit", onExit);
  return false;
}
async function status(name) {
  const record = await read(name);
  if (!record || !alive(record.pid)) { await fs.rm(file(name), { force: true }); return null; }
  if (!(await healthy(name))) return { ...record, stale: true };
  return record;
}
async function start(name) {
  const existing = await status(name);
  if (existing && !existing.stale) { console.log(`${name}: running (PID ${existing.pid})`); return; }
  if (existing?.stale) {
    throw new Error(`${name} has a stale PID record (PID ${existing.pid}); verify the process identity and stop it explicitly before starting`);
  }
  const item = config[name];
  if (!item) throw new Error(`unknown service ${name}`);
  const out = fsSync.openSync(path.join(dataDir, `node-${name.toLowerCase()}.stdout.log`), "a");
  const err = fsSync.openSync(path.join(dataDir, `node-${name.toLowerCase()}.stderr.log`), "a");
  const child = spawn(process.execPath, [path.join(nodeDir, item.script), "--port", String(item.port), ...item.extra], { cwd: nodeDir, detached: true, stdio: ["ignore", out, err], windowsHide: true });
  child.unref();
  const record = { service: name, pid: child.pid, script_path: item.script, started_at: new Date().toISOString() };
  if (!(await waitReady(name, child))) {
    throw new Error(`${name} failed to become ready; see ${path.join(dataDir, `node-${name.toLowerCase()}.stderr.log`)}`);
  }
  await fs.writeFile(file(name), JSON.stringify(record), { mode: 0o600 });
  console.log(`${name}: started (PID ${child.pid})`);
}
async function stop(name) { const record = await status(name); if (!record) { console.log(`${name}: stopped`); return; } if (record.stale) throw new Error(`${name} has a stale PID record (PID ${record.pid}); verify the process identity and stop it explicitly`); try { process.kill(Number(record.pid)); } catch {} await fs.rm(file(name), { force: true }); console.log(`${name}: stopped`); }
if (action.toLowerCase() === "status") for (const name of services) { const record = await status(name); console.log(`${name}: ${!record ? "stopped" : record.stale ? `stale (PID ${record.pid})` : `running (PID ${record.pid})`}`); }
else if (action.toLowerCase() === "start") for (const name of services) await start(name);
else if (action.toLowerCase() === "stop") for (const name of ["Bridge", "Session", "Control"].filter((name) => services.includes(name))) await stop(name);
else { for (const name of ["Bridge", "Session", "Control"].filter((name) => services.includes(name))) await stop(name); for (const name of services) await start(name); }
