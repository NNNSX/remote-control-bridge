from __future__ import annotations

import http.client
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("sessiond", ROOT / "sessiond.py")
assert SPEC and SPEC.loader
sessiond = importlib.util.module_from_spec(SPEC)
sys.modules["sessiond"] = sessiond
SPEC.loader.exec_module(sessiond)


class SessionDaemonTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.key = b"k" * 32
        config = sessiond.bridge.validate_config({"version": 1, "hosts": []})
        self.state = sessiond.bridge.BridgeState(config)
        self.server = sessiond.SessionDaemonServer(("127.0.0.1", 0), self.state, self.key)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.tempdir.cleanup()

    def request_full(
        self, method: str, path: str, body: dict | None = None, key: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[int, dict, http.client.HTTPMessage]:
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        headers = {"Host": self.server.authority, "X-Session-Key": key if key is not None else self.key.hex()}
        headers.update(extra_headers or {})
        encoded = None
        if body is not None:
            encoded = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=encoded, headers=headers)
        response = connection.getresponse()
        payload = json.loads(response.read().decode("utf-8"))
        response_headers = response.headers
        connection.close()
        return response.status, payload, response_headers

    def request(self, method: str, path: str, body: dict | None = None, key: str | None = None) -> tuple[int, dict]:
        status, payload, _ = self.request_full(method, path, body, key)
        return status, payload

    def test_health_requires_internal_key(self) -> None:
        status, payload = self.request("GET", "/internal/v1/health")
        self.assertEqual(status, 200)
        self.assertEqual(payload["mode"], "ssh-session-daemon")
        status, _ = self.request("GET", "/internal/v1/health", key="wrong")
        self.assertEqual(status, 403)

    def test_open_session_does_not_persist_password(self) -> None:
        live = sessiond.bridge.LiveSession(mock.MagicMock(), "192.0.2.10", 22, "remote-user", None, fingerprint="SHA256:test")
        with mock.patch.object(self.state, "open_session", return_value=("temporary-session-token", live)) as opened, mock.patch.object(
            sessiond.bridge, "collect_session_status", return_value={"hostname": "amax"}
        ):
            status, payload, headers = self.request_full("POST", "/internal/v1/sessions", {
                "protocol": "ssh", "host": "192.0.2.10", "port": 22,
                "username": "remote-user", "password": "temporary-only",
            })
        self.assertEqual(status, 201)
        self.assertEqual(payload["session"], "temporary-session-token")
        self.assertEqual(payload["status"]["hostname"], "amax")
        self.assertIsNone(payload["expires_in_seconds"])
        self.assertFalse(payload["idle_timeout_enabled"])
        self.assertEqual(payload["keepalive_interval_seconds"], 30)
        self.assertIsNone(payload["keepalive_failure_threshold"])
        self.assertEqual(payload["disconnect_detection"], "transport")
        self.assertIn("HttpOnly; SameSite=Strict", headers["Set-Cookie"])
        self.assertEqual(opened.call_args.args[0]["password"], "temporary-only")
        self.assertFalse(hasattr(live, "password"))

    def test_browser_recovery_is_cookie_bound_and_independent_of_agent_access(self) -> None:
        token = "temporary-session-token"
        client = mock.MagicMock()
        client.get_transport.return_value.is_active.return_value = True
        live = sessiond.bridge.LiveSession(client, "192.0.2.10", 22, "remote-user", None, fingerprint="SHA256:test")
        self.state.sessions[token] = live
        recovery_token = self.state.issue_session_recovery(live)
        cookie = f"{sessiond.bridge.SESSION_RECOVERY_COOKIE}={recovery_token}"
        with mock.patch.object(sessiond.bridge, "collect_session_status", return_value={"hostname": "amax"}):
            status, payload, headers = self.request_full("GET", "/internal/v1/sessions/recover", extra_headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        self.assertEqual(payload["session"], token)
        self.assertFalse(live.agent_enabled)
        self.assertIn("Max-Age=", headers["Set-Cookie"])

        status, _, headers = self.request_full("GET", "/internal/v1/sessions/recover", extra_headers={"Cookie": "rcb_session_recovery=invalid"})
        self.assertEqual(status, 404)
        self.assertIn("Max-Age=0", headers["Set-Cookie"])

    def test_command_status_and_close_are_delegated(self) -> None:
        with mock.patch.object(sessiond.bridge, "submit_session_command", return_value={"job_id": "job-abcdefghijkl", "terminal_id": "term-abcdefgh"}) as submit:
            status, payload = self.request("POST", "/internal/v1/sessions/temporary-session-token/commands", {"command": "hostname"})
        self.assertEqual(status, 202)
        self.assertEqual(payload["job_id"], "job-abcdefghijkl")
        submit.assert_called_once()

        with mock.patch.object(self.state, "close_session") as close:
            status, payload, headers = self.request_full("DELETE", "/internal/v1/sessions/temporary-session-token")
        self.assertEqual(status, 200)
        self.assertTrue(payload["closed"])
        self.assertIn("Max-Age=0", headers["Set-Cookie"])
        close.assert_called_once_with("temporary-session-token")

        status, payload, headers = self.request_full("DELETE", "/internal/v1/sessions/missing-session-token")
        self.assertEqual(status, 200)
        self.assertFalse(payload["closed"])
        self.assertIn("Max-Age=0", headers["Set-Cookie"])

    def test_key_persists_and_rejects_invalid_length(self) -> None:
        path = Path(self.tempdir.name) / "sessiond.key"
        first = sessiond.load_or_create_key(path)
        self.assertEqual(len(first), 32)
        self.assertEqual(sessiond.load_or_create_key(path), first)
        path.write_bytes(b"short")
        with self.assertRaises(sessiond.SessionDaemonError):
            sessiond.load_or_create_key(path)


if __name__ == "__main__":
    unittest.main()
