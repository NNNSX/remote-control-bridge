import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nodeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); }); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }
async function freePort() { const probe = http.createServer(); const port = await listen(probe); await close(probe); return port; }
function launch(script, args) { return spawn(process.execPath, [path.join(nodeDir, script), ...args], { cwd: nodeDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }

function stop(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });
}

async function waitFor(check, children) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const failed = children.find((child) => child.exitCode !== null);
    if (failed) throw new Error(`runtime child exited with ${failed.exitCode}`);
    try { const result = await check(); if (result) return result; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("runtime services did not become ready");
}

test("Control, Session, and Bridge start together with isolated runtime state", async (context) => {
  const [controlPort, sessionPort, bridgePort] = await Promise.all([freePort(), freePort(), freePort()]);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-runtime-"));
  const children = [];
  context.after(async () => { for (const child of children) if (child.exitCode === null) child.kill(); await fs.rm(dataDir, { recursive: true, force: true }); });

  children.push(launch("bridge-control.mjs", ["--port", String(controlPort), "--data-dir", dataDir]));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${controlPort}/api/v1/health`)).ok, children);

  children.push(launch("sessiond.mjs", ["--port", String(sessionPort), "--control-port", String(controlPort), "--data-dir", dataDir]));
  const sessionHealth = await waitFor(async () => {
    const key = await fs.readFile(path.join(dataDir, "sessiond.key"));
    const response = await fetch(`http://127.0.0.1:${sessionPort}/internal/v1/health`, { headers: { "x-session-key": key.toString("hex") } });
    return response.ok ? response.json() : null;
  }, children);
  assert.equal(sessionHealth.sessions, 0);

  children.push(launch("bridge-api.mjs", ["--port", String(bridgePort), "--session-port", String(sessionPort), "--data-dir", dataDir]));
  const bridgeHealth = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/health`);
    return response.ok ? response.json() : null;
  }, children);
  assert.equal(bridgeHealth.sessiond, `http://127.0.0.1:${sessionPort}`);

  await stop(children.at(-1));
  children.push(launch("bridge-api.mjs", ["--port", String(bridgePort), "--session-port", String(sessionPort), "--data-dir", dataDir]));
  const restartedBridgeHealth = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/health`);
    return response.ok ? response.json() : null;
  }, children);
  assert.equal(restartedBridgeHealth.sessiond, `http://127.0.0.1:${sessionPort}`);

  await stop(children[1]);
  children.push(launch("sessiond.mjs", ["--port", String(sessionPort), "--control-port", String(controlPort), "--data-dir", dataDir]));
  const restartedSessionHealth = await waitFor(async () => {
    const key = await fs.readFile(path.join(dataDir, "sessiond.key"));
    const response = await fetch(`http://127.0.0.1:${sessionPort}/internal/v1/health`, { headers: { "x-session-key": key.toString("hex") } });
    return response.ok ? response.json() : null;
  }, children);
  assert.equal(restartedSessionHealth.sessions, 0);

  const bridgeAfterSessionRestart = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/health`);
    return response.ok ? response.json() : null;
  }, children);
  assert.equal(bridgeAfterSessionRestart.sessiond, `http://127.0.0.1:${sessionPort}`);
});
