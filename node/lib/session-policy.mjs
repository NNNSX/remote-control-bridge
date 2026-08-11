export const MAX_TERMINALS = 4;
export const SSH_KEEPALIVE_INTERVAL_MS = 30 * 1000;
export const SSH_KEEPALIVE_COUNT_MAX = 10;

export function sshKeepaliveOptions() {
  return {
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
  };
}

export function sessionConnectionPolicy() {
  return {
    expires_in_seconds: null,
    idle_timeout_enabled: false,
    keepalive_interval_seconds: SSH_KEEPALIVE_INTERVAL_MS / 1000,
    keepalive_failure_threshold: SSH_KEEPALIVE_COUNT_MAX,
  };
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
