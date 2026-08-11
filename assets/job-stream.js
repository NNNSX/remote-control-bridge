(function attachJobStreamState(root) {
  function summaryCursor(summary) {
    return Math.max(0, ...(summary?.events || []).map((event) => Number(event?.id) || 0));
  }

  function mergeJobSummary(previous, summary) {
    const previousCursor = Number(previous?._eventCursor) || 0;
    const nextCursor = summaryCursor(summary);
    const merged = { ...(previous || {}), ...summary, _eventCursor: Math.max(previousCursor, nextCursor) };
    if (previous && nextCursor < previousCursor) {
      merged.stdout = previous.stdout;
      merged.stderr = previous.stderr;
      merged.truncated = previous.truncated;
    }
    return merged;
  }

  function acceptJobEvent(job, event) {
    const eventId = Number(event?.lastEventId);
    if (!Number.isFinite(eventId) || eventId <= 0) return true;
    const cursor = Number(job?._eventCursor) || 0;
    if (eventId <= cursor) return false;
    job._eventCursor = eventId;
    return true;
  }

  root.RcbJobStream = { acceptJobEvent, mergeJobSummary, summaryCursor };
})(typeof globalThis === "object" ? globalThis : window);
