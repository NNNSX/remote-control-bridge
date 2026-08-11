import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nodeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitForBridge(port, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`bridge-api exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("bridge-api did not become ready");
}

test("bridge proxies the tus lifecycle and rewrites the upload location", async (context) => {
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });

    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Tus-Resumable": "1.0.0", "Tus-Version": "1.0.0", "Tus-Extension": "creation,termination" });
      return response.end();
    }
    if (request.method === "POST") {
      response.writeHead(201, { "Tus-Resumable": "1.0.0", Location: `http://127.0.0.1:${upstream.address().port}/internal/v1/transfers/upload-1` });
      return response.end();
    }
    if (request.method === "HEAD") {
      response.writeHead(200, { "Tus-Resumable": "1.0.0", "Upload-Offset": "3", "Upload-Length": "6" });
      return response.end();
    }
    if (request.method === "PATCH") {
      response.writeHead(204, { "Tus-Resumable": "1.0.0", "Upload-Offset": "6" });
      return response.end();
    }
    if (request.method === "DELETE") {
      response.writeHead(204, { "Tus-Resumable": "1.0.0" });
      return response.end();
    }
    response.writeHead(404).end();
  });

  const upstreamPort = await listen(upstream);
  const portProbe = http.createServer();
  const bridgePort = await listen(portProbe);
  await close(portProbe);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-bridge-api-"));
  await fs.writeFile(path.join(dataDir, "sessiond.key"), Buffer.alloc(32, 9));
  const child = spawn(process.execPath, [path.join(nodeDir, "bridge-api.mjs"), "--port", String(bridgePort), "--session-port", String(upstreamPort), "--data-dir", dataDir], {
    cwd: nodeDir,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  context.after(async () => {
    if (child.exitCode === null) child.kill();
    await close(upstream);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await waitForBridge(bridgePort, child);
  const base = `http://127.0.0.1:${bridgePort}/api/v1/transfers`;
  const common = { "Tus-Resumable": "1.0.0", "X-RCB-Session": "session-test" };

  const options = await fetch(base, { method: "OPTIONS", headers: common });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("tus-version"), "1.0.0");

  const created = await fetch(base, { method: "POST", headers: { ...common, "Upload-Length": "6", "Upload-Metadata": "path ZmlsZS5iaW4=" } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("location"), "/api/v1/transfers/upload-1");

  const uploadUrl = new URL(created.headers.get("location"), base);
  const head = await fetch(uploadUrl, { method: "HEAD", headers: common });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("upload-offset"), "3");
  assert.equal(head.headers.get("upload-length"), "6");

  const patch = await fetch(uploadUrl, { method: "PATCH", headers: { ...common, "Upload-Offset": "3", "Content-Type": "application/offset+octet-stream" }, body: Buffer.from("def") });
  assert.equal(patch.status, 204);
  assert.equal(patch.headers.get("upload-offset"), "6");

  const removed = await fetch(uploadUrl, { method: "DELETE", headers: common });
  assert.equal(removed.status, 204);

  assert.deepEqual(requests.map((request) => request.method), ["OPTIONS", "POST", "HEAD", "PATCH", "DELETE"]);
  assert.equal(requests[1].headers["upload-length"], "6");
  assert.equal(requests[1].headers["x-rcb-session"], "session-test");
  assert.equal(requests[3].headers["upload-offset"], "3");
  assert.equal(requests[3].body.toString(), "def");
  assert.equal(requests.every((request) => request.headers["x-session-key"] === Buffer.alloc(32, 9).toString("hex")), true);
});
