import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Server as TusServer } from "@tus/server";
import { DataStore } from "@tus/utils";
import { authorizeTusRequest } from "../lib/tus-request.mjs";

function request(method, session = "session-1") {
  return { method, headers: { get: (name) => name.toLowerCase() === "x-rcb-session" ? session : null } };
}

test("new tus uploads do not rebind an ID before its store record exists", async () => {
  const calls = [];
  const session = { id: "session-1" };
  const dependencies = {
    getSession: (id) => id === session.id ? session : (() => { throw new Error("unknown session"); })(),
    transferStore: { rebind: async (...args) => calls.push(args) },
  };

  assert.equal(await authorizeTusRequest(request("POST"), "new-upload-id", dependencies), session);
  assert.deepEqual(calls, []);

  assert.equal(await authorizeTusRequest(request("PATCH"), "existing-upload-id", dependencies), session);
  assert.deepEqual(calls, [["existing-upload-id", session]]);
});

test("tus requests require a live SSH session", async () => {
  const dependencies = { getSession: () => { throw new Error("unknown session"); }, transferStore: { rebind: async () => {} } };
  await assert.rejects(authorizeTusRequest(request("POST", null), "id", dependencies), (error) => error.status_code === 401);
  await assert.rejects(authorizeTusRequest(request("POST", "missing"), "id", dependencies), (error) => error.status_code === 401);
});

test("the real tus server creates uploads without looking up the new ID first", async (context) => {
  class MemoryStore extends DataStore {
    constructor() { super(); this.extensions = ["creation"]; this.uploads = new Map(); }
    async create(upload) { this.uploads.set(upload.id, upload); return upload; }
    async getUpload(id) { return this.uploads.get(id); }
    async remove(id) { this.uploads.delete(id); }
    async write() { throw new Error("not used in creation test"); }
  }

  const store = new MemoryStore();
  const session = { id: "session-1" };
  const tus = new TusServer({
    path: "/uploads",
    datastore: store,
    onIncomingRequest: (incoming, uploadId) => authorizeTusRequest(incoming, uploadId, {
      getSession: (id) => { if (id !== session.id) throw new Error("unknown session"); return session; },
      transferStore: { rebind: async () => { throw new Error("new POST IDs must not be rebound"); } },
    }),
  });
  const server = http.createServer((incoming, response) => tus.handle(incoming, response));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/uploads`, {
    method: "POST",
    headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "3", "X-RCB-Session": session.id },
  });
  assert.equal(response.status, 201);
  assert.match(response.headers.get("location") || "", /\/uploads\/[^/]+$/);
  assert.equal(store.uploads.size, 1);
});

test("the real tus server preserves deterministic upload conflicts", async (context) => {
  class ConflictStore extends DataStore {
    constructor() { super(); this.extensions = ["creation"]; }
    async create() {
      const error = new Error("target file already exists");
      error.status_code = 409;
      error.body = "target file already exists\n";
      throw error;
    }
    async getUpload() { throw new Error("not used in conflict test"); }
    async remove() {}
    async write() { throw new Error("not used in conflict test"); }
  }

  const tus = new TusServer({ path: "/uploads", datastore: new ConflictStore() });
  const server = http.createServer((incoming, response) => tus.handle(incoming, response));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/uploads`, {
    method: "POST",
    headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "1" },
  });
  assert.equal(response.status, 409);
  assert.equal(await response.text(), "target file already exists\n");
});
