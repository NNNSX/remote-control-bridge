#!/usr/bin/env python3
"""Loopback-only SSH session daemon for Remote Control Bridge."""

from __future__ import annotations

import argparse
import hmac
import json
import re
import secrets
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import bridge


class SessionDaemonError(ValueError):
    pass


class SessionDaemonServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], state: bridge.BridgeState, key: bytes):
        super().__init__(address, SessionDaemonHandler)
        self.state = state
        self.key = key
        self.authority = f"127.0.0.1:{self.server_port}"


class SessionDaemonHandler(BaseHTTPRequestHandler):
    server: SessionDaemonServer
    protocol_version = "HTTP/1.1"
    server_version = "BridgeSessiond"
    sys_version = ""

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
            self.close_connection = True

    def _authorized(self) -> bool:
        if self.headers.get("Host", "").lower() != self.server.authority:
            return False
        supplied = self.headers.get("X-Session-Key", "")
        return hmac.compare_digest(supplied, self.server.key.hex())

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if not 1 <= length <= 131072:
            raise SessionDaemonError("request body is invalid")
        data = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(data, dict):
            raise SessionDaemonError("request body must be an object")
        return data

    def _guard(self) -> bool:
        if self._authorized():
            return True
        self._json({"error": "session-daemon authorization required"}, HTTPStatus.FORBIDDEN)
        return False

    def do_GET(self) -> None:
        if not self._guard():
            return
        request = urlsplit(self.path)
        try:
            query = parse_qs(request.query, keep_blank_values=True, strict_parsing=True)
            if request.path == "/internal/v1/health":
                if query:
                    raise SessionDaemonError("health does not accept query parameters")
                self._json({"ok": True, "mode": "ssh-session-daemon", "sessions": len(self.server.state.sessions)})
                return
            status_match = re.fullmatch(r"/internal/v1/sessions/([A-Za-z0-9_-]{20,80})/status", request.path)
            if status_match:
                self._json(bridge.collect_session_status(self.server.state, status_match.group(1)))
                return
            terminals_match = re.fullmatch(r"/internal/v1/sessions/([A-Za-z0-9_-]{20,80})/terminals", request.path)
            if terminals_match:
                self._json(bridge.list_session_terminals(self.server.state, terminals_match.group(1)))
                return
            job_match = re.fullmatch(r"/internal/v1/sessions/([A-Za-z0-9_-]{20,80})/jobs/(job-[A-Za-z0-9_-]{12,60})", request.path)
            if job_match:
                self._json(bridge.get_session_job(self.server.state, job_match.group(1), job_match.group(2)))
                return
            events_match = re.fullmatch(r"/internal/v1/sessions/([A-Za-z0-9_-]{20,80})/jobs/(job-[A-Za-z0-9_-]{12,60})/events", request.path)
            if events_match:
                after_values = query.get("after", ["0"])
                if set(query) - {"after"} or len(after_values) != 1:
                    raise SessionDaemonError("events accepts one optional after parameter")
                after = int(after_values[0])
                if after < 0:
                    raise SessionDaemonError("after must be non-negative")
                job = bridge.session_job(self.server.state, events_match.group(1), events_match.group(2))
                with job.event_condition:
                    events = [event for event in job.events if event["id"] > after]
                    complete = job.status not in {"queued", "running"}
                self._json({"events": events, "complete": complete, "status": job.status})
                return
            if request.path == "/internal/v1/agent/session":
                token, session = self.server.state.agent_session()
                self._json({
                    "authorized": True, "session": token, "host": session.host,
                    "port": session.port, "username": session.username,
                    **bridge.session_connection_policy(),
                })
                return
            if request.path == "/internal/v1/agent/terminals":
                token, _ = self.server.state.agent_session()
                self._json(bridge.list_session_terminals(self.server.state, token))
                return
            agent_job_match = re.fullmatch(r"/internal/v1/agent/jobs/(job-[A-Za-z0-9_-]{12,60})", request.path)
            if agent_job_match:
                token, _ = self.server.state.agent_session()
                self._json(bridge.get_session_job(self.server.state, token, agent_job_match.group(1)))
                return
            agent_events_match = re.fullmatch(r"/internal/v1/agent/jobs/(job-[A-Za-z0-9_-]{12,60})/events", request.path)
            if agent_events_match:
                token, _ = self.server.state.agent_session()
                after_values = query.get("after", ["0"])
                if set(query) - {"after"} or len(after_values) != 1:
                    raise SessionDaemonError("events accepts one optional after parameter")
                after = int(after_values[0])
                if after < 0:
                    raise SessionDaemonError("after must be non-negative")
                job = bridge.session_job(self.server.state, token, agent_events_match.group(1))
                with job.event_condition:
                    events = [event for event in job.events if event["id"] > after]
                    complete = job.status not in {"queued", "running"}
                self._json({"events": events, "complete": complete, "status": job.status})
                return
            self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except (ValueError, bridge.BridgeError, SessionDaemonError) as exc:
            self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except KeyError as exc:
            self._json({"error": str(exc).strip("'\"")}, HTTPStatus.NOT_FOUND)
        except OSError as exc:
            self._json({"error": str(exc)[:500]}, HTTPStatus.BAD_GATEWAY)
        except Exception:
            self._json({"error": "internal session-daemon error"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:
        if not self._guard():
            return
        path = urlsplit(self.path).path
        try:
            data = self._body()
            if path == "/internal/v1/host-keys/trust":
                if set(data) != {"token"} or not isinstance(data["token"], str):
                    raise SessionDaemonError("host key trust requires a confirmation token")
                self._json(self.server.state.trust_host_key(data["token"]))
                return
            if path == "/internal/v1/sessions":
                token, session = self.server.state.open_session(bridge._session_request(data))
                try:
                    status_data = bridge.collect_session_status(self.server.state, token)
                except BaseException:
                    self.server.state.close_session(token)
                    raise
                self._json({
                    "session": token,
                    "host": session.host,
                    "port": session.port,
                    "username": session.username,
                    "fingerprint": session.fingerprint,
                    **bridge.session_connection_policy(),
                    "status": status_data,
                }, HTTPStatus.CREATED)
                return
            log_match = re.fullmatch(r"/internal/v1/sessions/([A-Za-z0-9_-]{20,80})/logs", path)
            if log_match:
                if set(data) != {"path", "lines"}:
                    raise SessionDaemonError("log request requires path and lines")
                self._json(bridge.read_session_log(self.server.state, log_match.group(1), data["path"], data["lines"]))
                return
            command_match = re.fullmatch(r"/internal/v1/sessions/([A-Za-z0-9_-]{20,80})/commands", path)
            if command_match:
                result = bridge.submit_session_command(self.server.state, command_match.group(1), data)
                self._json(result, HTTPStatus.ACCEPTED)
                return
            agent_match = re.fullmatch(r"/internal/v1/sessions/([A-Za-z0-9_-]{20,80})/agent", path)
            if agent_match:
                if set(data) != {"enabled"}:
                    raise SessionDaemonError("agent authorization requires enabled")
                session = self.server.state.set_agent_enabled(agent_match.group(1), data["enabled"])
                self._json({"agent_enabled": session.agent_enabled})
                return
            if path == "/internal/v1/agent/commands":
                token, _ = self.server.state.agent_session()
                self._json(bridge.submit_session_command(self.server.state, token, data), HTTPStatus.ACCEPTED)
                return
            self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except bridge.HostTrustRequired as exc:
            self._json({
                "error": str(exc), "trust_required": True, "token": exc.token,
                "host": exc.host, "port": exc.port, "key_type": exc.key_type,
                "fingerprint": exc.fingerprint,
            }, HTTPStatus.CONFLICT)
        except bridge.ConflictError as exc:
            self._json({"error": str(exc)}, HTTPStatus.CONFLICT)
        except (ValueError, bridge.BridgeError, SessionDaemonError, json.JSONDecodeError) as exc:
            self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except KeyError as exc:
            self._json({"error": str(exc).strip("'\"")}, HTTPStatus.NOT_FOUND)
        except OSError as exc:
            self._json({"error": str(exc)[:500]}, HTTPStatus.BAD_GATEWAY)
        except Exception:
            self._json({"error": "internal session-daemon error"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_DELETE(self) -> None:
        if not self._guard():
            return
        path = urlsplit(self.path).path
        job_match = re.fullmatch(r"/internal/v1/sessions/([A-Za-z0-9_-]{20,80})/jobs/(job-[A-Za-z0-9_-]{12,60})", path)
        agent_job_match = re.fullmatch(r"/internal/v1/agent/jobs/(job-[A-Za-z0-9_-]{12,60})", path)
        session_match = re.fullmatch(r"/internal/v1/sessions/([A-Za-z0-9_-]{20,80})", path)
        try:
            if job_match:
                self._json(bridge.cancel_session_job(self.server.state, job_match.group(1), job_match.group(2)), HTTPStatus.ACCEPTED)
                return
            if agent_job_match:
                token, _ = self.server.state.agent_session()
                self._json(bridge.cancel_session_job(self.server.state, token, agent_job_match.group(1)), HTTPStatus.ACCEPTED)
                return
            if session_match:
                self.server.state.close_session(session_match.group(1))
                self._json({"closed": True})
                return
            self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except bridge.ConflictError as exc:
            self._json({"error": str(exc)}, HTTPStatus.CONFLICT)
        except KeyError as exc:
            self._json({"error": str(exc).strip("'\"")}, HTTPStatus.NOT_FOUND)


def load_or_create_key(path: Path) -> bytes:
    if path.is_file():
        key = path.read_bytes()
        if len(key) != 32:
            raise SessionDaemonError("session-daemon key must contain exactly 32 bytes")
        return key
    path.parent.mkdir(parents=True, exist_ok=True)
    key = secrets.token_bytes(32)
    path.write_bytes(key)
    return key


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, help="optional credential-free allowlist configuration")
    parser.add_argument("--port", type=int, default=8879)
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).with_name("data"))
    parser.add_argument("--control-url", help="optional authorization control-plane URL")
    parser.add_argument("--control-key-file", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = make_parser().parse_args(argv)
    if not 1024 <= args.port <= 65535:
        print("error: --port must be between 1024 and 65535")
        return 2
    try:
        config = bridge.load_config(args.config) if args.config else bridge.validate_config({"version": 1, "hosts": []})
        key = load_or_create_key(args.data_dir / "sessiond.key")
        state = bridge.BridgeState(config, args.control_url, args.control_key_file)
        server = SessionDaemonServer(("127.0.0.1", args.port), state, key)
    except (OSError, ValueError, json.JSONDecodeError, bridge.BridgeError, SessionDaemonError) as exc:
        print(f"error: {exc}")
        return 2
    print(json.dumps({"ok": True, "url": f"http://127.0.0.1:{server.server_port}/", "mode": "ssh-session-daemon"}), flush=True)
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
