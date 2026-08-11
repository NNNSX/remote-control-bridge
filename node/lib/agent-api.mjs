export const AGENT_SCOPES = ["status:read", "jobs:read", "jobs:execute", "jobs:cancel", "files:read", "tasks:read", "tasks:execute", "tasks:cancel"];
export function enabledAgentScopes({ remoteTaskDeletionEnabled = false } = {}) { return remoteTaskDeletionEnabled ? [...AGENT_SCOPES, "tasks:delete"] : [...AGENT_SCOPES]; }

export function agentScopeForRequest(method, suffix) {
  const verb = String(method || "").toUpperCase();
  const route = String(suffix || "").replace(/^\/+/, "");
  if (verb === "GET" && (route === "session" || route === "status")) return "status:read";
  if (verb === "GET" && route === "terminals") return "jobs:read";
  if (verb === "POST" && route === "commands") return "jobs:execute";
  if (verb === "GET" && /^jobs\/[^/]+(?:\/events)?$/.test(route)) return "jobs:read";
  if (verb === "DELETE" && /^jobs\/[^/]+$/.test(route)) return "jobs:cancel";
  if (verb === "GET" && ["files", "files/preview", "files/media", "files/download"].includes(route)) return "files:read";
  if (verb === "POST" && route === "logs") return "files:read";
  if (verb === "GET" && (route === "tasks" || route === "tasks/capabilities" || route === "tasks/history" || route === "tasks/storage" || route === "tasks/cleanup-preview" || /^tasks\/[^/]+(?:\/logs)?$/.test(route))) return "tasks:read";
  if (verb === "POST" && (route === "tasks" || route === "tasks/reconcile" || route === "tasks/maintenance" || /^tasks\/[^/]+\/(?:pin|unpin)$/.test(route))) return "tasks:execute";
  if (verb === "POST" && /^tasks\/[^/]+\/delete-record$/.test(route)) return "tasks:delete";
  if (verb === "POST" && /^tasks\/[^/]+\/cancel$/.test(route)) return "tasks:cancel";
  return null;
}

export function parseCommandRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("command request must be an object");
  if (typeof value.command !== "string" || !value.command.trim() || value.command.length > 65536) throw new Error("command must contain between 1 and 65536 characters");
  const timeout = value.timeout_seconds == null ? 120 : value.timeout_seconds;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error("timeout_seconds must be an integer between 1 and 3600");
  if (value.terminal_id != null && (typeof value.terminal_id !== "string" || !value.terminal_id || value.terminal_id.length > 128)) throw new Error("terminal_id must be a non-empty string of at most 128 characters");
  if (value.new_terminal != null && typeof value.new_terminal !== "boolean") throw new Error("new_terminal must be a boolean");
  return {
    command: value.command,
    timeout_seconds: timeout,
    terminal_id: value.terminal_id || null,
    new_terminal: Boolean(value.new_terminal),
  };
}

export function tailTextLines(content, requestedLines = 200) {
  const text = String(content || "");
  const lines = Math.max(1, Math.min(2000, Number(requestedLines) || 200));
  const preservesTrailingNewline = /\r?\n$/.test(text);
  const rows = text.split(/\r?\n/);
  if (preservesTrailingNewline) rows.pop();
  const result = rows.slice(-lines).join("\n");
  return preservesTrailingNewline && result ? `${result}\n` : result;
}
