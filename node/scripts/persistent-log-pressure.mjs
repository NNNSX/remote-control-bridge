#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SegmentedLogStore } from "../lib/segmented-log-store.mjs";

const totalBytes = Number(process.argv[2] || 512 * 1024 * 1024);
if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) throw new Error("total bytes must be a positive safe integer");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcb-log-pressure-"));
const segmentBytes = 32 * 1024 * 1024;
const maxBytes = 128 * 1024 * 1024;
const chunk = Buffer.alloc(1024 * 1024, 0x61);
const store = new SegmentedLogStore({ root, stream: "stdout", segmentBytes, maxBytes });
const started = Date.now();
try {
  let written = 0;
  while (written < totalBytes) {
    const size = Math.min(chunk.length, totalBytes - written);
    await store.append(chunk.subarray(0, size));
    written += size;
  }
  const meta = await store.snapshot();
  const logFiles = (await fs.readdir(root)).filter((name) => name.endsWith(".log"));
  const retained = (await Promise.all(logFiles.map(async (name) => (await fs.stat(path.join(root, name))).size))).reduce((sum, size) => sum + size, 0);
  process.stdout.write(`${JSON.stringify({ written, retained, elapsed_ms: Date.now() - started, first_available_offset: meta.first_available_offset, next_offset: meta.next_offset, segments: meta.segments.length })}\n`);
  if (retained > maxBytes || meta.next_offset !== written) process.exitCode = 1;
} finally { await fs.rm(root, { recursive: true, force: true }); }
