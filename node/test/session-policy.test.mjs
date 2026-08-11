import test from "node:test";
import assert from "node:assert/strict";
import { createTerminal, ensureTerminal, MAX_TERMINALS, sessionExpired, sessionExpiresInSeconds, SESSION_TTL_MS, touchSession } from "../lib/session-policy.mjs";

function terminal(id, busy = false) { return { terminal_id: id, index: Number(id.slice(-1)) || 1, busy, current_job_id: busy ? "job" : null, jobs: [] }; }

test("sessions expire after fifteen idle minutes and activity extends the deadline", () => {
  const session = {};
  touchSession(session, 1000);
  assert.equal(session.expiresAt, 1000 + SESSION_TTL_MS);
  assert.equal(sessionExpired(session, 1000 + SESSION_TTL_MS - 1), false);
  assert.equal(sessionExpired(session, 1000 + SESSION_TTL_MS), true);
  assert.equal(sessionExpiresInSeconds(session, 1000), 900);
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
