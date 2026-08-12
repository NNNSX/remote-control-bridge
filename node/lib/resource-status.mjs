export function cpuUsageFromSamples(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length < 2 || after.length < 2) return null;
  const values = [...before.slice(0, 2), ...after.slice(0, 2)].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const busyDelta = values[2] - values[0];
  const idleDelta = values[3] - values[1];
  const totalDelta = busyDelta + idleDelta;
  if (busyDelta < 0 || idleDelta < 0 || totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, Number((busyDelta * 100 / totalDelta).toFixed(1))));
}
