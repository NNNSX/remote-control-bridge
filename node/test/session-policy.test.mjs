import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_GRANT_RENEW_INTERVAL_MS,
  AGENT_GRANT_RETRY_INTERVAL_MS,
  createTerminal,
  ensureTerminal,
  MAX_TERMINALS,
  scheduleAgentGrantRenewal,
  sessionConnectionPolicy,
  SSH_KEEPALIVE_COUNT_MAX,
  SSH_KEEPALIVE_INTERVAL_MS,
  sshKeepaliveOptions,
  stopAgentGrantRenewal,
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

test("Agent grants renew indefinitely while enabled and retry transient failures", async () => {
  const timers = [];
  const cleared = [];
  const setTimer = (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; };
  const clearTimer = (timer) => cleared.push(timer);
  const session = { agentEnabled: true, controlGrantId: "grant-test", agentRenewTimer: null };
  let attempts = 0;
  const renew = async (grantId) => {
    assert.equal(grantId, "grant-test");
    attempts += 1;
    if (attempts === 1) throw new Error("control temporarily unavailable");
    return { grant_id: grantId, expires_at: 123456 };
  };

  scheduleAgentGrantRenewal(session, renew, { setTimer, clearTimer });
  assert.equal(timers[0].delay, AGENT_GRANT_RENEW_INTERVAL_MS);
  await timers[0].callback();
  assert.equal(session.agentRenewLastError, "control temporarily unavailable");
  assert.equal(timers[1].delay, AGENT_GRANT_RETRY_INTERVAL_MS);
  await timers[1].callback();
  assert.equal(session.controlGrantExpiresAt, 123456);
  assert.equal(session.agentRenewLastError, null);
  assert.equal(timers[2].delay, AGENT_GRANT_RENEW_INTERVAL_MS);

  session.agentEnabled = false;
  stopAgentGrantRenewal(session, clearTimer);
  assert.equal(session.agentRenewTimer, null);
  assert.deepEqual(cleared, [timers[2]]);
});

test("an in-flight renewal cannot restart after Agent access is disabled", async () => {
  let callback;
  let resolveRenewal;
  const session = { agentEnabled: true, controlGrantId: "grant-test", agentRenewTimer: null };
  const renewal = new Promise((resolve) => { resolveRenewal = resolve; });
  scheduleAgentGrantRenewal(session, () => renewal, { setTimer: (value) => { callback = value; return { unref() {} }; } });
  const running = callback();
  session.agentEnabled = false;
  session.controlGrantId = null;
  resolveRenewal({ grant_id: "grant-test", expires_at: 123456 });
  await running;
  assert.equal(session.agentRenewTimer, null);
  assert.equal(session.controlGrantExpiresAt, undefined);
});
