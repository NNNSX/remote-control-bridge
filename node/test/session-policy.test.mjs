import test from "node:test";
import assert from "node:assert/strict";
import {
  createTerminal,
  ensureTerminal,
  MAX_TERMINALS,
  sessionConnectionPolicy,
  SSH_KEEPALIVE_COUNT_MAX,
  SSH_KEEPALIVE_INTERVAL_MS,
  sshKeepaliveOptions,
} from "../lib/session-policy.mjs";

function terminal(id, busy = false) { return { terminal_id: id, index: Number(id.slice(-1)) || 1, busy, current_job_id: busy ? "job" : null, jobs: [] }; }

test("sessions use protocol keepalive without an application idle timeout", () => {
  assert.deepEqual(sshKeepaliveOptions(), {
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
  });
  assert.deepEqual(sessionConnectionPolicy(), {
    expires_in_seconds: null,
    idle_timeout_enabled: false,
    keepalive_interval_seconds: 30,
    keepalive_failure_threshold: 10,
  });
});

test("terminal selection reuses idle slots, creates parallel slots, and enforces the limit", () => {
  let next = 2;
  const session = { terminals: new Map([["term-1", terminal("term-1")]]) };
  const factory = () => `term-${next++}`;
  assert.equal(ensureTerminal(session, {}, factory).terminal_id, "term-1");
  assert.throws(() => ensureTerminal(session, { terminal_id: "missing" }, factory), /unknown terminal_id/);

  session.terminals.get("term-1").busy = true;
  assert.equal(ensureTerminal(session, {}, factory).terminal_id, "term-2");
  session.terminals.get("term-2").busy = true;
  createTerminal(session, factory).busy = true;
  createTerminal(session, factory).busy = true;
  assert.equal(session.terminals.size, MAX_TERMINALS);
  assert.throws(() => ensureTerminal(session, {}, factory), /at most 4 terminals/);
});
