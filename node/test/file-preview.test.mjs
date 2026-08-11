import test from "node:test";
import assert from "node:assert/strict";
import { decodeTextPreview, isKnownBinaryPath, MAX_IMAGE_PREVIEW_BYTES, MAX_TEXT_PREVIEW_BYTES } from "../lib/file-preview.mjs";

test("known model, archive, and document formats are never treated as text", () => {
  for (const name of ["model.pt", "weights.SAFETENSORS", "data.npy", "archive.tar.gz", "report.pdf", "table.xlsx"]) {
    assert.equal(isKnownBinaryPath(name), true, name);
  }
  assert.equal(isKnownBinaryPath("train.py"), false);
  assert.equal(isKnownBinaryPath("metrics.jsonl"), false);
});

test("text preview rejects binary and invalid UTF-8 samples", () => {
  assert.equal(decodeTextPreview(Buffer.from("hello\nworld\n")), "hello\nworld\n");
  assert.throws(() => decodeTextPreview(Buffer.from([0x50, 0x00, 0x54])), /binary/);
  assert.throws(() => decodeTextPreview(Buffer.from([0xff, 0xfe, 0xfd])), /UTF-8/);
});

test("preview byte limits remain bounded", () => {
  assert.equal(MAX_TEXT_PREVIEW_BYTES, 256 * 1024);
  assert.equal(MAX_IMAGE_PREVIEW_BYTES, 16 * 1024 * 1024);
});
