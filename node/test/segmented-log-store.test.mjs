import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SegmentedLogStore } from "../lib/segmented-log-store.mjs";

test("segmented logs keep bounded bytes and report dropped cursors", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-log-store-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SegmentedLogStore({ root, stream: "stdout", segmentBytes: 4, maxBytes: 8 });
  await store.append(Buffer.from("abcdefghijkl"));
  const meta = await store.snapshot();
  assert.equal(meta.first_available_offset, 4);
  assert.equal(meta.next_offset, 12);
  assert.equal(meta.segments.length, 2);
  const result = await store.read(0, 32);
  assert.equal(result.cursor_was_dropped, true);
  assert.equal(result.dropped_before, 4);
  assert.equal(result.content.toString(), "efghijkl");
  assert.equal(result.next_offset, 12);
});

test("segmented logs preserve arbitrary bytes and continue after reopening", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-log-store-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new SegmentedLogStore({ root, stream: "stderr", segmentBytes: 5, maxBytes: 15 });
  await first.append(Buffer.from([0, 1, 2, 3, 4, 5, 255]));
  const reopened = new SegmentedLogStore({ root, stream: "stderr", segmentBytes: 5, maxBytes: 15 });
  await reopened.append(Buffer.from([8, 9, 10]));
  const result = await reopened.read(0, 32);
  assert.deepEqual([...result.content], [0, 1, 2, 3, 4, 5, 255, 8, 9, 10]);
  assert.equal(result.stream_end_offset, 10);
});

test("concurrent append calls are serialized without offset overlap", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-log-store-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SegmentedLogStore({ root, stream: "stdout", segmentBytes: 8, maxBytes: 64 });
  await Promise.all([store.append("aaaa"), store.append("bbbb"), store.append("cccc")]);
  const result = await store.read(0, 64);
  assert.equal(result.content.toString(), "aaaabbbbcccc");
  assert.equal(result.stream_end_offset, 12);
});

test("pressure rotation keeps on-disk log segments within the configured budget", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-log-store-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const segmentBytes = 64 * 1024;
  const maxBytes = 256 * 1024;
  const store = new SegmentedLogStore({ root, stream: "stdout", segmentBytes, maxBytes });
  const chunk = Buffer.alloc(32 * 1024, 0x61);
  for (let index = 0; index < 64; index += 1) await store.append(chunk);
  const meta = await store.snapshot();
  const files = (await fs.readdir(root)).filter((name) => name.endsWith(".log"));
  const sizes = await Promise.all(files.map(async (name) => (await fs.stat(path.join(root, name))).size));
  assert.ok(sizes.reduce((total, size) => total + size, 0) <= maxBytes);
  assert.equal(meta.next_offset, 2 * 1024 * 1024);
  assert.equal(meta.first_available_offset, meta.next_offset - maxBytes);
});
