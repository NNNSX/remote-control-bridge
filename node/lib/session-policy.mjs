export const MAX_TERMINALS = 4;
export const SESSION_TTL_MS = 15 * 60 * 1000;

export function touchSession(session, now = Date.now()) {
  session.expiresAt = now + SESSION_TTL_MS;
  return session;
}

export function sessionExpired(session, now = Date.now()) {
  return !Number.isFinite(session.expiresAt) || session.expiresAt <= now;
}

export function sessionExpiresInSeconds(session, now = Date.now()) {
  return Math.max(0, Math.ceil((session.expiresAt - now) / 1000));
}

export function createTerminal(session, idFactory) {
  if (session.terminals.size >= MAX_TERMINALS) throw new Error(`a session can have at most ${MAX_TERMINALS} terminals`);
  const terminalId = idFactory();
  const terminal = { terminal_id: terminalId, index: session.terminals.size + 1, busy: false, current_job_id: null, jobs: [] };
  session.terminals.set(terminalId, terminal);
  return terminal;
}

export function ensureTerminal(session, data, idFactory) {
  const selected = data.terminal_id ? session.terminals.get(data.terminal_id) : null;
  if (data.terminal_id && !selected) throw new Error("unknown terminal_id");
  if (selected && !selected.busy && !data.new_terminal) return selected;
  const reusable = [...session.terminals.values()].find((terminal) => !terminal.busy && terminal.terminal_id !== data.terminal_id);
  if (reusable) return reusable;
  return createTerminal(session, idFactory);
}
