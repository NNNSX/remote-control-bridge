import test from "node:test";
import assert from "node:assert/strict";
import {
  clearRecoveryCookie,
  issueSessionRecovery,
  recoverSession,
  recoveryCookie,
  recoveryTokenFromCookie,
  SESSION_RECOVERY_COOKIE,
} from "../lib/session-recovery.mjs";

test("browser recovery tokens are hashed, fingerprint-bound, and carried by a strict HttpOnly cookie", () => {
  const session = { id: "session-test", fingerprint: "SHA256:test" };
  const token = issueSessionRecovery(session, () => Buffer.alloc(32, 7));
  assert.equal(session.recoveryTokenHash.equals(Buffer.from(token)), false);
  assert.equal(session.recoveryFingerprint, "SHA256:test");

  const cookie = recoveryCookie(token);
  assert.match(cookie, new RegExp(`^${SESSION_RECOVERY_COOKIE}=`));
  assert.match(cookie, /; Path=\/; HttpOnly; SameSite=Strict; Max-Age=/);
  assert.equal(recoveryTokenFromCookie(`other=x; ${cookie.split(";")[0]}`), token);
  assert.equal(recoverSession(new Map([[session.id, session]]), cookie)?.session, session);

  session.fingerprint = "SHA256:changed";
  assert.equal(recoverSession(new Map([[session.id, session]]), cookie), null);
  assert.match(clearRecoveryCookie(), /Max-Age=0$/);
});
