import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSftpTaskRemote } from "../lib/sftp-task-remote.mjs";

function execStream() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.close = () => {};
  return stream;
}

test("remote exec timeout closes the stream and rejects with a bounded error", async () => {
  const stream = execStream();
  let closed = false;
  stream.close = () => { closed = true; };
  const remote = createSftpTaskRemote({
    session: { client: { exec(_command, callback) { callback(null, stream); } } },
    openSftp: async () => { throw new Error("not used"); },
    closeSftp() {},
    execTimeoutMs: 5,
  });
  await assert.rejects(() => remote.exec("never-finishes"), /persistent task command timed out/);
  assert.equal(closed, true);
});

test("remote exec rejects promptly when the SSH stream disconnects", async () => {
  const stream = execStream();
  const remote = createSftpTaskRemote({
    session: { client: { exec(_command, callback) { callback(null, stream); } } },
    openSftp: async () => { throw new Error("not used"); },
    closeSftp() {},
    execTimeoutMs: 5000,
  });
  const pending = remote.exec("long-running-task");
  setImmediate(() => stream.emit("error", new Error("SSH channel closed")));
  await assert.rejects(pending, /SSH channel closed/);
});

test("remote exec still reports bounded output on a normal close", async () => {
  const stream = execStream();
  const remote = createSftpTaskRemote({
    session: { client: { exec(_command, callback) { callback(null, stream); } } },
    openSftp: async () => { throw new Error("not used"); },
    closeSftp() {},
  });
  const pending = remote.exec("echo output");
  stream.emit("data", Buffer.from("ok"));
  stream.stderr.emit("data", Buffer.from("warn"));
  stream.emit("close", 0, null);
  assert.deepEqual(await pending, { code: 0, signal: null, stdout: "ok", stderr: "warn", truncated: false });
});

test("SFTP read failures close both the file handle and channel", async () => {
  let handleClosed = false;
  let channelClosed = false;
  const sftp = {
    open(_target, _flags, callback) { callback(null, "handle-1"); },
    fstat(_handle, callback) { callback(null, { size: 4, isDirectory: () => false }); },
    read(_handle, _buffer, _offset, _length, _position, callback) { const error = new Error("connection lost"); error.code = "ECONNRESET"; callback(error); },
    close(_handle, callback) { handleClosed = true; callback(null); },
  };
  const remote = createSftpTaskRemote({
    session: {},
    openSftp: async () => sftp,
    closeSftp() { channelClosed = true; },
  });
  await assert.rejects(() => remote.readText("task/status.json", 1024), /connection lost/);
  assert.equal(handleClosed, true);
  assert.equal(channelClosed, true);
});
