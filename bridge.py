#!/usr/bin/env python3
"""Serve a loopback-only, allowlisted SSH control bridge for existing hosts."""

from __future__ import annotations

import argparse
import asyncio
import base64
import concurrent.futures
import hashlib
import json
import mimetypes
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import parse_qs, urlsplit


RUNTIME_DIR = Path(__file__).with_name(".runtime")
DEPS_DIR = Path(__file__).with_name(".deps")
for dependency_dir in (DEPS_DIR, RUNTIME_DIR):
    if dependency_dir.is_dir():
        sys.path.insert(0, str(dependency_dir))
try:
    import paramiko
except ImportError:
    paramiko = None
try:
    import asyncssh
except ImportError:
    asyncssh = None


NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
TARGET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,254}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
TOP_KEYS = {"version", "connect_timeout", "command_timeout", "ssh_config", "hosts"}
HOST_KEYS = {"name", "target", "workdir", "logs", "artifact_root", "artifacts"}
LOG_KEYS = {"name", "path", "max_lines"}
ARTIFACT_KEYS = {"name", "url", "sha256", "destination", "max_bytes"}
STATIC_FILES = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/app.css": "app.css"}
SSH_KEEPALIVE_INTERVAL_SECONDS = 30
SSH_KEEPALIVE_COUNT_MAX = 10
AUTH_TIMEOUT_SECONDS = 90
SESSION_OPEN_PROXY_TIMEOUT_SECONDS = 210
DEFAULT_SSH_KEY_PATH = Path.home() / ".ssh" / "id_ed25519"
MAX_COMMAND_CHARS = 64 * 1024
MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024
DEFAULT_COMMAND_TIMEOUT_SECONDS = 120
MAX_COMMAND_TIMEOUT_SECONDS = 3600
MAX_TERMINALS_PER_SESSION = 4
MAX_GLOBAL_ACTIVE_JOBS = 8
MAX_JOB_EVENTS = 512


def session_connection_policy() -> dict[str, Any]:
    return {
        "expires_in_seconds": None,
        "idle_timeout_enabled": False,
        "keepalive_interval_seconds": SSH_KEEPALIVE_INTERVAL_SECONDS,
        "keepalive_failure_threshold": SSH_KEEPALIVE_COUNT_MAX,
    }


SENSITIVE_SEGMENTS = {".aws", ".git", ".gnupg", ".kube", ".ssh", "authorized_keys", "credentials", "credentials.json", "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa", "known_hosts", "secrets", "secrets.json", ".netrc"}
SENSITIVE_SUFFIXES = (".key", ".p12", ".pem", ".pfx")
STATUS_SCRIPT = r'''#!/bin/sh
set -u
if [ "$#" -gt 0 ]; then workdir=$1; else workdir=${HOME:-"$(pwd)"}; fi
emit() { printf 'RCB\t%s\t%s\n' "$1" "$2"; }
emit hostname "$(hostname 2>/dev/null || printf unknown)"
emit uptime_seconds "$(awk '{print int($1)}' /proc/uptime 2>/dev/null || printf unknown)"
emit load_average "$(awk '{print $1 " " $2 " " $3}' /proc/loadavg 2>/dev/null || printf unknown)"
emit workdir "$workdir"
if [ -d "$workdir" ]; then emit workdir_exists true; else emit workdir_exists false; fi
emit root_disk "$(df -Pk / 2>/dev/null | awk 'NR==2 {print $2 "|" $3 "|" $4 "|" $5}')"
if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null |
    while IFS= read -r row; do emit gpu "$row"; done
fi
'''


class BridgeError(ValueError):
    pass


class ConflictError(BridgeError):
    pass


class JobCancelled(Exception):
    pass


class JobTimedOut(Exception):
    pass


class HostTrustRequired(BridgeError):
    def __init__(self, token: str, host: str, port: int, key_type: str, fingerprint: str):
        super().__init__("SSH host key is not trusted yet")
        self.token = token
        self.host = host
        self.port = port
        self.key_type = key_type
        self.fingerprint = fingerprint


class ControlClient:
    """Small client for the optional loopback authorization control plane."""

    def __init__(self, base_url: str | None, key_file: Path | None = None):
        self.base_url = None
        self.key = None
        if base_url:
            parsed = urlsplit(base_url)
            if (
                parsed.scheme != "http"
                or parsed.hostname != "127.0.0.1"
                or parsed.username is not None
                or parsed.password is not None
                or parsed.query
                or parsed.fragment
                or parsed.path not in {"", "/"}
                or parsed.port is None
            ):
                raise BridgeError("control URL must be http://127.0.0.1:<port>")
            self.base_url = f"http://127.0.0.1:{parsed.port}"
            path = key_file or (Path(__file__).with_name("data") / "control_signing.key")
            if not path.is_file():
                raise BridgeError("control-plane signing key file is unavailable")
            key = path.read_bytes()
            if len(key) != 32:
                raise BridgeError("control-plane signing key must contain exactly 32 bytes")
            self.key = key.hex()

    @property
    def enabled(self) -> bool:
        return bool(self.base_url and self.key)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.enabled:
            raise BridgeError("authorization control plane is unavailable")
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + path, data=body, method="POST",
            headers={"Content-Type": "application/json", "X-Control-Key": self.key or ""},
        )
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                result = json.loads(response.read().decode("utf-8"))
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
            raise BridgeError("authorization control plane is unavailable") from exc
        if not isinstance(result, dict) or result.get("error"):
            raise BridgeError(str(result.get("error", "control-plane request failed")) if isinstance(result, dict) else "control-plane request failed")
        return result

    def grant(self, binding: dict[str, Any], scopes: list[str], ttl_seconds: int = 86400) -> dict[str, Any]:
        return self._post("/api/v1/grants", {"binding": binding, "scopes": scopes, "ttl_seconds": ttl_seconds})

    def authorize(self, binding: dict[str, Any]) -> dict[str, Any]:
        return self._post("/api/v1/authorize", {"binding": binding})

    def revoke(self, grant_id: str) -> dict[str, Any]:
        return self._post("/api/v1/revoke", {"grant_id": grant_id})


class SessionDaemonClient:
    """Authenticated client for the optional loopback SSH session daemon."""

    def __init__(self, base_url: str | None, key_file: Path | None = None):
        self.base_url = None
        self.key = None
        if not base_url:
            return
        parsed = urlsplit(base_url)
        if (
            parsed.scheme != "http"
            or parsed.hostname != "127.0.0.1"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
            or parsed.port is None
        ):
            raise BridgeError("session URL must be http://127.0.0.1:<port>")
        path = key_file or (Path(__file__).with_name("data") / "sessiond.key")
        if not path.is_file():
            raise BridgeError("session-daemon key file is unavailable")
        key = path.read_bytes()
        if len(key) != 32:
            raise BridgeError("session-daemon key must contain exactly 32 bytes")
        self.base_url = f"http://127.0.0.1:{parsed.port}"
        self.key = key.hex()

    @property
    def enabled(self) -> bool:
        return bool(self.base_url and self.key)

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
        if not self.enabled or not path.startswith("/internal/v1/") or any(char in path for char in "\r\n"):
            raise BridgeError("SSH session daemon is unavailable")
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + path, data=body, method=method,
            headers={"Content-Type": "application/json", "X-Session-Key": self.key or ""},
        )
        timeout = SESSION_OPEN_PROXY_TIMEOUT_SECONDS if method == "POST" and path == "/internal/v1/sessions" else 5
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                status = response.status
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            status = exc.code
            try:
                result = json.loads(exc.read().decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                result = {"error": "invalid response from SSH session daemon"}
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
            raise BridgeError("SSH session daemon is unavailable") from exc
        if not isinstance(result, dict):
            raise BridgeError("SSH session daemon returned an invalid response")
        return status, result

    def revoke(self, grant_id: str) -> dict[str, Any]:
        return self._post("/api/v1/revoke", {"grant_id": grant_id})


def _safe_name(value: Any, field: str) -> str:
    if not isinstance(value, str) or not NAME_RE.fullmatch(value):
        raise BridgeError(f"{field} contains unsupported characters")
    return value


def _safe_path(value: Any, field: str) -> str:
    if not isinstance(value, str) or any(char in value for char in ("\x00", "\n", "\r", "\t")):
        raise BridgeError(f"{field} must be an absolute POSIX path")
    path = PurePosixPath(value)
    if not path.is_absolute() or value == "/" or ".." in path.parts:
        raise BridgeError(f"{field} must be an absolute POSIX path other than /")
    return value.rstrip("/")


def _safe_relative(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or any(char in value for char in ("\x00", "\n", "\r", "\t", "\\")):
        raise BridgeError(f"{field} must be a relative POSIX path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or any(part in {"", "."} for part in path.parts):
        raise BridgeError(f"{field} must be a relative POSIX path")
    return path.as_posix()


def _bounded_int(value: Any, field: str, low: int, high: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise BridgeError(f"{field} must be an integer between {low} and {high}")
    return value


def _validate_url(value: Any, field: str) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise BridgeError(f"{field} must be an HTTPS URL")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise BridgeError(f"{field} must be an HTTPS URL without credentials or fragments")
    return value


def _is_sensitive_path(path: str) -> bool:
    for part in PurePosixPath(path).parts:
        lowered = part.lower()
        if lowered in SENSITIVE_SEGMENTS or lowered.startswith(".env") or lowered.endswith(SENSITIVE_SUFFIXES):
            return True
    return False


def _session_request(data: Any) -> dict[str, Any]:
    required = {"protocol", "host", "port", "username"}
    allowed = required | {"password", "auth_method", "workdir"}
    if not isinstance(data, dict) or not required.issubset(data) or set(data) - allowed:
        raise BridgeError("connection requires protocol, host, port, username, and authentication")
    if data["protocol"] != "ssh":
        raise BridgeError("only SSH is supported")
    host = data["host"]
    if not isinstance(host, str) or not TARGET_RE.fullmatch(host) or host.startswith("-"):
        raise BridgeError("host is not a valid SSH host or address")
    port = _bounded_int(data["port"], "port", 1, 65535)
    username = _safe_name(data["username"], "username")
    password = data.get("password")
    auth_method = data.get("auth_method", "password" if password else "key")
    if auth_method not in {"password", "key"}:
        raise BridgeError("auth_method must be password or key")
    if auth_method == "password":
        if not isinstance(password, str) or not 1 <= len(password) <= 4096:
            raise BridgeError("password must be provided for password authentication")
    else:
        password = None
    workdir = data.get("workdir")
    if workdir is not None:
        workdir = _safe_path(workdir, "workdir")
        if _is_sensitive_path(workdir):
            raise BridgeError("workdir may not target sensitive directories")
    return {"host": host, "port": port, "username": username, "password": password, "auth_method": auth_method, "workdir": workdir}


def _command_request(data: Any) -> dict[str, Any]:
    allowed = {"command", "terminal_id", "timeout_seconds", "new_terminal"}
    if not isinstance(data, dict) or "command" not in data or set(data) - allowed:
        raise BridgeError("command request requires command and optional terminal_id, timeout_seconds, or new_terminal")
    command = data["command"]
    if not isinstance(command, str) or not command.strip() or len(command) > MAX_COMMAND_CHARS:
        raise BridgeError(f"command must contain between 1 and {MAX_COMMAND_CHARS} characters")
    if "\x00" in command or "\r" in command:
        raise BridgeError("command contains unsupported control characters")
    terminal_id = data.get("terminal_id")
    if terminal_id is not None and (not isinstance(terminal_id, str) or not re.fullmatch(r"term-[A-Za-z0-9_-]{8,40}", terminal_id)):
        raise BridgeError("terminal_id is invalid")
    timeout_seconds = _bounded_int(data.get("timeout_seconds", DEFAULT_COMMAND_TIMEOUT_SECONDS), "timeout_seconds", 1, MAX_COMMAND_TIMEOUT_SECONDS)
    new_terminal = data.get("new_terminal", False)
    if not isinstance(new_terminal, bool):
        raise BridgeError("new_terminal must be a boolean")
    return {"command": command, "terminal_id": terminal_id, "timeout_seconds": timeout_seconds, "new_terminal": new_terminal}


def validate_config(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict) or set(data) - TOP_KEYS:
        raise BridgeError("bridge config has unsupported fields")
    if data.get("version") != 1:
        raise BridgeError("bridge config version must be 1")
    hosts = data.get("hosts")
    if not isinstance(hosts, list) or not 0 <= len(hosts) <= 16:
        raise BridgeError("hosts must contain at most 16 entries")
    ssh_config = data.get("ssh_config")
    if ssh_config is not None:
        if not isinstance(ssh_config, str) or any(char in ssh_config for char in ("\x00", "\n", "\r")):
            raise BridgeError("ssh_config must be a local path string")
        ssh_config = str(Path(ssh_config).expanduser())
    safe_hosts = []
    names: set[str] = set()
    targets: set[str] = set()
    for index, raw_host in enumerate(hosts):
        if not isinstance(raw_host, dict) or set(raw_host) - HOST_KEYS:
            raise BridgeError(f"hosts[{index}] has unsupported fields")
        name = _safe_name(raw_host.get("name"), f"hosts[{index}].name")
        target = raw_host.get("target")
        if not isinstance(target, str) or not TARGET_RE.fullmatch(target) or target.startswith("-"):
            raise BridgeError(f"hosts[{index}].target is not a valid SSH target")
        if name in names or target in targets:
            raise BridgeError("host names and SSH targets must be unique")
        names.add(name)
        targets.add(target)
        logs = raw_host.get("logs", [])
        if not isinstance(logs, list) or len(logs) > 8:
            raise BridgeError(f"hosts[{index}].logs must have at most 8 entries")
        safe_logs = []
        seen_logs = set()
        for log_index, raw_log in enumerate(logs):
            if not isinstance(raw_log, dict) or set(raw_log) - LOG_KEYS:
                raise BridgeError(f"hosts[{index}].logs[{log_index}] has unsupported fields")
            log_name = _safe_name(raw_log.get("name"), f"hosts[{index}].logs[{log_index}].name")
            if log_name in seen_logs:
                raise BridgeError("log names must be unique per host")
            seen_logs.add(log_name)
            safe_logs.append({
                "name": log_name,
                "path": _safe_path(raw_log.get("path"), f"hosts[{index}].logs[{log_index}].path"),
                "max_lines": _bounded_int(raw_log.get("max_lines", 200), f"hosts[{index}].logs[{log_index}].max_lines", 1, 200),
            })
        artifacts = raw_host.get("artifacts", [])
        if not isinstance(artifacts, list) or len(artifacts) > 16:
            raise BridgeError(f"hosts[{index}].artifacts must have at most 16 entries")
        artifact_root = raw_host.get("artifact_root")
        if artifacts and artifact_root is None:
            raise BridgeError(f"hosts[{index}].artifact_root is required when artifacts are configured")
        safe_artifacts = []
        seen_artifacts = set()
        for artifact_index, raw_artifact in enumerate(artifacts):
            if not isinstance(raw_artifact, dict) or set(raw_artifact) - ARTIFACT_KEYS:
                raise BridgeError(f"hosts[{index}].artifacts[{artifact_index}] has unsupported fields")
            artifact_name = _safe_name(raw_artifact.get("name"), f"hosts[{index}].artifacts[{artifact_index}].name")
            if artifact_name in seen_artifacts:
                raise BridgeError("artifact names must be unique per host")
            seen_artifacts.add(artifact_name)
            digest = raw_artifact.get("sha256")
            if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
                raise BridgeError("artifact sha256 must be lowercase SHA-256")
            safe_artifacts.append({
                "name": artifact_name,
                "url": _validate_url(raw_artifact.get("url"), f"hosts[{index}].artifacts[{artifact_index}].url"),
                "sha256": digest,
                "destination": _safe_relative(raw_artifact.get("destination"), f"hosts[{index}].artifacts[{artifact_index}].destination"),
                "max_bytes": _bounded_int(raw_artifact.get("max_bytes"), f"hosts[{index}].artifacts[{artifact_index}].max_bytes", 1, 2 * 1024 * 1024 * 1024),
            })
        safe_host = {
            "name": name,
            "target": target,
            "workdir": _safe_path(raw_host.get("workdir"), f"hosts[{index}].workdir"),
            "logs": safe_logs,
            "artifacts": safe_artifacts,
        }
        if artifact_root is not None:
            safe_host["artifact_root"] = _safe_path(artifact_root, f"hosts[{index}].artifact_root")
        safe_hosts.append(safe_host)
    result = {
        "version": 1,
        "connect_timeout": _bounded_int(data.get("connect_timeout", 10), "connect_timeout", 1, 30),
        "command_timeout": _bounded_int(data.get("command_timeout", 45), "command_timeout", 5, 120),
        "hosts": safe_hosts,
    }
    if ssh_config:
        result["ssh_config"] = ssh_config
    return result


def load_config(path: Path) -> dict[str, Any]:
    with path.expanduser().open("r", encoding="utf-8") as stream:
        return validate_config(json.load(stream))


def _ssh_base(config: dict[str, Any], host: dict[str, Any], *, executable: str = "ssh") -> list[str]:
    command = [
        executable, "-T", "-o", "BatchMode=yes", "-o", f"ConnectTimeout={config['connect_timeout']}",
        "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-o", "LogLevel=ERROR",
    ]
    if config.get("ssh_config"):
        ssh_config = Path(config["ssh_config"])
        if not ssh_config.is_file():
            raise BridgeError(f"SSH config does not exist: {ssh_config}")
        command.extend(("-F", str(ssh_config)))
    command.extend(("--", host["target"]))
    return command


def _run_ssh(config: dict[str, Any], host: dict[str, Any], remote_command: str, script: str | None = None) -> str:
    executable = shutil.which("ssh")
    if not executable:
        raise BridgeError("OpenSSH client not found on PATH")
    command = _ssh_base(config, host, executable=executable)
    command.append(remote_command)
    try:
        completed = subprocess.run(
            command, input=script, text=True, encoding="utf-8", errors="replace",
            capture_output=True, timeout=config["command_timeout"], check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BridgeError(f"SSH operation failed: {str(exc)[:500]}") from exc
    if completed.returncode != 0:
        raise BridgeError((completed.stderr.strip() or "SSH operation failed")[:500])
    return completed.stdout


def _scp_command(config: dict[str, Any], host: dict[str, Any], source: Path, destination: str) -> list[str]:
    executable = shutil.which("scp")
    if not executable:
        raise BridgeError("OpenSSH scp client not found on PATH")
    command = [
        executable, "-q", "-o", "BatchMode=yes", "-o", f"ConnectTimeout={config['connect_timeout']}",
        "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-o", "LogLevel=ERROR",
    ]
    if config.get("ssh_config"):
        ssh_config = Path(config["ssh_config"])
        if not ssh_config.is_file():
            raise BridgeError(f"SSH config does not exist: {ssh_config}")
        command.extend(("-F", str(ssh_config)))
    command.extend((str(source), f"{host['target']}:{shlex.quote(destination)}"))
    return command


def _parse_disk(value: str) -> dict[str, int | str] | str:
    fields = value.split("|")
    if len(fields) != 4:
        return value
    try:
        return {"total_kib": int(fields[0]), "used_kib": int(fields[1]), "available_kib": int(fields[2]), "used_percent": fields[3]}
    except ValueError:
        return value


def collect_status(config: dict[str, Any], host: dict[str, Any]) -> dict[str, Any]:
    command = "sh -s -- " + shlex.quote(host["workdir"])
    stdout = _run_ssh(config, host, command, STATUS_SCRIPT)
    result: dict[str, Any] = {"host": host["name"], "target": host["target"], "gpus": [], "collected_at": int(time.time())}
    for line in stdout.splitlines():
        fields = line.split("\t", 2)
        if len(fields) != 3 or fields[0] != "RCB":
            continue
        _, key, value = fields
        if key == "gpu":
            values = [item.strip() for item in value.split(",")]
            if len(values) == 6:
                result["gpus"].append({"index": values[0], "name": values[1], "memory_used_mib": values[2], "memory_total_mib": values[3], "utilization_percent": values[4], "temperature_c": values[5]})
        elif key == "uptime_seconds":
            try:
                result[key] = int(value)
            except ValueError:
                result[key] = value
        elif key == "workdir_exists":
            result[key] = value == "true"
        elif key == "root_disk":
            result[key] = _parse_disk(value)
        else:
            result[key] = value
    if "hostname" not in result:
        raise BridgeError("remote status command returned no recognized records")
    return result


def read_log(config: dict[str, Any], host: dict[str, Any], log: dict[str, Any], lines: int) -> dict[str, Any]:
    allowed = min(lines, log["max_lines"])
    path = shlex.quote(log["path"])
    script = f"if [ ! -f {path} ] || [ ! -r {path} ]; then exit 3; fi; tail -n {allowed} -- {path} | tail -c 65536"
    command = "sh -c " + shlex.quote(script)
    content = _run_ssh(config, host, command)
    return {"host": host["name"], "name": log["name"], "lines": allowed, "content": redact(content), "truncated": len(content.encode("utf-8", errors="replace")) >= 65536}


SECRET_RE = re.compile(r"(?i)\b([A-Za-z0-9_]*(?:token|password|passwd|secret|api[_-]?key)[A-Za-z0-9_]*)\b(\s*[:=]\s*)([^\s,;]+)")
BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*")


def redact(value: str) -> str:
    value = SECRET_RE.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", value)
    return BEARER_RE.sub("Bearer [REDACTED]", value)


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self, req: urllib.request.Request, fp: Any, code: int, msg: str, headers: Any, newurl: str
    ) -> urllib.request.Request:
        raise BridgeError("artifact redirects are not allowed")


def _open_artifact(url: str) -> Any:
    return urllib.request.build_opener(_RejectRedirects()).open(url, timeout=30)


def _download_artifact(artifact: dict[str, Any]) -> Path:
    digest = hashlib.sha256()
    temporary = tempfile.NamedTemporaryFile(prefix="remote-control-bridge-", delete=False)
    path = Path(temporary.name)
    try:
        with _open_artifact(artifact["url"]) as response:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                if temporary.tell() + len(chunk) > artifact["max_bytes"]:
                    raise BridgeError("artifact exceeds configured max_bytes")
                temporary.write(chunk)
                digest.update(chunk)
        temporary.close()
        if digest.hexdigest() != artifact["sha256"]:
            raise BridgeError("artifact SHA-256 does not match configured value")
        return path
    except BaseException:
        temporary.close()
        path.unlink(missing_ok=True)
        raise


def stage_artifact(config: dict[str, Any], host: dict[str, Any], artifact: dict[str, Any]) -> dict[str, Any]:
    local_path = _download_artifact(artifact)
    remote_path = host["artifact_root"] + "/" + artifact["destination"]
    try:
        command = _scp_command(config, host, local_path, remote_path)
        completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=config["command_timeout"], check=False)
        if completed.returncode != 0:
            raise BridgeError((completed.stderr.strip() or "artifact transfer failed")[:500])
        return {"host": host["name"], "artifact": artifact["name"], "destination": remote_path, "sha256": artifact["sha256"], "staged": True}
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BridgeError(f"artifact transfer failed: {str(exc)[:500]}") from exc
    finally:
        local_path.unlink(missing_ok=True)


@dataclass
class CommandJob:
    job_id: str
    terminal_id: str
    command: str
    timeout_seconds: int
    status: str = "queued"
    submitted_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    result: dict[str, Any] | None = None
    stdout: str = ""
    stderr: str = ""
    truncated: bool = False
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)
    event_condition: threading.Condition = field(default_factory=threading.Condition, repr=False)
    events: list[dict[str, Any]] = field(default_factory=list, repr=False)
    next_event_id: int = 1


@dataclass
class TerminalSlot:
    terminal_id: str
    index: int
    busy: bool = False
    current_job_id: str | None = None
    job_ids: list[str] = field(default_factory=list)


@dataclass
class LiveSession:
    client: Any
    host: str
    port: int
    username: str
    workdir: str | None
    fingerprint: str = ""
    backend: str = "paramiko"
    opened_at: float = field(default_factory=time.monotonic)
    agent_enabled: bool = False
    control_grant_id: str | None = None
    terminals: dict[str, TerminalSlot] = field(default_factory=dict, repr=False)
    jobs: dict[str, CommandJob] = field(default_factory=dict, repr=False)
    terminal_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


class BridgeState:
    def __init__(
        self, config: dict[str, Any], control_url: str | None = None,
        control_key_file: Path | None = None, session_url: str | None = None,
        session_key_file: Path | None = None,
    ):
        self.config = config
        self.control = ControlClient(control_url, control_key_file)
        self.sessiond = SessionDaemonClient(session_url, session_key_file)
        self.sessions: dict[str, LiveSession] = {}
        self.session_lock = threading.Lock()
        self.host_keys_path = Path(__file__).with_name("data") / "known_hosts"
        self.pending_host_keys: dict[str, tuple[float, str, int, Any]] = {}
        self.remote_versions: dict[tuple[str, int], str] = {}
        self.async_loop: asyncio.AbstractEventLoop | None = None
        self.async_loop_lock = threading.Lock()
        self.active_jobs = 0
        self.active_jobs_lock = threading.Lock()

    def host(self, name: str) -> dict[str, Any]:
        for host in self.config["hosts"]:
            if host["name"] == name:
                return host
        raise KeyError("unknown configured host")

    @staticmethod
    def log(host: dict[str, Any], name: str) -> dict[str, Any]:
        for log in host["logs"]:
            if log["name"] == name:
                return log
        raise KeyError("unknown configured log")

    @staticmethod
    def artifact(host: dict[str, Any], name: str) -> dict[str, Any]:
        for artifact in host["artifacts"]:
            if artifact["name"] == name:
                return artifact
        raise KeyError("unknown configured artifact")

    def public_hosts(self) -> list[dict[str, Any]]:
        return [{"name": host["name"], "target": host["target"], "workdir": host["workdir"], "logs": [item["name"] for item in host["logs"]], "artifacts": [item["name"] for item in host["artifacts"]]} for host in self.config["hosts"]]

    @staticmethod
    def _session_active(session: LiveSession) -> bool:
        try:
            if session.backend == "asyncssh":
                return not session.client.is_closed()
            transport = session.client.get_transport()
            return transport is not None and bool(transport.is_active())
        except (AttributeError, OSError):
            return False

    def _cleanup_disconnected_sessions(self) -> None:
        disconnected = [token for token, session in self.sessions.items() if not self._session_active(session)]
        for token in disconnected:
            self._close_client(self.sessions.pop(token))

    def _ensure_async_loop(self) -> asyncio.AbstractEventLoop:
        with self.async_loop_lock:
            if self.async_loop is not None:
                return self.async_loop
            loop = asyncio.new_event_loop()
            ready = threading.Event()

            def run() -> None:
                asyncio.set_event_loop(loop)
                ready.set()
                loop.run_forever()

            threading.Thread(target=run, name="bridge-asyncssh", daemon=True).start()
            ready.wait()
            self.async_loop = loop
            return loop

    def run_async(self, awaitable: Any, timeout: float) -> Any:
        async def wait_for_result() -> Any:
            return await awaitable

        future = asyncio.run_coroutine_threadsafe(wait_for_result(), self._ensure_async_loop())
        try:
            return future.result(timeout=timeout)
        except concurrent.futures.TimeoutError as exc:
            future.cancel()
            raise BridgeError("SSH operation timed out") from exc

    def _close_client(self, session: LiveSession) -> None:
        if session.backend == "asyncssh" and self.async_loop is not None:
            self.async_loop.call_soon_threadsafe(session.client.close)
        else:
            session.client.close()

    @staticmethod
    def _host_key_name(host: str, port: int) -> str:
        return host if port == 22 else f"[{host}]:{port}"

    def _host_keys(self) -> Any:
        keys = paramiko.HostKeys()
        if self.host_keys_path.is_file():
            keys.load(str(self.host_keys_path))
        return keys

    def _probe_host_key(self, host: str, port: int) -> Any:
        transport = None
        try:
            transport = paramiko.Transport((host, port))
            transport.start_client(timeout=self.config["connect_timeout"])
            self.remote_versions[(host, port)] = transport.remote_version or ""
            return transport.get_remote_server_key()
        except (paramiko.SSHException, OSError) as exc:
            raise BridgeError("SSH connection failed; verify the host, port, and network") from exc
        finally:
            if transport is not None:
                transport.close()

    @staticmethod
    def _fingerprint(key: Any) -> str:
        digest = hashlib.sha256(key.asbytes()).digest()
        return "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")

    def _require_trusted_host_key(self, host: str, port: int) -> str:
        key = self._probe_host_key(host, port)
        key_name = self._host_key_name(host, port)
        keys = self._host_keys()
        trusted = keys.lookup(key_name)
        if trusted is not None and key.get_name() in trusted:
            if trusted[key.get_name()].asbytes() == key.asbytes():
                return self._fingerprint(key)
            raise BridgeError("SSH host key changed; verify the server fingerprint before reconnecting")
        token = secrets.token_urlsafe(24)
        with self.session_lock:
            self.pending_host_keys = {
                item: value for item, value in self.pending_host_keys.items() if value[0] > time.monotonic()
            }
            self.pending_host_keys[token] = (time.monotonic() + 120, host, port, key)
        raise HostTrustRequired(token, host, port, key.get_name(), self._fingerprint(key))

    def trust_host_key(self, token: str) -> dict[str, Any]:
        with self.session_lock:
            pending = self.pending_host_keys.pop(token, None)
        if pending is None or pending[0] <= time.monotonic():
            raise KeyError("host key confirmation expired")
        _, host, port, key = pending
        keys = self._host_keys()
        keys.add(self._host_key_name(host, port), key.get_name(), key)
        self.host_keys_path.parent.mkdir(parents=True, exist_ok=True)
        keys.save(str(self.host_keys_path))
        return {"trusted": True, "host": host, "port": port, "key_type": key.get_name(), "fingerprint": self._fingerprint(key)}

    def _connect_asyncssh(self, request: dict[str, Any]) -> Any:
        key_auth = request["auth_method"] == "key"
        if key_auth and not DEFAULT_SSH_KEY_PATH.is_file():
            raise BridgeError("default SSH private key is unavailable")
        return self.run_async(
            asyncssh.connect(
                request["host"], port=request["port"], username=request["username"], password=request["password"],
                known_hosts=str(self.host_keys_path), client_keys=[str(DEFAULT_SSH_KEY_PATH)] if key_auth else [], agent_path=None,
                public_key_auth=key_auth, password_auth=not key_auth, kbdint_auth=False,
                preferred_auth=("publickey",) if key_auth else ("password",), connect_timeout=self.config["connect_timeout"],
                login_timeout=AUTH_TIMEOUT_SECONDS, keepalive_interval=SSH_KEEPALIVE_INTERVAL_SECONDS,
                keepalive_count_max=SSH_KEEPALIVE_COUNT_MAX,
            ),
            AUTH_TIMEOUT_SECONDS + self.config["connect_timeout"] + 5,
        )

    def open_session(self, request: dict[str, Any]) -> tuple[str, LiveSession]:
        if paramiko is None:
            raise BridgeError("Paramiko is unavailable; install the bridge local dependencies")
        fingerprint = self._require_trusted_host_key(request["host"], request["port"])
        client = paramiko.SSHClient()
        client.load_host_keys(str(self.host_keys_path))
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
        backend = "paramiko"
        prefer_asyncssh = asyncssh is not None and "OpenSSH_7.6" in self.remote_versions.get((request["host"], request["port"]), "")
        try:
            if prefer_asyncssh:
                client.close()
                try:
                    client = self._connect_asyncssh(request)
                    backend = "asyncssh"
                except asyncssh.PermissionDenied as exc:
                    raise BridgeError("SSH authentication failed") from exc
                except asyncssh.HostKeyNotVerifiable as exc:
                    raise BridgeError("SSH host key changed or could not be verified") from exc
                except (asyncssh.Error, OSError, BridgeError) as exc:
                    detail = redact(str(exc)).strip() or type(exc).__name__
                    raise BridgeError(f"SSH compatibility connection failed: {type(exc).__name__}: {detail[:240]}") from exc
            else:
                if request["auth_method"] == "key" and not DEFAULT_SSH_KEY_PATH.is_file():
                    raise BridgeError("default SSH private key is unavailable")
                client.connect(
                    hostname=request["host"], port=request["port"], username=request["username"], password=request["password"],
                    key_filename=str(DEFAULT_SSH_KEY_PATH) if request["auth_method"] == "key" else None,
                    look_for_keys=False, allow_agent=False, timeout=self.config["connect_timeout"],
                    banner_timeout=self.config["connect_timeout"], auth_timeout=AUTH_TIMEOUT_SECONDS,
                )
                transport = client.get_transport()
                if transport is None or not transport.is_active():
                    client.close()
                    raise BridgeError("SSH connection closed before session initialization")
                transport.set_keepalive(SSH_KEEPALIVE_INTERVAL_SECONDS)
        except paramiko.BadHostKeyException as exc:
            client.close()
            raise BridgeError("SSH host key changed; verify the server fingerprint before reconnecting") from exc
        except paramiko.AuthenticationException as exc:
            client.close()
            if asyncssh is None:
                raise BridgeError("SSH authentication failed") from exc
            try:
                client = self._connect_asyncssh(request)
                backend = "asyncssh"
            except asyncssh.PermissionDenied as fallback_exc:
                raise BridgeError("SSH authentication failed with both Paramiko and AsyncSSH") from fallback_exc
            except asyncssh.HostKeyNotVerifiable as fallback_exc:
                raise BridgeError("SSH host key changed or could not be verified") from fallback_exc
            except (asyncssh.Error, OSError, BridgeError) as fallback_exc:
                detail = redact(str(fallback_exc)).strip() or type(fallback_exc).__name__
                raise BridgeError(f"SSH compatibility fallback failed: {type(fallback_exc).__name__}: {detail[:240]}") from fallback_exc
        except (paramiko.SSHException, OSError) as exc:
            client.close()
            raise BridgeError("SSH connection failed; verify the host, port, network, and known host key") from exc
        token = secrets.token_urlsafe(32)
        session = LiveSession(
            client=client, host=request["host"], port=request["port"], username=request["username"],
            fingerprint=fingerprint, workdir=request["workdir"], backend=backend,
        )
        if self.control.enabled:
            binding = {"host": session.host, "port": session.port, "username": session.username, "fingerprint": session.fingerprint}
            auth = self.control.authorize(binding)
            session.agent_enabled = bool(auth.get("authorized"))
            grant = auth.get("grant") or {}
            session.control_grant_id = grant.get("grant_id") if isinstance(grant, dict) else None
        with self.session_lock:
            self._cleanup_disconnected_sessions()
            self.sessions[token] = session
        return token, session

    def session(self, token: str) -> LiveSession:
        with self.session_lock:
            self._cleanup_disconnected_sessions()
            session = self.sessions.get(token)
            if session is None:
                raise KeyError("unknown or disconnected session")
            return session

    def set_agent_enabled(self, token: str, enabled: bool) -> LiveSession:
        if not isinstance(enabled, bool):
            raise BridgeError("agent enabled must be a boolean")
        session = self.session(token)
        if self.control.enabled:
            binding = {"host": session.host, "port": session.port, "username": session.username, "fingerprint": session.fingerprint}
            if enabled:
                grant = self.control.grant(binding, ["status:read", "jobs:read", "jobs:execute", "jobs:cancel"], 86400)
                session.control_grant_id = grant.get("grant_id")
            elif session.control_grant_id:
                try:
                    self.control.revoke(session.control_grant_id)
                finally:
                    session.control_grant_id = None
            session.agent_enabled = enabled
            return session
        with self.session_lock:
            session.agent_enabled = enabled
        return session

    def agent_session(self) -> tuple[str, LiveSession]:
        with self.session_lock:
            self._cleanup_disconnected_sessions()
            enabled = [(token, session) for token, session in self.sessions.items() if session.agent_enabled]
            if self.control.enabled:
                enabled = []
                for token, session in self.sessions.items():
                    binding = {"host": session.host, "port": session.port, "username": session.username, "fingerprint": session.fingerprint}
                    try:
                        auth = self.control.authorize(binding)
                        authorized = auth.get("authorized", False)
                    except BridgeError:
                        auth = {}
                        authorized = False
                    session.agent_enabled = bool(authorized)
                    grant = auth.get("grant") if authorized else None
                    session.control_grant_id = grant.get("grant_id") if isinstance(grant, dict) else session.control_grant_id
                    if authorized:
                        enabled.append((token, session))
            if not enabled:
                raise KeyError("no session is authorized for the local agent")
            token, session = max(enabled, key=lambda item: item[1].opened_at)
            return token, session

    def close_session(self, token: str) -> None:
        with self.session_lock:
            session = self.sessions.pop(token, None)
        if session is None:
            raise KeyError("unknown or disconnected session")
        self._close_client(session)

    def close_all_sessions(self) -> None:
        with self.session_lock:
            sessions = list(self.sessions.values())
            self.sessions.clear()
        for session in sessions:
            self._close_client(session)


def _truncate_output(value: str) -> tuple[str, bool]:
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) <= MAX_COMMAND_OUTPUT_BYTES:
        return value, False
    return encoded[:MAX_COMMAND_OUTPUT_BYTES].decode("utf-8", errors="replace"), True


def _publish_job_event(job: CommandJob, event_type: str, data: Any) -> None:
    with job.event_condition:
        event = {"id": job.next_event_id, "type": event_type, "data": data}
        job.next_event_id += 1
        job.events.append(event)
        if len(job.events) > MAX_JOB_EVENTS:
            del job.events[:len(job.events) - MAX_JOB_EVENTS]
        job.event_condition.notify_all()


def _set_job_status(job: CommandJob, status: str) -> None:
    job.status = status
    _publish_job_event(job, "status", {"status": status})


def _append_job_output(job: CommandJob, stream: str, chunk: str) -> None:
    current = getattr(job, stream)
    encoded = (current + chunk).encode("utf-8", errors="replace")
    if len(encoded) > MAX_COMMAND_OUTPUT_BYTES:
        encoded = encoded[-MAX_COMMAND_OUTPUT_BYTES:]
        job.truncated = True
    setattr(job, stream, encoded.decode("utf-8", errors="replace"))
    _publish_job_event(job, stream, {"chunk": chunk})


def _run_paramiko_job(session: LiveSession, command: str, job: CommandJob) -> int:
    stdin, stdout, _ = session.client.exec_command(command, timeout=job.timeout_seconds)
    stdin.close()
    channel = stdout.channel
    started = time.monotonic()
    while True:
        if job.cancel_event.is_set():
            channel.close()
            raise JobCancelled()
        if time.monotonic() - started >= job.timeout_seconds:
            channel.close()
            raise JobTimedOut()
        received = False
        while channel.recv_ready():
            chunk = channel.recv(16384)
            if not chunk:
                break
            received = True
            _append_job_output(job, "stdout", chunk.decode("utf-8", errors="replace"))
        while channel.recv_stderr_ready():
            chunk = channel.recv_stderr(16384)
            if not chunk:
                break
            received = True
            _append_job_output(job, "stderr", chunk.decode("utf-8", errors="replace"))
        if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
            return channel.recv_exit_status()
        if not received:
            time.sleep(0.02)


async def _run_asyncssh_job(session: LiveSession, command: str, job: CommandJob) -> int:
    process = await session.client.create_process(command, encoding="utf-8", errors="replace")

    async def drain(reader: Any, stream: str) -> None:
        while True:
            chunk = await reader.read(16384)
            if not chunk:
                return
            _append_job_output(job, stream, chunk)

    stdout_task = asyncio.create_task(drain(process.stdout, "stdout"))
    stderr_task = asyncio.create_task(drain(process.stderr, "stderr"))
    wait_task = asyncio.create_task(process.wait())
    started = time.monotonic()
    try:
        while not wait_task.done():
            if job.cancel_event.is_set():
                process.terminate()
                try:
                    await asyncio.wait_for(asyncio.shield(wait_task), timeout=2)
                except TimeoutError:
                    process.kill()
                raise JobCancelled()
            if time.monotonic() - started >= job.timeout_seconds:
                process.terminate()
                try:
                    await asyncio.wait_for(asyncio.shield(wait_task), timeout=2)
                except TimeoutError:
                    process.kill()
                raise JobTimedOut()
            await asyncio.sleep(0.05)
        await wait_task
        await asyncio.gather(stdout_task, stderr_task)
        return process.exit_status
    finally:
        if not stdout_task.done():
            stdout_task.cancel()
        if not stderr_task.done():
            stderr_task.cancel()


def _execute_command_job(state: BridgeState, token: str, job: CommandJob) -> dict[str, Any]:
    session = state.session(token)
    started = time.monotonic()
    command = "sh -lc " + shlex.quote(job.command)
    if session.backend == "asyncssh":
        exit_status = state.run_async(_run_asyncssh_job(session, command, job), job.timeout_seconds + 5)
    else:
        exit_status = _run_paramiko_job(session, command, job)
    return {
        "exit_status": exit_status, "stdout": job.stdout, "stderr": job.stderr,
        "truncated": job.truncated, "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _run_session_command_result(state: BridgeState, token: str, command: str, script: str | None = None, timeout_seconds: int | None = None) -> dict[str, Any]:
    session = state.session(token)
    started = time.monotonic()
    timeout = timeout_seconds or state.config["command_timeout"]
    try:
        if session.backend == "asyncssh":
            result = state.run_async(
                session.client.run(command, input=script, check=False, timeout=timeout, encoding="utf-8", errors="replace"),
                timeout + 2,
            )
            output, stdout_truncated = _truncate_output(result.stdout or "")
            error, stderr_truncated = _truncate_output(result.stderr or "")
            return {"exit_status": result.exit_status, "stdout": output, "stderr": error, "truncated": stdout_truncated or stderr_truncated, "duration_ms": round((time.monotonic() - started) * 1000)}
        stdin, stdout, stderr = session.client.exec_command(command, timeout=timeout)
        if script is not None:
            stdin.write(script)
            stdin.flush()
            stdin.channel.shutdown_write()
        output, stdout_truncated = _truncate_output(stdout.read().decode("utf-8", errors="replace"))
        error, stderr_truncated = _truncate_output(stderr.read().decode("utf-8", errors="replace"))
        return {"exit_status": stdout.channel.recv_exit_status(), "stdout": output, "stderr": error, "truncated": stdout_truncated or stderr_truncated, "duration_ms": round((time.monotonic() - started) * 1000)}
    except (OSError, EOFError, BridgeError):
        raise
    except Exception as exc:
        raise BridgeError("remote operation failed") from exc


def _run_session_command(state: BridgeState, token: str, command: str, script: str | None = None) -> str:
    result = _run_session_command_result(state, token, command, script)
    if result["exit_status"] != 0:
        raise BridgeError(redact(result["stderr"].strip() or "remote operation failed")[:500])
    return result["stdout"]


def _job_snapshot(job: CommandJob, include_output: bool = True) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "job_id": job.job_id, "terminal_id": job.terminal_id, "command": job.command,
        "timeout_seconds": job.timeout_seconds, "status": job.status, "submitted_at": job.submitted_at,
        "started_at": job.started_at, "finished_at": job.finished_at,
    }
    if include_output and job.result is not None:
        payload.update(job.result)
    elif include_output:
        payload.update({"exit_status": None, "stdout": job.stdout, "stderr": job.stderr, "truncated": job.truncated, "duration_ms": None})
    return payload


def list_session_terminals(state: BridgeState, token: str) -> dict[str, Any]:
    session = state.session(token)
    with session.terminal_lock:
        terminals = []
        for terminal in sorted(session.terminals.values(), key=lambda item: item.index):
            terminals.append({
                "terminal_id": terminal.terminal_id, "index": terminal.index, "busy": terminal.busy,
                "current_job_id": terminal.current_job_id,
                "jobs": [_job_snapshot(session.jobs[job_id], include_output=False) for job_id in terminal.job_ids[-20:]],
            })
        return {"max_terminals": MAX_TERMINALS_PER_SESSION, "terminals": terminals}


def get_session_job(state: BridgeState, token: str, job_id: str) -> dict[str, Any]:
    session = state.session(token)
    with session.terminal_lock:
        job = session.jobs.get(job_id)
        if job is None:
            raise KeyError("unknown command job")
        return _job_snapshot(job)


def session_job(state: BridgeState, token: str, job_id: str) -> CommandJob:
    session = state.session(token)
    with session.terminal_lock:
        job = session.jobs.get(job_id)
        if job is None:
            raise KeyError("unknown command job")
        return job


def cancel_session_job(state: BridgeState, token: str, job_id: str) -> dict[str, Any]:
    job = session_job(state, token, job_id)
    if job.status not in {"queued", "running"}:
        raise ConflictError("command job is no longer running")
    job.cancel_event.set()
    _publish_job_event(job, "status", {"status": job.status, "cancellation_requested": True})
    return {"job_id": job.job_id, "status": job.status, "cancellation_requested": True}


def submit_session_command(state: BridgeState, token: str, data: Any) -> dict[str, Any]:
    request = _command_request(data)
    session = state.session(token)
    with state.active_jobs_lock:
        if state.active_jobs >= MAX_GLOBAL_ACTIVE_JOBS:
            raise ConflictError("global command concurrency limit reached")
        state.active_jobs += 1
    try:
        with session.terminal_lock:
            terminal: TerminalSlot | None = None
            requested_id = request["terminal_id"]
            if requested_id is not None and not request["new_terminal"]:
                requested = session.terminals.get(requested_id)
                if requested is None:
                    raise KeyError("unknown terminal")
                if not requested.busy:
                    terminal = requested
            if terminal is None and not request["new_terminal"]:
                terminal = next((item for item in sorted(session.terminals.values(), key=lambda item: item.index) if not item.busy), None)
            if terminal is None:
                if len(session.terminals) >= MAX_TERMINALS_PER_SESSION:
                    raise ConflictError("all terminal slots are busy; wait for a command to finish")
                terminal_id = "term-" + secrets.token_urlsafe(9)
                terminal = TerminalSlot(terminal_id=terminal_id, index=len(session.terminals) + 1)
                session.terminals[terminal_id] = terminal
            job_id = "job-" + secrets.token_urlsafe(12)
            job = CommandJob(job_id=job_id, terminal_id=terminal.terminal_id, command=request["command"], timeout_seconds=request["timeout_seconds"])
            session.jobs[job_id] = job
            terminal.busy = True
            terminal.current_job_id = job_id
            terminal.job_ids.append(job_id)
    except BaseException:
        with state.active_jobs_lock:
            state.active_jobs -= 1
        raise

    def run_job() -> None:
        job.started_at = time.time()
        _set_job_status(job, "running")
        try:
            result = _execute_command_job(state, token, job)
            status = "completed" if result["exit_status"] == 0 else "failed"
        except JobCancelled:
            result = {"exit_status": None, "stdout": job.stdout, "stderr": job.stderr, "truncated": job.truncated, "duration_ms": round((time.time() - (job.started_at or time.time())) * 1000)}
            status = "cancelled"
        except JobTimedOut:
            result = {"exit_status": None, "stdout": job.stdout, "stderr": job.stderr, "truncated": job.truncated, "duration_ms": round((time.time() - (job.started_at or time.time())) * 1000)}
            status = "timed_out"
        except Exception as exc:
            detail = redact(str(exc))[:1000]
            if detail:
                _append_job_output(job, "stderr", detail + "\n")
            result = {"exit_status": None, "stdout": job.stdout, "stderr": job.stderr, "truncated": job.truncated, "duration_ms": round((time.time() - (job.started_at or time.time())) * 1000)}
            status = "failed"
        with session.terminal_lock:
            job.result = result
            job.finished_at = time.time()
            _set_job_status(job, status)
            terminal.busy = False
            terminal.current_job_id = None
        _publish_job_event(job, "end", {"status": status, "exit_status": result["exit_status"], "duration_ms": result["duration_ms"], "truncated": result["truncated"]})
        with state.active_jobs_lock:
            state.active_jobs -= 1

    threading.Thread(target=run_job, name=f"bridge-{job_id}", daemon=True).start()
    return {"job_id": job_id, "terminal_id": terminal.terminal_id, "terminal_index": terminal.index, "status": job.status}


def collect_session_status(state: BridgeState, token: str) -> dict[str, Any]:
    session = state.session(token)
    command = "sh -s" if session.workdir is None else "sh -s -- " + shlex.quote(session.workdir)
    stdout = _run_session_command(state, token, command, STATUS_SCRIPT)
    result: dict[str, Any] = {"host": session.host, "port": session.port, "username": session.username, "gpus": [], "collected_at": int(time.time())}
    for line in stdout.splitlines():
        fields = line.split("\t", 2)
        if len(fields) != 3 or fields[0] != "RCB":
            continue
        _, key, value = fields
        if key == "gpu":
            values = [item.strip() for item in value.split(",")]
            if len(values) == 6:
                result["gpus"].append({"index": values[0], "name": values[1], "memory_used_mib": values[2], "memory_total_mib": values[3], "utilization_percent": values[4], "temperature_c": values[5]})
        elif key == "uptime_seconds":
            try:
                result[key] = int(value)
            except ValueError:
                result[key] = value
        elif key == "workdir_exists":
            result[key] = value == "true"
        elif key == "root_disk":
            result[key] = _parse_disk(value)
        else:
            result[key] = value
    if "hostname" not in result:
        raise BridgeError("remote status command returned no recognized records")
    return result


def read_session_log(state: BridgeState, token: str, path: Any, lines: Any) -> dict[str, Any]:
    safe_path = _safe_path(path, "log path")
    if _is_sensitive_path(safe_path):
        raise BridgeError("log path may not target sensitive files or directories")
    count = _bounded_int(lines, "lines", 1, 200)
    quoted = shlex.quote(safe_path)
    script = f"if [ ! -f {quoted} ] || [ ! -r {quoted} ]; then exit 3; fi; tail -n {count} -- {quoted} | tail -c 65536"
    content = _run_session_command(state, token, "sh -c " + shlex.quote(script))
    return {"path": safe_path, "lines": count, "content": redact(content), "truncated": len(content.encode("utf-8", errors="replace")) >= 65536}


class BridgeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address: tuple[str, int], state: BridgeState, assets: Path):
        super().__init__(address, BridgeHandler)
        self.state = state
        self.assets = assets
        self.allowed_authority = f"127.0.0.1:{self.server_port}"


class BridgeHandler(BaseHTTPRequestHandler):
    server: BridgeHTTPServer
    protocol_version = "HTTP/1.1"
    server_version = "RemoteControlBridge"
    sys_version = ""

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("bridge: " + format % args + "\n")

    def _headers(self, status: int, content_type: str, length: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()

    def _json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(body))
        self.wfile.write(body)

    def _job_events(self, job: CommandJob) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Connection", "close")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.close_connection = True
        raw_last_id = self.headers.get("Last-Event-ID", "")
        try:
            last_id = int(raw_last_id) if raw_last_id else 0
        except ValueError:
            last_id = 0

        def send(event_id: int | None, event_type: str, data: Any) -> None:
            lines = []
            if event_id is not None:
                lines.append(f"id: {event_id}")
            lines.append(f"event: {event_type}")
            lines.append("data: " + json.dumps(data, ensure_ascii=True, separators=(",", ":")))
            self.wfile.write(("\n".join(lines) + "\n\n").encode("utf-8"))
            self.wfile.flush()

        try:
            send(None, "snapshot", _job_snapshot(job))
            if not raw_last_id:
                with job.event_condition:
                    last_id = job.next_event_id - 1
            while True:
                with job.event_condition:
                    events = [event for event in job.events if event["id"] > last_id]
                    if not events and job.status in {"queued", "running"}:
                        job.event_condition.wait(timeout=10)
                        events = [event for event in job.events if event["id"] > last_id]
                if events:
                    for event in events:
                        send(event["id"], event["type"], event["data"])
                        last_id = event["id"]
                elif job.status in {"queued", "running"}:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                else:
                    break
                if job.status not in {"queued", "running"} and not any(event["id"] > last_id for event in job.events):
                    break
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def _sessiond_json(self, method: str, path: str, payload: dict[str, Any] | None = None) -> None:
        status, result = self.server.state.sessiond.request(method, path, payload)
        self._json(result, status)

    def _sessiond_events(self, path: str) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Connection", "close")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.close_connection = True
        raw_last_id = self.headers.get("Last-Event-ID", "")
        try:
            last_id = int(raw_last_id) if raw_last_id else 0
        except ValueError:
            last_id = 0

        def send(event_id: int | None, event_type: str, data: Any) -> None:
            lines = []
            if event_id is not None:
                lines.append(f"id: {event_id}")
            lines.append(f"event: {event_type}")
            lines.append("data: " + json.dumps(data, ensure_ascii=True, separators=(",", ":")))
            self.wfile.write(("\n".join(lines) + "\n\n").encode("utf-8"))
            self.wfile.flush()

        try:
            status_path = path.removesuffix("/events")
            status, snapshot = self.server.state.sessiond.request("GET", status_path)
            if status != HTTPStatus.OK:
                send(None, "end", snapshot)
                return
            send(None, "snapshot", snapshot)
            if not raw_last_id:
                status, initial = self.server.state.sessiond.request("GET", path + "?after=0")
                if status != HTTPStatus.OK:
                    send(None, "end", initial)
                    return
                last_id = max((event["id"] for event in initial.get("events", []) if isinstance(event.get("id"), int)), default=0)
            while True:
                status, result = self.server.state.sessiond.request("GET", path + f"?after={last_id}")
                if status != HTTPStatus.OK:
                    send(None, "end", result)
                    return
                events = result.get("events", [])
                for event in events:
                    send(event.get("id"), event.get("type", "message"), event.get("data"))
                    if isinstance(event.get("id"), int):
                        last_id = max(last_id, event["id"])
                if result.get("complete"):
                    break
                if not events:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                time.sleep(0.25)
        except (BrokenPipeError, ConnectionResetError, OSError, BridgeError):
            return

    def _is_local(self) -> tuple[bool, HTTPStatus, str]:
        hosts = self.headers.get_all("Host", [])
        if len(hosts) != 1 or hosts[0].lower() != self.server.allowed_authority:
            return False, HTTPStatus.MISDIRECTED_REQUEST, "request Host is not the bridge loopback address"
        origins = self.headers.get_all("Origin", [])
        if len(origins) > 1:
            return False, HTTPStatus.FORBIDDEN, "cross-origin browser requests are not allowed"
        if origins:
            parsed = urlsplit(origins[0])
            if parsed.scheme != "http" or parsed.netloc.lower() != self.server.allowed_authority:
                return False, HTTPStatus.FORBIDDEN, "cross-origin browser requests are not allowed"
        return True, HTTPStatus.OK, ""

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if not 1 <= length <= 131072:
            raise BridgeError("request body must be between 1 and 131072 bytes")
        data = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(data, dict):
            raise BridgeError("request body must be a JSON object")
        return data

    def do_GET(self) -> None:
        allowed, status, message = self._is_local()
        if not allowed:
            self._json({"error": message}, status)
            return
        request = urlsplit(self.path)
        if request.path == "/api/v1/health":
            self._json({"ok": True, "bind": "127.0.0.1", "mode": "temporary-ssh-sessions"})
            return
        try:
            query = parse_qs(request.query, keep_blank_values=True, strict_parsing=True)
            session_status = re.fullmatch(r"/api/v1/sessions/([A-Za-z0-9_-]{20,80})/status", request.path)
            if session_status:
                if query:
                    raise BridgeError("status does not accept query parameters")
                if self.server.state.sessiond.enabled:
                    self._sessiond_json("GET", f"/internal/v1/sessions/{session_status.group(1)}/status")
                    return
                self._json(collect_session_status(self.server.state, session_status.group(1)))
                return
            session_terminals = re.fullmatch(r"/api/v1/sessions/([A-Za-z0-9_-]{20,80})/terminals", request.path)
            if session_terminals:
                if query:
                    raise BridgeError("terminal listing does not accept query parameters")
                if self.server.state.sessiond.enabled:
                    self._sessiond_json("GET", f"/internal/v1/sessions/{session_terminals.group(1)}/terminals")
                    return
                self._json(list_session_terminals(self.server.state, session_terminals.group(1)))
                return
            session_job_match = re.fullmatch(r"/api/v1/sessions/([A-Za-z0-9_-]{20,80})/jobs/(job-[A-Za-z0-9_-]{12,60})", request.path)
            if session_job_match:
                if query:
                    raise BridgeError("job status does not accept query parameters")
                if self.server.state.sessiond.enabled:
                    self._sessiond_json("GET", f"/internal/v1/sessions/{session_job_match.group(1)}/jobs/{session_job_match.group(2)}")
                    return
                self._json(get_session_job(self.server.state, session_job_match.group(1), session_job_match.group(2)))
                return
            session_job_events = re.fullmatch(r"/api/v1/sessions/([A-Za-z0-9_-]{20,80})/jobs/(job-[A-Za-z0-9_-]{12,60})/events", request.path)
            if session_job_events:
                if query:
                    raise BridgeError("job event stream does not accept query parameters")
                if self.server.state.sessiond.enabled:
                    self._sessiond_events(f"/internal/v1/sessions/{session_job_events.group(1)}/jobs/{session_job_events.group(2)}/events")
                    return
                self._job_events(session_job(self.server.state, session_job_events.group(1), session_job_events.group(2)))
                return
            if request.path == "/api/v1/agent/session":
                if query:
                    raise BridgeError("agent session discovery does not accept query parameters")
                if self.server.state.sessiond.enabled:
                    status, result = self.server.state.sessiond.request("GET", "/internal/v1/agent/session")
                    result.pop("session", None)
                    self._json(result, status)
                    return
                _, session = self.server.state.agent_session()
                self._json({"authorized": True, "host": session.host, "port": session.port, "username": session.username, **session_connection_policy()})
                return
            if request.path == "/api/v1/agent/terminals":
                if query:
                    raise BridgeError("agent terminal listing does not accept query parameters")
                if self.server.state.sessiond.enabled:
                    self._sessiond_json("GET", "/internal/v1/agent/terminals")
                    return
                token, _ = self.server.state.agent_session()
                self._json(list_session_terminals(self.server.state, token))
                return
            agent_job_match = re.fullmatch(r"/api/v1/agent/jobs/(job-[A-Za-z0-9_-]{12,60})", request.path)
            if agent_job_match:
                if query:
                    raise BridgeError("agent job status does not accept query parameters")
                if self.server.state.sessiond.enabled:
                    self._sessiond_json("GET", f"/internal/v1/agent/jobs/{agent_job_match.group(1)}")
                    return
                token, _ = self.server.state.agent_session()
                self._json(get_session_job(self.server.state, token, agent_job_match.group(1)))
                return
            agent_job_events = re.fullmatch(r"/api/v1/agent/jobs/(job-[A-Za-z0-9_-]{12,60})/events", request.path)
            if agent_job_events:
                if query:
                    raise BridgeError("agent job event stream does not accept query parameters")
                if self.server.state.sessiond.enabled:
                    self._sessiond_events(f"/internal/v1/agent/jobs/{agent_job_events.group(1)}/events")
                    return
                token, _ = self.server.state.agent_session()
                self._job_events(session_job(self.server.state, token, agent_job_events.group(1)))
                return
            if request.path == "/api/v1/hosts":
                if query:
                    raise BridgeError("hosts does not accept query parameters")
                self._json({"hosts": self.server.state.public_hosts()})
                return
            if request.path == "/api/v1/status":
                name = _single(query, "host")
                self._json(collect_status(self.server.state.config, self.server.state.host(name)))
                return
            if request.path == "/api/v1/logs":
                host_name, log_name, raw_lines = _query_values(query, "host", "log", "lines")
                host = self.server.state.host(host_name)
                log = self.server.state.log(host, log_name)
                self._json(read_log(self.server.state.config, host, log, _bounded_int(int(raw_lines), "lines", 1, log["max_lines"])))
                return
            asset = STATIC_FILES.get(request.path)
            if not asset:
                self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                return
            body = (self.server.assets / asset).read_bytes()
            content_type = mimetypes.guess_type(asset)[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type == "application/javascript":
                content_type += "; charset=utf-8"
            self._headers(200, content_type, len(body))
            self.wfile.write(body)
        except ConflictError as exc:
            self._json({"error": str(exc)}, HTTPStatus.CONFLICT)
        except (ValueError, BridgeError) as exc:
            self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except KeyError as exc:
            self._json({"error": str(exc).strip("'\"")}, HTTPStatus.NOT_FOUND)
        except OSError as exc:
            self._json({"error": str(exc)[:500]}, HTTPStatus.BAD_GATEWAY)
        except Exception:
            self._json({"error": "internal bridge error"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:
        allowed, status, message = self._is_local()
        if not allowed:
            self._json({"error": message}, status)
            return
        path = urlsplit(self.path).path
        try:
            data = self._read_json_body()
            if path == "/api/v1/host-keys/trust":
                if set(data) != {"token"} or not isinstance(data["token"], str):
                    raise BridgeError("host key trust requires a confirmation token")
                if self.server.state.sessiond.enabled:
                    self._sessiond_json("POST", "/internal/v1/host-keys/trust", data)
                    return
                self._json(self.server.state.trust_host_key(data["token"]))
                return
            if path == "/api/v1/sessions":
                if self.server.state.sessiond.enabled:
                    self._sessiond_json("POST", "/internal/v1/sessions", data)
                    return
                token, _ = self.server.state.open_session(_session_request(data))
                try:
                    status_data = collect_session_status(self.server.state, token)
                except BaseException:
                    self.server.state.close_session(token)
                    raise
                self._json({"session": token, **session_connection_policy(), "status": status_data}, HTTPStatus.CREATED)
                return
            session_logs = re.fullmatch(r"/api/v1/sessions/([A-Za-z0-9_-]{20,80})/logs", path)
            if session_logs:
                if set(data) != {"path", "lines"}:
                    raise BridgeError("log request requires path and lines")
                if self.server.state.sessiond.enabled:
                    self._sessiond_json("POST", f"/internal/v1/sessions/{session_logs.group(1)}/logs", data)
                    return
                self._json(read_session_log(self.server.state, session_logs.group(1), data["path"], data["lines"]))
                return
            session_commands = re.fullmatch(r"/api/v1/sessions/([A-Za-z0-9_-]{20,80})/commands", path)
            if session_commands:
                if self.server.state.sessiond.enabled:
                    self._sessiond_json("POST", f"/internal/v1/sessions/{session_commands.group(1)}/commands", data)
                    return
                self._json(submit_session_command(self.server.state, session_commands.group(1), data), HTTPStatus.ACCEPTED)
                return
            session_agent = re.fullmatch(r"/api/v1/sessions/([A-Za-z0-9_-]{20,80})/agent", path)
            if session_agent:
                if set(data) != {"enabled"}:
                    raise BridgeError("agent authorization requires enabled")
                if self.server.state.sessiond.enabled:
                    self._sessiond_json("POST", f"/internal/v1/sessions/{session_agent.group(1)}/agent", data)
                    return
                session = self.server.state.set_agent_enabled(session_agent.group(1), data["enabled"])
                self._json({"agent_enabled": session.agent_enabled})
                return
            if path == "/api/v1/agent/commands":
                if self.server.state.sessiond.enabled:
                    self._sessiond_json("POST", "/internal/v1/agent/commands", data)
                    return
                token, _ = self.server.state.agent_session()
                self._json(submit_session_command(self.server.state, token, data), HTTPStatus.ACCEPTED)
                return
            if path == "/api/v1/artifacts/stage":
                if set(data) != {"host", "artifact", "confirm"} or data.get("confirm") is not True:
                    raise BridgeError("stage requires host, artifact, and confirm: true")
                host = self.server.state.host(data["host"])
                artifact = self.server.state.artifact(host, data["artifact"])
                self._json(stage_artifact(self.server.state.config, host, artifact))
                return
            self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except HostTrustRequired as exc:
            self._json({"error": str(exc), "trust_required": True, "token": exc.token, "host": exc.host, "port": exc.port, "key_type": exc.key_type, "fingerprint": exc.fingerprint}, HTTPStatus.CONFLICT)
        except ConflictError as exc:
            self._json({"error": str(exc)}, HTTPStatus.CONFLICT)
        except (ValueError, BridgeError, json.JSONDecodeError) as exc:
            self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except KeyError as exc:
            self._json({"error": str(exc).strip("'\"")}, HTTPStatus.NOT_FOUND)
        except OSError as exc:
            self._json({"error": str(exc)[:500]}, HTTPStatus.BAD_GATEWAY)
        except Exception:
            self._json({"error": "internal bridge error"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_DELETE(self) -> None:
        allowed, status, message = self._is_local()
        if not allowed:
            self._json({"error": message}, status)
            return
        path = urlsplit(self.path).path
        session_job = re.fullmatch(r"/api/v1/sessions/([A-Za-z0-9_-]{20,80})/jobs/(job-[A-Za-z0-9_-]{12,60})", path)
        agent_job = re.fullmatch(r"/api/v1/agent/jobs/(job-[A-Za-z0-9_-]{12,60})", path)
        if session_job or agent_job:
            try:
                if session_job:
                    if self.server.state.sessiond.enabled:
                        self._sessiond_json("DELETE", f"/internal/v1/sessions/{session_job.group(1)}/jobs/{session_job.group(2)}")
                        return
                    result = cancel_session_job(self.server.state, session_job.group(1), session_job.group(2))
                else:
                    if self.server.state.sessiond.enabled:
                        self._sessiond_json("DELETE", f"/internal/v1/agent/jobs/{agent_job.group(1)}")
                        return
                    token, _ = self.server.state.agent_session()
                    result = cancel_session_job(self.server.state, token, agent_job.group(1))
                self._json(result, HTTPStatus.ACCEPTED)
            except ConflictError as exc:
                self._json({"error": str(exc)}, HTTPStatus.CONFLICT)
            except KeyError as exc:
                self._json({"error": str(exc).strip("'\"")}, HTTPStatus.NOT_FOUND)
            return
        match = re.fullmatch(r"/api/v1/sessions/([A-Za-z0-9_-]{20,80})", path)
        if not match:
            self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            if self.server.state.sessiond.enabled:
                self._sessiond_json("DELETE", f"/internal/v1/sessions/{match.group(1)}")
                return
            self.server.state.close_session(match.group(1))
            self._json({"closed": True})
        except KeyError as exc:
            self._json({"error": str(exc).strip("'\"")}, HTTPStatus.NOT_FOUND)

    def _method_not_allowed(self) -> None:
        self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
        self.send_header("Allow", "GET, POST, DELETE")
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_PUT = _method_not_allowed
    do_PATCH = _method_not_allowed


def _single(query: dict[str, list[str]], key: str) -> str:
    if set(query) != {key} or len(query[key]) != 1:
        raise BridgeError(f"{key} must appear exactly once")
    return query[key][0]


def _query_values(query: dict[str, list[str]], *keys: str) -> tuple[str, ...]:
    if set(query) != set(keys) or any(len(query[key]) != 1 for key in keys):
        raise BridgeError(f"query must contain exactly: {', '.join(keys)}")
    return tuple(query[key][0] for key in keys)


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, help="optional credential-free allowlist configuration")
    parser.add_argument("--port", type=int, default=8877, help="loopback port, default 8877")
    parser.add_argument("--control-url", help="optional loopback authorization control-plane URL")
    parser.add_argument("--control-key-file", type=Path, help="control-plane signing key file")
    parser.add_argument("--session-url", help="optional loopback SSH session-daemon URL")
    parser.add_argument("--session-key-file", type=Path, help="SSH session-daemon key file")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = make_parser().parse_args(argv)
    if not 1024 <= args.port <= 65535:
        print("error: --port must be between 1024 and 65535", file=sys.stderr)
        return 2
    try:
        config = load_config(args.config) if args.config else validate_config({"version": 1, "hosts": []})
        assets = Path(__file__).with_name("assets")
        if not all((assets / value).is_file() for value in STATIC_FILES.values()):
            raise BridgeError("bridge assets are incomplete")
        server = BridgeHTTPServer(
            ("127.0.0.1", args.port),
            BridgeState(config, args.control_url, args.control_key_file, args.session_url, args.session_key_file),
            assets,
        )
    except (OSError, json.JSONDecodeError, BridgeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, "url": f"http://127.0.0.1:{server.server_port}/", "mode": "allowlisted"}), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.state.close_all_sessions()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
