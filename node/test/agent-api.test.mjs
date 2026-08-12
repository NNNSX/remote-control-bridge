import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_SCOPES, BASE_AGENT_SCOPES, TASK_AGENT_SCOPES, agentScopeForRequest, enabledAgentScopes, parseCommandRequest, tailTextLines } from "../lib/agent-api.mjs";

test("Agent routes map only to their required scopes", () => {
  assert.deepEqual(AGENT_SCOPES, ["status:read", "jobs:read", "jobs:execute", "jobs:cancel", "files:read", "files:write", "tasks:read", "tasks:execute", "tasks:cancel"]);
  assert.deepEqual(BASE_AGENT_SCOPES, ["status:read", "jobs:read", "jobs:execute", "jobs:cancel", "files:read", "files:write"]);
  assert.deepEqual(TASK_AGENT_SCOPES, ["tasks:read", "tasks:execute", "tasks:cancel"]);
  assert.deepEqual(enabledAgentScopes(), BASE_AGENT_SCOPES);
  assert.deepEqual(enabledAgentScopes({ persistentTasksEnabled: true }), AGENT_SCOPES);
  assert.deepEqual(enabledAgentScopes({ remoteTaskDeletionEnabled: true }), BASE_AGENT_SCOPES);
  assert.deepEqual(enabledAgentScopes({ persistentTasksEnabled: true, remoteTaskDeletionEnabled: true }), [...AGENT_SCOPES, "tasks:delete"]);
  assert.equal(agentScopeForRequest("GET", "session"), "status:read");
  assert.equal(agentScopeForRequest("POST", "commands"), "jobs:execute");
  assert.equal(agentScopeForRequest("GET", "proxy"), "jobs:read");
  assert.equal(agentScopeForRequest("POST", "proxy"), "jobs:execute");
  assert.equal(agentScopeForRequest("DELETE", "proxy"), "jobs:cancel");
  assert.equal(agentScopeForRequest("GET", "jobs/job-1/events"), "jobs:read");
  assert.equal(agentScopeForRequest("DELETE", "jobs/job-1"), "jobs:cancel");
  assert.equal(agentScopeForRequest("GET", "files/preview"), "files:read");
  assert.equal(agentScopeForRequest("PUT", "files/upload"), "files:write");
  assert.equal(agentScopeForRequest("PUT", "files/content"), "files:write");
  assert.equal(agentScopeForRequest("POST", "files/mkdir"), "files:write");
  assert.equal(agentScopeForRequest("POST", "files/rename"), "files:write");
  assert.equal(agentScopeForRequest("DELETE", "files"), "files:write");
  assert.equal(agentScopeForRequest("POST", "logs"), "files:read");
  assert.equal(agentScopeForRequest("GET", "tasks/capabilities"), "tasks:read");
  assert.equal(agentScopeForRequest("GET", "tasks/task-20260810-abcdef123456/logs"), "tasks:read");
  assert.equal(agentScopeForRequest("GET", "tasks/history"), "tasks:read");
  assert.equal(agentScopeForRequest("GET", "tasks/storage"), "tasks:read");
  assert.equal(agentScopeForRequest("GET", "tasks/cleanup-preview"), "tasks:read");
  assert.equal(agentScopeForRequest("POST", "tasks"), "tasks:execute");
  assert.equal(agentScopeForRequest("POST", "tasks/reconcile"), "tasks:execute");
  assert.equal(agentScopeForRequest("POST", "tasks/maintenance"), "tasks:execute");
  assert.equal(agentScopeForRequest("POST", "tasks/task-20260810-abcdef123456/pin"), "tasks:execute");
  assert.equal(agentScopeForRequest("POST", "tasks/task-20260810-abcdef123456/unpin"), "tasks:execute");
  assert.equal(agentScopeForRequest("POST", "tasks/task-20260810-abcdef123456/delete-record"), "tasks:delete");
  assert.equal(agentScopeForRequest("POST", "tasks/task-20260810-abcdef123456/cancel"), "tasks:cancel");
  assert.equal(agentScopeForRequest("GET", "unknown"), null);
});

test("Agent command requests have one validated timeout contract", () => {
  assert.deepEqual(parseCommandRequest({ command: "pwd" }), { command: "pwd", timeout_seconds: 120, terminal_id: null, new_terminal: false, proxy: false });
  assert.deepEqual(parseCommandRequest({ command: "echo ok", timeout_seconds: 5, terminal_id: "term-1", new_terminal: false, proxy: true }), { command: "echo ok", timeout_seconds: 5, terminal_id: "term-1", new_terminal: false, proxy: true });
  assert.throws(() => parseCommandRequest({ command: "pwd", timeout_seconds: 0 }), /between 1 and 3600/);
  assert.throws(() => parseCommandRequest({ command: "pwd", timeout_seconds: "5" }), /between 1 and 3600/);
  assert.throws(() => parseCommandRequest({ command: "pwd", new_terminal: "yes" }), /must be a boolean/);
  assert.throws(() => parseCommandRequest({ command: "pwd", proxy: "yes" }), /must be a boolean/);
});

test("log tails count content lines instead of the trailing newline", () => {
  assert.equal(tailTextLines("one\ntwo\nthree\n", 2), "two\nthree\n");
  assert.equal(tailTextLines("one\ntwo\nthree", 2), "two\nthree");
});
