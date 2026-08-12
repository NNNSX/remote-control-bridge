import test from "node:test";
import assert from "node:assert/strict";
import { cpuUsageFromSamples } from "../lib/resource-status.mjs";

test("CPU usage uses busy and idle deltas without subtracting idle twice", () => {
  assert.equal(cpuUsageFromSamples([100, 900], [125, 975]), 25);
  assert.equal(cpuUsageFromSamples([100, 900], [100, 1000]), 0);
  assert.equal(cpuUsageFromSamples([100, 900], [200, 900]), 100);
});

test("CPU usage rejects incomplete or decreasing samples", () => {
  assert.equal(cpuUsageFromSamples([100], [200, 300]), null);
  assert.equal(cpuUsageFromSamples([100, 900], [90, 950]), null);
});
