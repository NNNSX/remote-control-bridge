#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { renderDetachedTaskWrapper } from "../lib/detached-task-wrapper.mjs";

const bashPath = process.argv[2];
if (!bashPath) throw new Error("usage: node scripts/detached-wrapper-smoke.mjs <bash-path>");
const forceDegraded = process.argv.includes("--degraded");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-wrapper-smoke-"));
const posixHome = root.replaceAll("\\", "/");
const taskId = "task-wrapper_smoke_001";
const taskDir = `tasks/history/2026/08/10/${taskId}`;
const activeMarker = `tasks/active/${taskId}.json`;
const wrapperPath = path.join(root, ...taskDir.split("/"), "launch.sh");
const activePath = path.join(root, ...activeMarker.split("/"));
try {
  await fs.mkdir(path.dirname(wrapperPath), { recursive: true });
  await fs.mkdir(path.dirname(activePath), { recursive: true });
  await fs.mkdir(path.join(root, "work"));
  await fs.writeFile(activePath, `${JSON.stringify({ schema_version: 1, task_id: taskId, relative_dir: taskDir, status: "queued" })}\n`);
  const wrapper = renderDetachedTaskWrapper({
    taskId,
    taskDir,
    activeMarker,
    workdir: "work",
    argv: ["bash", "-lc", "head -c 524288 /dev/zero | tr '\\000' x; printf 'stderr-smoke\\n' >&2"],
    segmentBytes: 64 * 1024,
    stdoutSegments: 2,
    stderrSegments: 1,
  });
  await fs.writeFile(wrapperPath, wrapper, "utf8");
  if (forceDegraded) await fs.mkdir(path.join(path.dirname(wrapperPath), "stdout.00000000000000000000.log"));
  const environment = { ...process.env, HOME: posixHome };
  const syntax = spawnSync(bashPath, ["-n", wrapperPath], { encoding: "utf8", env: environment });
  if (syntax.status !== 0) throw new Error(`bash syntax failed: ${syntax.stderr || syntax.stdout}`);
  const run = spawnSync(bashPath, [wrapperPath], { encoding: "utf8", env: environment, timeout: 30000 });
  if (run.status !== 0) throw new Error(`wrapper failed (${run.status}): ${run.stderr || run.stdout}`);
  const entries = await fs.readdir(path.dirname(wrapperPath), { withFileTypes: true });
  const stdoutFiles = entries.filter((entry) => entry.isFile() && /^stdout\.\d+\.log$/.test(entry.name)).map((entry) => entry.name);
  const stderrFiles = entries.filter((entry) => entry.isFile() && /^stderr\.\d+\.log$/.test(entry.name)).map((entry) => entry.name);
  const stdoutBytes = (await Promise.all(stdoutFiles.map(async (name) => (await fs.stat(path.join(path.dirname(wrapperPath), name))).size))).reduce((sum, size) => sum + size, 0);
  const status = JSON.parse(await fs.readFile(path.join(path.dirname(wrapperPath), "status.json"), "utf8"));
  let activeExists = true;
  try { await fs.stat(activePath); } catch (error) { if (error.code === "ENOENT") activeExists = false; else throw error; }
  const result = { status: status.status, logging_status: status.logging_status, exit_code: status.exit_code, stdout_segments: stdoutFiles.length, stderr_segments: stderrFiles.length, stdout_bytes: stdoutBytes, active_marker_exists: activeExists };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  const expectedLogging = forceDegraded ? "degraded" : "ok";
  const outputValid = forceDegraded ? stdoutFiles.length === 0 : stdoutFiles.length === 2 && stdoutBytes === 128 * 1024;
  if (status.status !== "completed" || status.logging_status !== expectedLogging || status.exit_code !== 0 || !outputValid || stderrFiles.length !== 1 || activeExists) process.exitCode = 1;
} finally { await fs.rm(root, { recursive: true, force: true }); }
