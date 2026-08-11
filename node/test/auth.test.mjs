import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { authorized, loadOrCreateKey } from "../lib/auth.mjs";

test("session key is created and persisted", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-node-"));
  const file = path.join(dir, "sessiond.key");
  const first = await loadOrCreateKey(file);
  const second = await loadOrCreateKey(file);
  assert.equal(first.length, 32);
  assert.deepEqual(first, second);
});

test("authorization is loopback host and constant-time key bound", () => {
  const key = Buffer.alloc(32, 7);
  const request = { headers: { host: "127.0.0.1:8879", "x-session-key": key.toString("hex") } };
  assert.equal(authorized(request, key, "127.0.0.1:8879"), true);
  assert.equal(authorized({ headers: { ...request.headers, host: "192.0.2.1:8879" } }, key, "127.0.0.1:8879"), false);
  assert.equal(authorized({ headers: { ...request.headers, "x-session-key": "wrong" } }, key, "127.0.0.1:8879"), false);
});
