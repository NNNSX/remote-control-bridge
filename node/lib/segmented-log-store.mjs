import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const LOG_SCHEMA_VERSION = 1;
export const MAX_LOG_READ_BYTES = 1024 * 1024;

function assertStream(stream) {
  if (typeof stream !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/i.test(stream)) throw new Error("stream must be a safe identifier");
  return stream;
}

function segmentName(stream, start) { return `${stream}.${String(start).padStart(20, "0")}.log`; }

async function atomicWriteJson(target, value) {
  const temporary = `${target}.tmp-${crypto.randomBytes(8).toString("hex")}`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, target);
}

function validateMeta(meta, stream) {
  if (!meta || meta.schema_version !== LOG_SCHEMA_VERSION || meta.stream !== stream) throw new Error("unsupported log metadata");
  if (!Array.isArray(meta.segments)) throw new Error("log metadata segments must be an array");
  if (![meta.first_available_offset, meta.next_offset, meta.dropped_before].every(Number.isSafeInteger)) throw new Error("log offsets must be safe integers");
  let previousEnd = meta.first_available_offset;
  for (const segment of meta.segments) {
    if (!Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) || segment.end < segment.start || segment.start !== previousEnd) throw new Error("log segments must be contiguous");
    if (segment.file !== segmentName(stream, segment.start)) throw new Error("log segment filename does not match its offset");
    previousEnd = segment.end;
  }
  if (previousEnd !== meta.next_offset) throw new Error("log next_offset does not match segments");
  return meta;
}

export class SegmentedLogStore {
  constructor({ root, stream, segmentBytes = 32 * 1024 * 1024, maxBytes = 128 * 1024 * 1024 }) {
    this.root = path.resolve(root);
    this.stream = assertStream(stream);
    if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 1) throw new Error("segmentBytes must be a positive integer");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < segmentBytes) throw new Error("maxBytes must be at least segmentBytes");
    this.segmentBytes = segmentBytes;
    this.maxBytes = maxBytes;
    this.metaPath = path.join(this.root, `${this.stream}.meta.json`);
    this.tail = Promise.resolve();
    this.ready = this.initialize();
  }

  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try { validateMeta(JSON.parse(await fs.readFile(this.metaPath, "utf8")), this.stream); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await atomicWriteJson(this.metaPath, { schema_version: LOG_SCHEMA_VERSION, stream: this.stream, segment_bytes: this.segmentBytes, max_bytes: this.maxBytes, first_available_offset: 0, next_offset: 0, dropped_before: 0, segments: [] });
    }
  }

  async loadMeta() {
    await this.ready;
    const meta = validateMeta(JSON.parse(await fs.readFile(this.metaPath, "utf8")), this.stream);
    if (meta.segment_bytes !== this.segmentBytes || meta.max_bytes !== this.maxBytes) throw new Error("log store limits do not match existing metadata");
    return meta;
  }

  append(value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const operation = this.tail.then(() => this.appendNow(buffer));
    this.tail = operation.catch(() => {});
    return operation;
  }

  async appendNow(buffer) {
    let meta = await this.loadMeta();
    let cursor = 0;
    while (cursor < buffer.length) {
      let current = meta.segments.at(-1);
      if (!current || current.end - current.start >= this.segmentBytes) {
        current = { start: meta.next_offset, end: meta.next_offset, file: segmentName(this.stream, meta.next_offset) };
        meta.segments.push(current);
      }
      const available = this.segmentBytes - (current.end - current.start);
      const length = Math.min(available, buffer.length - cursor);
      await fs.appendFile(path.join(this.root, current.file), buffer.subarray(cursor, cursor + length), { mode: 0o600 });
      cursor += length;
      current.end += length;
      meta.next_offset += length;

      const removed = [];
      while (meta.segments.length > 1 && meta.next_offset - meta.segments[0].start > this.maxBytes) removed.push(meta.segments.shift());
      meta.first_available_offset = meta.segments[0]?.start ?? meta.next_offset;
      meta.dropped_before = meta.first_available_offset;
      await atomicWriteJson(this.metaPath, meta);
      for (const segment of removed) await fs.rm(path.join(this.root, segment.file), { force: true });
    }
    return { first_available_offset: meta.first_available_offset, next_offset: meta.next_offset, dropped_before: meta.dropped_before };
  }

  async snapshot() { await this.tail; return this.loadMeta(); }

  async read(offset = 0, maxBytes = 64 * 1024) {
    await this.tail;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LOG_READ_BYTES) throw new Error(`maxBytes must be between 1 and ${MAX_LOG_READ_BYTES}`);
    const meta = await this.loadMeta();
    const start = Math.max(offset, meta.first_available_offset);
    const end = Math.min(meta.next_offset, start + maxBytes);
    const chunks = [];
    for (const segment of meta.segments) {
      if (segment.end <= start || segment.start >= end) continue;
      const from = Math.max(start, segment.start);
      const to = Math.min(end, segment.end);
      const handle = await fs.open(path.join(this.root, segment.file), "r");
      try {
        const chunk = Buffer.alloc(to - from);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, from - segment.start);
        chunks.push(chunk.subarray(0, bytesRead));
      } finally { await handle.close(); }
    }
    const content = Buffer.concat(chunks);
    return {
      first_available_offset: meta.first_available_offset,
      next_offset: start + content.length,
      stream_end_offset: meta.next_offset,
      dropped_before: meta.dropped_before,
      cursor_was_dropped: offset < meta.first_available_offset,
      content,
    };
  }
}
