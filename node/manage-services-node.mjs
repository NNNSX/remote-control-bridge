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
async function status(name) { const record = await read(name); if (!record || !alive(record.pid)) { await fs.rm(file(name), { force: true }); return null; } return record; }
async function start(name) { const existing = await status(name); if (existing) { console.log(`${name}: running (PID ${existing.pid})`); return; } const item = config[name]; if (!item) throw new Error(`unknown service ${name}`); const out = fsSync.openSync(path.join(dataDir, `node-${name.toLowerCase()}.stdout.log`), "a"); const err = fsSync.openSync(path.join(dataDir, `node-${name.toLowerCase()}.stderr.log`), "a"); const child = spawn(process.execPath, [path.join(nodeDir, item.script), "--port", String(item.port), ...item.extra], { cwd: nodeDir, detached: true, stdio: ["ignore", out, err], windowsHide: true }); child.unref(); await fs.writeFile(file(name), JSON.stringify({ service: name, pid: child.pid, script_path: item.script, started_at: new Date().toISOString() }), { mode: 0o600 }); console.log(`${name}: started (PID ${child.pid})`); }
async function stop(name) { const record = await status(name); if (!record) { console.log(`${name}: stopped`); return; } try { process.kill(Number(record.pid)); } catch {} await fs.rm(file(name), { force: true }); console.log(`${name}: stopped`); }
if (action.toLowerCase() === "status") for (const name of services) console.log(`${name}: ${((await status(name)) ? "running" : "stopped")}`);
else if (action.toLowerCase() === "start") for (const name of services) await start(name);
else if (action.toLowerCase() === "stop") for (const name of ["Bridge", "Session", "Control"].filter((name) => services.includes(name))) await stop(name);
else { for (const name of ["Bridge", "Session", "Control"].filter((name) => services.includes(name))) await stop(name); for (const name of services) await start(name); }
