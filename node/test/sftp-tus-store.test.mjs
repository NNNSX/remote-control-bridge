import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { SftpTusStore } from "../lib/sftp-tus-store.mjs";

function fakeSftp(root) {
  const resolve = (remotePath) => path.join(root, ...String(remotePath).split("/"));
  const attrs = (stat) => ({ size: stat.size, isDirectory: () => stat.isDirectory() });
  return {
    lstat(remotePath, callback) { fsp.lstat(resolve(remotePath)).then((stat) => callback(null, attrs(stat)), callback); },
    stat(remotePath, callback) { fsp.stat(resolve(remotePath)).then((stat) => callback(null, attrs(stat)), callback); },
    mkdir(remotePath, callback) { fsp.mkdir(resolve(remotePath)).then(() => callback(null), callback); },
    open(remotePath, flags, mode, callback) { fsp.open(resolve(remotePath), flags, mode).then((handle) => callback(null, handle), callback); },
    close(handle, callback) { handle.close().then(() => callback(null), callback); },
    rename(from, to, callback) { fsp.rename(resolve(from), resolve(to)).then(() => callback(null), callback); },
    ext_openssh_rename(from, to, callback) { fsp.rm(resolve(to), { force: true }).then(() => fsp.rename(resolve(from), resolve(to))).then(() => callback(null), callback); },
    unlink(remotePath, callback) { fsp.unlink(resolve(remotePath)).then(() => callback(null), callback); },
    createWriteStream(remotePath, options) { return fs.createWriteStream(resolve(remotePath), options); },
    end() {},
  };
}

test("SFTP tus storage creates, resumes, completes, rebinds, lists, and removes uploads", async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rcb-sftp-"));
  const metadataDir = path.join(root, "metadata");
  const remoteDir = path.join(root, "remote");
  await fsp.mkdir(remoteDir);
  context.after(() => fsp.rm(root, { recursive: true, force: true }));

  const sessions = new Map([
    ["session-1", { id: "session-1", host: "ssh.example", port: 22, username: "user" }],
    ["session-2", { id: "session-2", host: "ssh.example", port: 22, username: "user" }],
    ["other", { id: "other", host: "other.example", port: 22, username: "user" }],
  ]);
  const store = new SftpTusStore({
    metadataDir,
    getSession: (id) => {
      const session = sessions.get(id);
      if (!session) throw new Error("unknown session");
      return session;
    },
    safeRelative: (value) => value,
    openSftp: async () => fakeSftp(remoteDir),
    closeSftp: (sftp) => sftp.end(),
  });

  const upload = { id: "upload_1", size: 6, metadata: { session: "session-1", path: "models/file.bin" }, creation_date: new Date().toISOString() };
  await store.create(upload);
  assert.equal((await fsp.stat(path.join(remoteDir, "models", "file.bin.rcb-upload-upload_1.part"))).size, 0);

  const duplicate = { id: "upload_duplicate", size: 1, metadata: { session: "session-1", path: "models/file.bin.rcb-upload-upload_1.part" }, creation_date: new Date().toISOString() };
  await assert.rejects(() => store.create(duplicate), (error) => error.status_code === 409 && /already exists/.test(error.body));

  await fsp.writeFile(path.join(remoteDir, "models", "replace.bin"), "old");
  const replacement = { id: "upload_replace", size: 3, metadata: { session: "session-1", path: "models/replace.bin", overwrite: "true" }, creation_date: new Date().toISOString() };
  await store.create(replacement);
  assert.equal(await store.write(Readable.from([Buffer.from("new")]), replacement.id, 0), 3);
  assert.equal(await fsp.readFile(path.join(remoteDir, "models", "replace.bin"), "utf8"), "new");
  assert.deepEqual(await store.discardForSession(replacement.id, sessions.get("session-1")), { id: replacement.id, completed: true, file_preserved: true });

  assert.equal(await store.write(Readable.from([Buffer.from("abc")]), upload.id, 0), 3);
  let current = await store.getUpload(upload.id);
  assert.equal(current.offset, 3);

  await store.rebind(upload.id, sessions.get("session-2"));
  await assert.rejects(() => store.rebind(upload.id, sessions.get("other")), /another SSH identity/);
  assert.equal(await store.write(Readable.from([Buffer.from("def")]), upload.id, 3), 6);
  assert.equal(await fsp.readFile(path.join(remoteDir, "models", "file.bin"), "utf8"), "abcdef");

  current = await store.getUpload(upload.id);
  assert.equal(current.offset, 6);
  const listed = await store.listForSession(sessions.get("session-2"));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].completed, true);
  assert.equal(listed[0].path, "models/file.bin");

  const discarded = await store.discardForSession(upload.id, sessions.get("session-2"));
  assert.deepEqual(discarded, { id: upload.id, completed: true, file_preserved: true });
  assert.equal(await fsp.readFile(path.join(remoteDir, "models", "file.bin"), "utf8"), "abcdef");
  await assert.rejects(() => fsp.stat(path.join(metadataDir, "upload_1.json")), { code: "ENOENT" });

  const partial = { id: "upload_2", size: 6, metadata: { session: "session-2", path: "models/partial.bin" }, creation_date: new Date().toISOString() };
  await store.create(partial);
  await store.write(Readable.from([Buffer.from("abc")]), partial.id, 0);
  const cancelled = await store.discardForSession(partial.id, sessions.get("session-2"));
  assert.deepEqual(cancelled, { id: partial.id, completed: false, file_preserved: false });
  await assert.rejects(() => fsp.stat(path.join(remoteDir, "models", "partial.bin.rcb-upload-upload_2.part")), { code: "ENOENT" });
  await assert.rejects(() => fsp.stat(path.join(metadataDir, "upload_2.json")), { code: "ENOENT" });
});
