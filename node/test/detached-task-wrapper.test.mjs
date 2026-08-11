import test from "node:test";
import assert from "node:assert/strict";
import { renderDetachedCancelCommand, renderDetachedLaunchCommand, renderDetachedTaskWrapper } from "../lib/detached-task-wrapper.mjs";

test("detached wrapper uses structured argv, bounded persistent readers, and process identity records", () => {
  const script = renderDetachedTaskWrapper({
    taskId: "task-wrapper_001",
    taskDir: ".remote-control-bridge/tasks/history/2026/08/10/task-wrapper_001",
    activeMarker: ".remote-control-bridge/tasks/active/task-wrapper_001.json",
    workdir: "AI/agent_test",
    argv: ["bash", "-lc", "printf '%s\\n' hello; printf error >&2"],
    environment: { CUDA_VISIBLE_DEVICES: "3,4" },
    segmentBytes: 1024 * 1024,
    stdoutSegments: 3,
    stderrSegments: 1,
  });
  assert.match(script, /COMMAND=\('bash' '-lc'/);
  assert.match(script, /dd bs="\$read_size" count=1 status=none/);
  assert.doesNotMatch(script, /iflag=fullblock/);
  assert.match(script, /segment_start=\$\(\(index \* SEGMENT_BYTES\)\)/);
  assert.match(script, /cat <&3 > \/dev\/null/);
  assert.match(script, /STDOUT_SEGMENTS=3/);
  assert.match(script, /process_start_ticks/);
  assert.match(script, /wrapper_process_start_ticks/);
  assert.match(script, /set -m\n\(\n  cd/);
  assert.match(script, /child_pid=\$!\nset \+m/);
  assert.match(script, /CANCEL_REQUEST_FILE/);
  assert.match(script, /write_status cancelled/);
  assert.match(script, /logging_status=degraded/);
  assert.match(script, /export CUDA_VISIBLE_DEVICES='3,4'/);
  assert.doesNotMatch(script, /eval /);
});

test("detached cancellation verifies process identity before signalling the task group", () => {
  const command = renderDetachedCancelCommand({
    taskDir: ".remote-control-bridge/tasks/history/2026/08/10/task-wrapper_001",
    pgid: 1234,
    bootId: "b35d1d86-ed78-4181-9ccb-a81e07948f21",
    processStartTicks: 5678,
  });
  assert.match(command, /EXPECTED_BOOT_ID=/);
  assert.match(command, /EXPECTED_START_TICKS=5678/);
  assert.match(command, /cancel-requested/);
  assert.match(command, /kill -TERM -- "-\$PID"/);
  assert.throws(() => renderDetachedCancelCommand({ taskDir: "../escape", pgid: 1234, bootId: "boot-a", processStartTicks: 5678 }), /safe relative POSIX path/);
  assert.throws(() => renderDetachedCancelCommand({ taskDir: "tasks/task-1", pgid: 1, bootId: "boot-a", processStartTicks: 5678 }), /pgid/);
});

test("detached wrapper rejects traversal and persisted secret variables", () => {
  const base = { taskId: "task-wrapper_002", taskDir: "tasks/task-wrapper_002", activeMarker: "active/task-wrapper_002.json", workdir: "work", argv: ["train"] };
  assert.throws(() => renderDetachedTaskWrapper({ ...base, taskDir: "../escape" }), /safe relative POSIX path/);
  assert.throws(() => renderDetachedTaskWrapper({ ...base, environment: { API_TOKEN: "secret" } }), /sensitive environment variable/);
  assert.throws(() => renderDetachedTaskWrapper({ ...base, argv: [] }), /non-empty/);
});

test("detached launch command starts a new session without interpolating an unsafe path", () => {
  const command = renderDetachedLaunchCommand(".remote-control-bridge/tasks/history/2026/08/10/task-wrapper_001/launch.sh");
  assert.match(command, /^setsid nohup bash /);
  assert.match(command, /<\/dev\/null >\/dev\/null 2>&1 &/);
  assert.throws(() => renderDetachedLaunchCommand("../launch.sh"), /safe relative POSIX path/);
});
