import path from "node:path";

const SENSITIVE_ENVIRONMENT = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIALS?|API_KEY|ACCESS_KEY)(?:_|$)/i;

function bashQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }

function safeTaskId(taskId) {
  if (typeof taskId !== "string" || !/^task-[a-z0-9][a-z0-9_-]{7,95}$/i.test(taskId)) throw new Error("taskId must be a safe task identifier");
  return taskId;
}

function safeRemotePath(value, name, allowDot = false) {
  if (typeof value !== "string" || (!allowDot && !value) || value.includes("\\") || value.includes("\0") || value.split("/").includes("..") || path.posix.isAbsolute(value)) throw new Error(`${name} must be a safe relative POSIX path`);
  if (!allowDot && value === ".") throw new Error(`${name} cannot be the remote root`);
  return value || ".";
}

function positiveInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}

function safeBootId(value) {
  if (typeof value !== "string" || !/^[a-z0-9-]{1,128}$/i.test(value)) throw new Error("bootId must be a safe identifier");
  return value;
}

function environmentLines(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) throw new Error("environment must be an object");
  return Object.entries(environment).map(([name, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`unsafe environment variable name: ${name}`);
    if (SENSITIVE_ENVIRONMENT.test(name)) throw new Error(`sensitive environment variable cannot be persisted: ${name}`);
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`environment variable ${name} must be a string without NUL bytes`);
    return `export ${name}=${bashQuote(value)}`;
  });
}

export function renderDetachedTaskWrapper({
  taskId,
  taskDir,
  activeMarker,
  workdir,
  argv,
  environment = {},
  segmentBytes = 32 * 1024 * 1024,
  stdoutSegments = 3,
  stderrSegments = 1,
}) {
  const safeId = safeTaskId(taskId);
  const safeTaskDir = safeRemotePath(taskDir, "taskDir");
  const safeActiveMarker = safeRemotePath(activeMarker, "activeMarker");
  const safeWorkdir = safeRemotePath(workdir, "workdir", true);
  if (!Array.isArray(argv) || !argv.length || argv.some((value) => typeof value !== "string" || value.includes("\0"))) throw new Error("argv must be a non-empty string array without NUL bytes");
  positiveInteger(segmentBytes, "segmentBytes", 64 * 1024, 64 * 1024 * 1024);
  positiveInteger(stdoutSegments, "stdoutSegments", 1, 64);
  positiveInteger(stderrSegments, "stderrSegments", 1, 64);
  const command = argv.map(bashQuote).join(" ");
  const exports = environmentLines(environment).join("\n");
  return `#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

TASK_ID=${bashQuote(safeId)}
TASK_DIR="$HOME/${safeTaskDir}"
ACTIVE_MARKER="$HOME/${safeActiveMarker}"
WORKDIR="$HOME/${safeWorkdir}"
SEGMENT_BYTES=${segmentBytes}
STDOUT_SEGMENTS=${stdoutSegments}
STDERR_SEGMENTS=${stderrSegments}
STATUS_FILE="$TASK_DIR/status.json"
LOGGING_DEGRADED_FILE="$TASK_DIR/logging-degraded"
CANCEL_REQUEST_FILE="$TASK_DIR/cancel-requested"
STDOUT_PIPE="$TASK_DIR/stdout.pipe"
STDERR_PIPE="$TASK_DIR/stderr.pipe"
COMMAND=(${command})
${exports}

mkdir -p "$TASK_DIR"
chmod 700 "$TASK_DIR"
rm -f "$STDOUT_PIPE" "$STDERR_PIPE"
mkfifo -m 600 "$STDOUT_PIPE" "$STDERR_PIPE"

boot_id="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf unknown)"
wrapper_pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)"
[ -n "$wrapper_pgid" ] || wrapper_pgid="$$"
wrapper_process_start_ticks="$(awk '{print $22}' /proc/$$/stat 2>/dev/null || printf 0)"

write_status() {
  local status="$1" child_pid="\${2:-null}" pgid="\${3:-null}" process_start_ticks="\${4:-null}" exit_code="\${5:-null}" logging_status="\${6:-ok}"
  local temporary="$STATUS_FILE.tmp.$$" updated_at
  updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"schema_version":1,"task_id":"%s","status":"%s","logging_status":"%s","updated_at":"%s","wrapper_pid":%s,"wrapper_pgid":%s,"wrapper_process_start_ticks":%s,"child_pid":%s,"pgid":%s,"boot_id":"%s","process_start_ticks":%s,"exit_code":%s}\n' \
    "$TASK_ID" "$status" "$logging_status" "$updated_at" "$$" "$wrapper_pgid" "$wrapper_process_start_ticks" "$child_pid" "$pgid" "$boot_id" "$process_start_ticks" "$exit_code" > "$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$STATUS_FILE"
}

spool() {
  local input="$1" prefix="$2" keep="$3"
  local index=0 segment_start current current_size remaining read_size chunk_file chunk_size
  chunk_file="$TASK_DIR/.spool-$BASHPID-$RANDOM.chunk"
  exec 3<"$input"
  while true; do
    segment_start=$((index * SEGMENT_BYTES))
    current="$(printf '%s%020d.log' "$prefix" "$segment_start")"
    current_size=0
    if [ -f "$current" ]; then current_size="$(wc -c < "$current")"; fi
    if [ "$current_size" -ge "$SEGMENT_BYTES" ]; then index=$((index + 1)); continue; fi

    remaining=$((SEGMENT_BYTES - current_size))
    read_size=$((1024 * 1024))
    if [ "$remaining" -lt "$read_size" ]; then read_size="$remaining"; fi
    if ! dd bs="$read_size" count=1 status=none <&3 > "$chunk_file"; then
      printf '%s\n' "$prefix" >> "$LOGGING_DEGRADED_FILE" 2>/dev/null || true
      rm -f "$chunk_file"
      cat <&3 > /dev/null 2>&1 || true
      exec 3<&-
      return 75
    fi
    chunk_size="$(wc -c < "$chunk_file")"
    if [ "$chunk_size" -eq 0 ]; then
      rm -f "$chunk_file"
      break
    fi

    if [ ! -f "$current" ]; then
      set -- "$prefix"*.log
      if [ -e "$1" ]; then
        count=$#
        while [ "$count" -ge "$keep" ]; do rm -f -- "$1"; shift; count=$((count - 1)); done
      fi
    fi
    if ! cat "$chunk_file" >> "$current"; then
      printf '%s\n' "$prefix" >> "$LOGGING_DEGRADED_FILE" 2>/dev/null || true
      rm -f "$chunk_file"
      cat <&3 > /dev/null 2>&1 || true
      exec 3<&-
      return 75
    fi
    rm -f "$chunk_file"
    current_size=$((current_size + chunk_size))
    if [ "$current_size" -ge "$SEGMENT_BYTES" ]; then index=$((index + 1)); fi
  done
  rm -f "$chunk_file"
  exec 3<&-
}

cleanup() { rm -f "$STDOUT_PIPE" "$STDERR_PIPE"; }
trap cleanup EXIT

rm -f "$LOGGING_DEGRADED_FILE"
write_status starting null null null null ok
spool "$STDOUT_PIPE" "$TASK_DIR/stdout." "$STDOUT_SEGMENTS" &
stdout_spool_pid=$!
spool "$STDERR_PIPE" "$TASK_DIR/stderr." "$STDERR_SEGMENTS" &
stderr_spool_pid=$!

set +e
set -m
(
  cd "$WORKDIR"
  exec "\${COMMAND[@]}"
) > "$STDOUT_PIPE" 2> "$STDERR_PIPE" &
child_pid=$!
set +m
set -e
pgid="$child_pid"
process_start_ticks=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  observed_pgid="$(ps -o pgid= -p "$child_pid" 2>/dev/null | tr -d ' ' || true)"
  observed_start_ticks="$(awk '{print $22}' "/proc/$child_pid/stat" 2>/dev/null || true)"
  if [ -n "$observed_pgid" ] && [ -n "$observed_start_ticks" ]; then
    pgid="$observed_pgid"
    process_start_ticks="$observed_start_ticks"
    break
  fi
  sleep 0.02
done
write_status running "$child_pid" "$pgid" "$process_start_ticks" null ok

set +e
wait "$child_pid"
exit_code=$?
wait "$stdout_spool_pid"
stdout_spool_status=$?
wait "$stderr_spool_pid"
stderr_spool_status=$?
set -e

printf '%s\n' "$exit_code" > "$TASK_DIR/exit-code"
chmod 600 "$TASK_DIR/exit-code"
logging_status=ok
if [ "$stdout_spool_status" -ne 0 ] || [ "$stderr_spool_status" -ne 0 ] || [ -s "$LOGGING_DEGRADED_FILE" ]; then logging_status=degraded; fi
if [ -f "$CANCEL_REQUEST_FILE" ]; then
  write_status cancelled null "$pgid" "$process_start_ticks" "$exit_code" "$logging_status"
  rm -f "$ACTIVE_MARKER"
elif [ "$exit_code" -eq 0 ]; then
  write_status completed null "$pgid" "$process_start_ticks" "$exit_code" "$logging_status"
  rm -f "$ACTIVE_MARKER"
else
  write_status failed null "$pgid" "$process_start_ticks" "$exit_code" "$logging_status"
  rm -f "$ACTIVE_MARKER"
fi
exit "$exit_code"
`;
}

export function renderDetachedCancelCommand({ taskDir, pgid, bootId, processStartTicks }) {
  const safeTaskDir = safeRemotePath(taskDir, "taskDir");
  positiveInteger(pgid, "pgid", 2, 2_147_483_647);
  positiveInteger(processStartTicks, "processStartTicks", 1, Number.MAX_SAFE_INTEGER);
  const safeExpectedBootId = safeBootId(bootId);
  return `TASK_DIR="$HOME/${safeTaskDir}"; PID=${pgid}; EXPECTED_BOOT_ID=${bashQuote(safeExpectedBootId)}; EXPECTED_START_TICKS=${processStartTicks}; current_boot_id="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf unknown)"; [ "$current_boot_id" = "$EXPECTED_BOOT_ID" ] || { printf '%s\n' 'boot ID changed' >&2; exit 73; }; current_pgid="$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d ' ' || true)"; [ "$current_pgid" = "$PID" ] || { printf '%s\n' 'process group identity changed' >&2; exit 74; }; current_start_ticks="$(awk '{print $22}' "/proc/$PID/stat" 2>/dev/null || true)"; [ "$current_start_ticks" = "$EXPECTED_START_TICKS" ] || { printf '%s\n' 'process start time changed' >&2; exit 75; }; temporary="$TASK_DIR/cancel-requested.tmp.$$"; printf '{"requested_at":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$temporary"; chmod 600 "$temporary"; mv -f "$temporary" "$TASK_DIR/cancel-requested"; kill -TERM -- "-$PID"`;
}

export function renderDetachedLaunchCommand(wrapperPath) {
  const safeWrapperPath = safeRemotePath(wrapperPath, "wrapperPath");
  return `setsid nohup bash "$HOME/${safeWrapperPath}" </dev/null >/dev/null 2>&1 & printf '%s\\n' "$!"`;
}
