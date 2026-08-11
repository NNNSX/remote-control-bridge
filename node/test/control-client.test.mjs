import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createControlClient } from "../lib/control-client.mjs";

const nodeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); }); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }

test("control grants are bound, scoped, verified, persisted, and revoked", async (context) => {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-control-"));
  const child = spawn(process.execPath, [path.join(nodeDir, "bridge-control.mjs"), "--port", String(port), "--data-dir", dataDir], { cwd: nodeDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  context.after(async () => { if (child.exitCode === null) child.kill(); await fs.rm(dataDir, { recursive: true, force: true }); });

  const client = await createControlClient({ dataDir, port });
  const binding = { host: "ssh.example", port: 22, username: "user", fingerprint: `SHA256:${"A".repeat(43)}` };
  const created = await client.grant(binding, ["status:read", "jobs:read"], 300);
  assert.match(created.grant_id, /^grant-/);
  assert.deepEqual(created.scopes, ["jobs:read", "status:read"]);

  const authorized = await client.authorize(binding);
  assert.equal(authorized.authorized, true);
  assert.equal(authorized.grant.grant_id, created.grant_id);
  assert.equal((await client.verify(created.token, binding, "status:read")).authorized, true);
  await assert.rejects(() => client.verify(created.token, binding, "jobs:execute"), /requested scope/);
  await assert.rejects(() => client.verify(created.token, { ...binding, host: "other.example" }, "status:read"), /another session/);

  const renewed = await client.renew(created.grant_id, binding, 600);
  assert.equal(renewed.grant_id, created.grant_id);
  assert.ok(renewed.expires_at > created.expires_at);
  await assert.rejects(() => client.verify(created.token, binding, "status:read"), /expired, revoked, or bound/);
  assert.equal((await client.verify(renewed.token, binding, "status:read")).authorized, true);

  await client.revoke(created.grant_id);
  assert.equal((await client.authorize(binding)).authorized, false);
  await assert.rejects(() => client.verify(renewed.token, binding, "status:read"), /expired, revoked, or bound/);
  await assert.rejects(() => client.renew(created.grant_id, binding), /revoked/);
});
