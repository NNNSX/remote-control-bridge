import test from "node:test";
import assert from "node:assert/strict";
import { mediaTypeForPath } from "../lib/file-media.mjs";

test("image media types are explicit and case insensitive", () => {
  assert.equal(mediaTypeForPath("plots/loss.PNG"), "image/png");
  assert.equal(mediaTypeForPath("photos/sample.jpeg"), "image/jpeg");
  assert.equal(mediaTypeForPath("preview/model.avif"), "image/avif");
  assert.equal(mediaTypeForPath("icons/app.ico"), "image/x-icon");
});

test("unsafe active formats and non-images are not served inline", () => {
  assert.equal(mediaTypeForPath("diagram.svg"), null);
  assert.equal(mediaTypeForPath("payload.html"), null);
  assert.equal(mediaTypeForPath("archive.png.exe"), null);
  assert.equal(mediaTypeForPath("no-extension"), null);
});

