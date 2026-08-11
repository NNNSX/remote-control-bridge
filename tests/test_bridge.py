from __future__ import annotations

import hashlib
import http.client
import importlib.util
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("bridge", ROOT / "bridge.py")
assert SPEC and SPEC.loader
bridge = importlib.util.module_from_spec(SPEC)
sys.modules["bridge"] = bridge
SPEC.loader.exec_module(bridge)


def config() -> dict:
    return {
        "version": 1,
        "hosts": [{
            "name": "example-host",
            "target": "example-host",
            "workdir": "/home/remote-user/project",
            "logs": [{"name": "example", "path": "/home/remote-user/project/stdout.log", "max_lines": 120}],
            "artifact_root": "/home/remote-user/project/.bridge-inbox",
            "artifacts": [{
                "name": "fixture", "url": "https://downloads.example.test/fixture.whl",
                "sha256": hashlib.sha256(b"fixture").hexdigest(), "destination": "fixture.whl", "max_bytes": 1024,
            }],
        }],
    }


class ConfigTests(unittest.TestCase):
    def test_valid_config_is_credential_free_and_bounded(self) -> None:
        result = bridge.validate_config(config())
        self.assertEqual(result["hosts"][0]["artifacts"][0]["name"], "fixture")
        self.assertEqual(result["hosts"][0]["logs"][0]["max_lines"], 120)

    def test_rejects_passwords_paths_and_arbitrary_urls(self) -> None:
        bad = config(); bad["password"] = "never-store-this"
        with self.assertRaises(bridge.BridgeError): bridge.validate_config(bad)
        bad = config(); bad["hosts"][0]["artifacts"][0]["url"] = "http://example.test/file"
        with self.assertRaises(bridge.BridgeError): bridge.validate_config(bad)
        bad = config(); bad["hosts"][0]["artifacts"][0]["destination"] = "../escape"
        with self.assertRaises(bridge.BridgeError): bridge.validate_config(bad)


class OperationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = bridge.validate_config(config())
        self.host = self.config["hosts"][0]

    def test_status_uses_array_ssh_and_parses_gpu_fields(self) -> None:
        output = "\n".join((
            "RCB\thostname\tgpu-01", "RCB\tworkdir_exists\ttrue", "RCB\troot_disk\t100|40|60|40%",
            "RCB\tgpu\t0, NVIDIA Test, 12000, 24576, 85, 67",
        ))
        with mock.patch.object(bridge.shutil, "which", return_value="ssh-test"), mock.patch.object(bridge.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output, "")) as run:
            result = bridge.collect_status(self.config, self.host)
        self.assertEqual(result["hostname"], "gpu-01")
        self.assertTrue(result["workdir_exists"])
        self.assertEqual(result["gpus"][0]["utilization_percent"], "85")
        command = run.call_args.args[0]
        self.assertEqual(command[0], "ssh-test")
        self.assertIn("BatchMode=yes", command)
        self.assertEqual(run.call_args.kwargs["input"], bridge.STATUS_SCRIPT)

    def test_log_is_bounded_and_redacted(self) -> None:
        with mock.patch.object(bridge.shutil, "which", return_value="ssh-test"), mock.patch.object(bridge.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "step=4 API_TOKEN=hidden\n", "")):
            result = bridge.read_log(self.config, self.host, self.host["logs"][0], 120)
        self.assertNotIn("hidden", result["content"])
        self.assertIn("[REDACTED]", result["content"])

    def test_download_requires_the_expected_hash_and_size(self) -> None:
        artifact = self.host["artifacts"][0]
        def response() -> mock.MagicMock:
            result = mock.MagicMock()
            result.read.side_effect = [b"fixture", b""]
            result.__enter__.return_value = result
            result.__exit__.return_value = False
            return result

        with mock.patch.object(bridge, "_open_artifact", return_value=response()):
            path = bridge._download_artifact(artifact)
        try:
            self.assertEqual(path.read_bytes(), b"fixture")
        finally:
            path.unlink(missing_ok=True)

        bad = dict(artifact); bad["sha256"] = "0" * 64
        with mock.patch.object(bridge, "_open_artifact", return_value=response()):
            with self.assertRaises(bridge.BridgeError): bridge._download_artifact(bad)

    def test_scp_uses_a_dedicated_safe_argument_list(self) -> None:
        with tempfile.NamedTemporaryFile(delete=False) as stream:
            source = Path(stream.name)
        try:
            with mock.patch.object(bridge.shutil, "which", return_value="scp-test"):
                command = bridge._scp_command(self.config, self.host, source, "/home/remote-user/project/.bridge-inbox/fixture.whl")
            self.assertEqual(command[0], "scp-test")
            self.assertNotIn("-T", command)
            self.assertEqual(command[-1], "example-host:/home/remote-user/project/.bridge-inbox/fixture.whl")
        finally:
            source.unlink(missing_ok=True)

    def test_stage_requires_a_configured_artifact(self) -> None:
        state = bridge.BridgeState(self.config)
        with self.assertRaises(KeyError): state.artifact(self.host, "arbitrary-url")


class SessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = bridge.validate_config(config())
        self.request = {
            "protocol": "ssh", "host": "192.0.2.11", "port": 22,
            "username": "remote-user", "password": "not-persisted",
        }

    def test_session_request_rejects_non_ssh_and_sensitive_workdirs(self) -> None:
        bad = dict(self.request); bad["protocol"] = "telnet"
        with self.assertRaises(bridge.BridgeError): bridge._session_request(bad)
        bad = dict(self.request); bad["workdir"] = "/home/remote-user/.ssh"
        with self.assertRaises(bridge.BridgeError): bridge._session_request(bad)
        self.assertIsNone(bridge._session_request(self.request)["workdir"])
        key_request = dict(self.request)
        key_request.update({"auth_method": "key", "password": ""})
        parsed = bridge._session_request(key_request)
        self.assertEqual(parsed["auth_method"], "key")
        self.assertIsNone(parsed["password"])

    def test_command_request_is_bounded(self) -> None:
        request = bridge._command_request({"command": "nvidia-smi"})
        self.assertEqual(request["command"], "nvidia-smi")
        self.assertEqual(request["timeout_seconds"], bridge.DEFAULT_COMMAND_TIMEOUT_SECONDS)
        with self.assertRaises(bridge.BridgeError):
            bridge._command_request({"command": ""})
        with self.assertRaises(bridge.BridgeError):
            bridge._command_request({"command": "x" * (bridge.MAX_COMMAND_CHARS + 1)})

    def test_busy_terminal_allocates_a_bounded_parallel_slot(self) -> None:
        state = bridge.BridgeState(self.config)
        token = "temporary-session-token"
        session = bridge.LiveSession(mock.MagicMock(), "192.0.2.10", 22, "remote-user", None, time.monotonic() + 60)
        state.sessions[token] = session
        gate = threading.Event()

        def run(*args, **kwargs):
            gate.wait(2)
            return {"exit_status": 0, "stdout": "ok", "stderr": "", "truncated": False, "duration_ms": 1}

        with mock.patch.object(bridge, "_execute_command_job", side_effect=run):
            first = bridge.submit_session_command(state, token, {"command": "sleep 1"})
            second = bridge.submit_session_command(state, token, {"command": "hostname", "terminal_id": first["terminal_id"]})
            self.assertNotEqual(first["terminal_id"], second["terminal_id"])
            self.assertEqual(len(session.terminals), 2)
            gate.set()
            deadline = time.monotonic() + 2
            while any(terminal.busy for terminal in session.terminals.values()) and time.monotonic() < deadline:
                time.sleep(0.01)
        self.assertFalse(any(terminal.busy for terminal in session.terminals.values()))

    def test_running_job_can_be_cancelled_and_releases_terminal(self) -> None:
        state = bridge.BridgeState(self.config)
        token = "temporary-session-token"
        session = bridge.LiveSession(mock.MagicMock(), "192.0.2.10", 22, "remote-user", None, time.monotonic() + 60)
        state.sessions[token] = session

        def run(state_arg, token_arg, job):
            while not job.cancel_event.wait(0.01):
                pass
            raise bridge.JobCancelled()

        with mock.patch.object(bridge, "_execute_command_job", side_effect=run):
            submitted = bridge.submit_session_command(state, token, {"command": "sleep 60"})
            deadline = time.monotonic() + 1
            while bridge.get_session_job(state, token, submitted["job_id"])["status"] == "queued" and time.monotonic() < deadline:
                time.sleep(0.01)
            bridge.cancel_session_job(state, token, submitted["job_id"])
            while bridge.get_session_job(state, token, submitted["job_id"])["status"] in {"queued", "running"} and time.monotonic() < deadline:
                time.sleep(0.01)
        self.assertEqual(bridge.get_session_job(state, token, submitted["job_id"])["status"], "cancelled")
        self.assertFalse(session.terminals[submitted["terminal_id"]].busy)

    def test_timeout_has_a_distinct_terminal_state(self) -> None:
        state = bridge.BridgeState(self.config)
        token = "temporary-session-token"
        state.sessions[token] = bridge.LiveSession(mock.MagicMock(), "192.0.2.10", 22, "remote-user", None, time.monotonic() + 60)
        with mock.patch.object(bridge, "_execute_command_job", side_effect=bridge.JobTimedOut()):
            submitted = bridge.submit_session_command(state, token, {"command": "sleep 60", "timeout_seconds": 1})
            deadline = time.monotonic() + 1
            while bridge.get_session_job(state, token, submitted["job_id"])["status"] in {"queued", "running"} and time.monotonic() < deadline:
                time.sleep(0.01)
        self.assertEqual(bridge.get_session_job(state, token, submitted["job_id"])["status"], "timed_out")

    def test_global_concurrency_limit_is_enforced(self) -> None:
        state = bridge.BridgeState(self.config)
        token = "temporary-session-token"
        state.sessions[token] = bridge.LiveSession(mock.MagicMock(), "192.0.2.10", 22, "remote-user", None, time.monotonic() + 60)
        state.active_jobs = bridge.MAX_GLOBAL_ACTIVE_JOBS
        with self.assertRaises(bridge.ConflictError):
            bridge.submit_session_command(state, token, {"command": "hostname"})

    def test_job_output_publishes_bounded_events(self) -> None:
        job = bridge.CommandJob("job-test-output", "term-test-output", "echo ok", 30)
        bridge._append_job_output(job, "stdout", "hello\n")
        self.assertEqual(job.stdout, "hello\n")
        self.assertEqual(job.events[-1]["type"], "stdout")

    def test_password_is_not_stored_in_live_session(self) -> None:
        fake_client = mock.MagicMock()
        fake_paramiko = mock.MagicMock()
        fake_paramiko.SSHClient.return_value = fake_client
        with mock.patch.object(bridge, "paramiko", fake_paramiko):
            state = bridge.BridgeState(self.config)
            with mock.patch.object(state, "_require_trusted_host_key"):
                token, session = state.open_session(bridge._session_request(self.request))
        self.assertTrue(token)
        self.assertFalse(hasattr(session, "password"))
        self.assertNotIn("not-persisted", repr(session))
        self.assertEqual(fake_client.connect.call_args.kwargs["password"], "not-persisted")
        state.close_session(token)

    def test_agent_access_requires_explicit_session_authorization(self) -> None:
        state = bridge.BridgeState(self.config)
        token = "temporary-session-token"
        session = bridge.LiveSession(mock.MagicMock(), "192.0.2.10", 22, "remote-user", None, time.monotonic() + 60)
        state.sessions[token] = session
        with self.assertRaises(KeyError):
            state.agent_session()
        state.set_agent_enabled(token, True)
        self.assertEqual(state.agent_session()[0], token)
        state.set_agent_enabled(token, False)
        with self.assertRaises(KeyError):
            state.agent_session()

    def test_control_client_revoke_posts_grant_id(self) -> None:
        with tempfile.NamedTemporaryFile(delete=False) as stream:
            stream.write(b"0" * 32)
            key_path = Path(stream.name)
        self.addCleanup(key_path.unlink, missing_ok=True)
        client = bridge.ControlClient("http://127.0.0.1:8878", key_path)
        with mock.patch.object(client, "_post", return_value={"revoked": True}) as post:
            self.assertEqual(client.revoke("grant-1"), {"revoked": True})
        post.assert_called_once_with("/api/v1/revoke", {"grant_id": "grant-1"})

    def test_control_client_rejects_non_loopback_url_and_missing_key(self) -> None:
        with self.assertRaises(bridge.BridgeError):
            bridge.ControlClient("http://192.0.2.10:8878", Path("missing-key"))
        with self.assertRaises(bridge.BridgeError):
            bridge.ControlClient("http://127.0.0.1:8878", Path("missing-key"))

    def test_session_daemon_client_rejects_non_loopback_url(self) -> None:
        with self.assertRaises(bridge.BridgeError):
            bridge.SessionDaemonClient("http://192.0.2.10:8879", Path("missing-key"))

    def test_session_creation_uses_extended_daemon_timeout(self) -> None:
        with tempfile.NamedTemporaryFile(delete=False) as stream:
            stream.write(b"s" * 32)
            key_path = Path(stream.name)
        self.addCleanup(key_path.unlink, missing_ok=True)
        client = bridge.SessionDaemonClient("http://127.0.0.1:8879", key_path)
        response = mock.MagicMock()
        response.status = 201
        response.read.return_value = b'{"session":"temporary-session-token"}'
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        with mock.patch.object(bridge.urllib.request, "urlopen", return_value=response) as opened:
            status, _ = client.request("POST", "/internal/v1/sessions", {"password": "temporary-only"})
        self.assertEqual(status, 201)
        self.assertEqual(opened.call_args.kwargs["timeout"], bridge.SESSION_OPEN_PROXY_TIMEOUT_SECONDS)

    def test_openssh_76_prefers_asyncssh_before_paramiko_auth(self) -> None:
        state = bridge.BridgeState(self.config)
        state.remote_versions[("192.0.2.10", 22)] = "SSH-2.0-OpenSSH_7.6"
        fake_client = mock.MagicMock()
        fake_async_client = mock.MagicMock()
        fake_paramiko = mock.MagicMock()
        fake_paramiko.SSHClient.return_value = fake_client
        request_data = dict(self.request)
        request_data["host"] = "192.0.2.10"
        request = bridge._session_request(request_data)
        with mock.patch.object(bridge, "paramiko", fake_paramiko), mock.patch.object(bridge, "asyncssh", mock.MagicMock()), mock.patch.object(
            state, "_require_trusted_host_key", return_value="SHA256:test"
        ), mock.patch.object(state, "_connect_asyncssh", return_value=fake_async_client):
            token, session = state.open_session(request)
        self.assertTrue(token)
        self.assertEqual(session.backend, "asyncssh")
        fake_client.connect.assert_not_called()
        state.close_session(token)

    def test_session_log_rejects_private_key_paths(self) -> None:
        fake_session = mock.MagicMock()
        state = bridge.BridgeState(self.config)
        with mock.patch.object(state, "session", return_value=fake_session):
            with self.assertRaises(bridge.BridgeError):
                bridge.read_session_log(state, "session-token", "/home/remote-user/.ssh/id_ed25519", 20)

    def test_unknown_host_key_requires_explicit_short_lived_confirmation(self) -> None:
        fake_key = mock.MagicMock()
        fake_key.get_name.return_value = "ssh-ed25519"
        fake_key.asbytes.return_value = b"fixture-host-key"
        fake_keys = mock.MagicMock()
        fake_keys.lookup.return_value = None
        state = bridge.BridgeState(self.config)
        with mock.patch.object(bridge, "paramiko", mock.MagicMock()), mock.patch.object(state, "_probe_host_key", return_value=fake_key), mock.patch.object(state, "_host_keys", return_value=fake_keys):
            with self.assertRaises(bridge.HostTrustRequired) as caught:
                state._require_trusted_host_key("192.0.2.11", 22)
            self.assertTrue(caught.exception.token)
            self.assertTrue(caught.exception.fingerprint.startswith("SHA256:"))
            result = state.trust_host_key(caught.exception.token)
        self.assertTrue(result["trusted"])
        fake_keys.add.assert_called_once()
        fake_keys.save.assert_called_once()


class ServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = bridge.validate_config(config())
        self.server = bridge.BridgeHTTPServer(("127.0.0.1", 0), bridge.BridgeState(self.config), ROOT / "assets")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)

    def tearDown(self) -> None:
        self.connection.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def test_loopback_health_and_host_list(self) -> None:
        self.connection.request("GET", "/api/v1/health")
        response = self.connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertTrue(json.loads(response.read())["ok"])
        self.connection.request("GET", "/api/v1/hosts")
        response = self.connection.getresponse()
        hosts = json.loads(response.read())["hosts"]
        self.assertEqual(hosts[0]["name"], "example-host")
        self.assertNotIn("sha256", json.dumps(hosts))

    def test_rejects_non_loopback_host_header(self) -> None:
        self.connection.putrequest("GET", "/api/v1/health", skip_host=True)
        self.connection.putheader("Host", "attacker.example")
        self.connection.endheaders()
        response = self.connection.getresponse()
        self.assertEqual(response.status, 421)
        response.read()

    def test_session_routes_proxy_to_session_daemon(self) -> None:
        sessiond = mock.MagicMock()
        sessiond.enabled = True
        sessiond.request.side_effect = [
            (201, {"session": "temporary-session-token", "status": {"hostname": "amax"}}),
            (200, {"hostname": "amax"}),
        ]
        self.server.state.sessiond = sessiond
        payload = json.dumps({
            "protocol": "ssh", "host": "192.0.2.10", "port": 22,
            "username": "remote-user", "password": "temporary-only",
        })
        self.connection.request("POST", "/api/v1/sessions", payload, {"Content-Type": "application/json"})
        response = self.connection.getresponse()
        self.assertEqual(response.status, 201)
        self.assertEqual(json.loads(response.read())["status"]["hostname"], "amax")
        self.connection.request("GET", "/api/v1/sessions/temporary-session-token/status")
        response = self.connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.read())["hostname"], "amax")
        self.assertEqual(sessiond.request.call_args_list[0].args[0:2], ("POST", "/internal/v1/sessions"))
        self.assertEqual(sessiond.request.call_args_list[1].args, ("GET", "/internal/v1/sessions/temporary-session-token/status", None))


if __name__ == "__main__":
    unittest.main()
