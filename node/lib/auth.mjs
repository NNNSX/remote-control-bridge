import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function loadOrCreateKey(file) {
  try {
    const key = await fs.readFile(file);
    if (key.length !== 32) throw new Error("session key must contain exactly 32 bytes");
    return key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const key = crypto.randomBytes(32);
    await fs.writeFile(file, key, { mode: 0o600 });
    return key;
  }
}

export function authorized(request, key, authority) {
  if (request.headers.host?.toLowerCase() !== authority.toLowerCase()) return false;
  const supplied = Buffer.from(String(request.headers["x-session-key"] || ""), "utf8");
  const expected = Buffer.from(key.toString("hex"), "utf8");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
