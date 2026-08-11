export const MAX_TERMINALS = 4;
export const SSH_KEEPALIVE_INTERVAL_MS = 30 * 1000;
export const SSH_KEEPALIVE_COUNT_MAX = 10;
export const AGENT_GRANT_TTL_SECONDS = 24 * 60 * 60;
export const AGENT_GRANT_RENEW_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const AGENT_GRANT_RETRY_INTERVAL_MS = 60 * 1000;

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

export function stopAgentGrantRenewal(session, clearTimer = globalThis.clearTimeout) {
  if (session.agentRenewTimer) clearTimer(session.agentRenewTimer);
  session.agentRenewTimer = null;
}

export function scheduleAgentGrantRenewal(session, renewGrant, options = {}) {
  const setTimer = options.setTimer || globalThis.setTimeout;
  const clearTimer = options.clearTimer || globalThis.clearTimeout;
  const intervalMs = options.intervalMs || AGENT_GRANT_RENEW_INTERVAL_MS;
  const retryMs = options.retryMs || AGENT_GRANT_RETRY_INTERVAL_MS;
  const firstDelayMs = options.firstDelayMs || intervalMs;
  stopAgentGrantRenewal(session, clearTimer);

  const schedule = (delayMs) => {
    if (!session.agentEnabled || !session.controlGrantId) return;
    const grantId = session.controlGrantId;
    const timer = setTimer(async () => {
      if (session.agentRenewTimer === timer) session.agentRenewTimer = null;
      if (!session.agentEnabled || session.controlGrantId !== grantId) return;
      try {
        const renewed = await renewGrant(grantId);
        if (!session.agentEnabled || session.controlGrantId !== grantId) return;
        if (!renewed || renewed.grant_id !== grantId) throw new Error("control renewed an unexpected Agent grant");
        session.controlGrantExpiresAt = renewed.expires_at ?? null;
        session.agentRenewLastError = null;
        schedule(intervalMs);
      } catch (error) {
        if (!session.agentEnabled || session.controlGrantId !== grantId) return;
        session.agentRenewLastError = error instanceof Error ? error.message : "Agent grant renewal failed";
        schedule(retryMs);
      }
    }, delayMs);
    session.agentRenewTimer = timer;
    timer.unref?.();
  };

  schedule(firstDelayMs);
  return session.agentRenewTimer;
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
