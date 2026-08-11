import fs from "node:fs/promises";
import path from "node:path";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class ControlClient {
  constructor({ port, key }) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("control port must be between 1024 and 65535");
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("control key must contain exactly 32 bytes");
    this.port = port;
    this.key = key;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async health() {
    const response = await fetch(`${this.baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`control health failed (${response.status})`);
    return response.json();
  }

  async post(route, payload) {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-key": this.key.toString("hex") },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    const result = await response.json().catch(() => ({ error: "control returned an invalid response" }));
    if (!response.ok || result?.error) throw new Error(result?.error || `control request failed (${response.status})`);
    return result;
  }

  grant(binding, scopes, ttlSeconds = 86400) { return this.post("/api/v1/grants", { binding, scopes, ttl_seconds: ttlSeconds }); }
  renew(grantId, binding, ttlSeconds = 86400) { return this.post("/api/v1/grants/renew", { grant_id: grantId, binding, ttl_seconds: ttlSeconds }); }
  authorize(binding) { return this.post("/api/v1/authorize", { binding }); }
  verify(token, binding, scope) { return this.post("/api/v1/verify", { token, binding, scope }); }
  revoke(grantId) { return this.post("/api/v1/revoke", { grant_id: grantId }); }
}

export async function createControlClient({ dataDir, port, timeoutMs = 5000 }) {
  const keyPath = path.join(dataDir, "control_signing.key");
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const client = new ControlClient({ port, key: await fs.readFile(keyPath) });
      await client.health();
      return client;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw new Error(`authorization control plane is unavailable: ${lastError?.message || "startup timed out"}`);
}
