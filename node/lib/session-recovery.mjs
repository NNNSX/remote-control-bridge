import crypto from "node:crypto";

export const SESSION_RECOVERY_COOKIE = "rcb_session_recovery";
export const SESSION_RECOVERY_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function tokenHash(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest();
}

export function issueSessionRecovery(session, randomBytes = crypto.randomBytes) {
  const token = randomBytes(32).toString("base64url");
  session.recoveryTokenHash = tokenHash(token);
  session.recoveryFingerprint = session.fingerprint;
  return token;
}

export function recoveryCookie(token) {
  return `${SESSION_RECOVERY_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_RECOVERY_MAX_AGE_SECONDS}`;
}

export function clearRecoveryCookie() {
  return `${SESSION_RECOVERY_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function recoveryTokenFromCookie(cookieHeader) {
  for (const part of String(cookieHeader || "").split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === SESSION_RECOVERY_COOKIE) return valueParts.join("=");
  }
  return null;
}

export function recoverSession(sessions, cookieHeader) {
  const token = recoveryTokenFromCookie(cookieHeader);
  if (!token || !/^[A-Za-z0-9_-]{40,80}$/.test(token)) return null;
  const supplied = tokenHash(token);
  for (const session of [...sessions.values()].reverse()) {
    const expected = session.recoveryTokenHash;
    if (!Buffer.isBuffer(expected) || expected.length !== supplied.length) continue;
    if (session.recoveryFingerprint !== session.fingerprint) continue;
    if (crypto.timingSafeEqual(expected, supplied)) return { session, token };
  }
  return null;
}
