import test from "node:test";
import assert from "node:assert/strict";

await import("../../assets/job-stream.js");
const { acceptJobEvent, mergeJobSummary } = globalThis.RcbJobStream;

test("job stream state ignores replayed SSE chunks and preserves output across stale polls", () => {
  let job = mergeJobSummary(null, { job_id: "job-1", status: "running", stdout: "hello", stderr: "", events: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  assert.equal(job.stdout, "hello");
  assert.equal(job._eventCursor, 3);
  assert.equal(acceptJobEvent(job, { lastEventId: "2" }), false);
  assert.equal(acceptJobEvent(job, { lastEventId: "4" }), true);
  job.stdout += " world";

  job = mergeJobSummary(job, { job_id: "job-1", status: "running", stdout: "hello", stderr: "", events: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  assert.equal(job.stdout, "hello world");
  assert.equal(job._eventCursor, 4);

  job = mergeJobSummary(job, { job_id: "job-1", status: "completed", stdout: "hello world", stderr: "", events: [{ id: 4 }, { id: 5 }] });
  assert.equal(job.stdout, "hello world");
  assert.equal(job.status, "completed");
  assert.equal(job._eventCursor, 5);
});
