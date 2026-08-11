from __future__ import annotations

import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("control_plane", ROOT / "control_plane.py")
assert SPEC and SPEC.loader
control_plane = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(control_plane)


def binding(**overrides: object) -> dict[str, object]:
    result: dict[str, object] = {
        "host": "192.0.2.10",
        "port": 22,
        "username": "remote-user",
        "fingerprint": "SHA256:fixture-fingerprint",
    }
    result.update(overrides)
    return result


class GrantStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.state_path = root / "control_grants.json"
        self.key_path = root / "control_signing.key"
        self.store = control_plane.GrantStore(self.state_path, self.key_path)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_grant_token_signature_and_claims(self) -> None:
        result = self.store.grant(binding(), ["status:read", "jobs:execute", "status:read"], 60)
        claims = self.store.verify(result["token"], binding(), "jobs:execute")
        self.assertEqual(claims["jti"], result["grant_id"])
        self.assertEqual(claims["scopes"], ["jobs:execute", "status:read"])
        self.assertEqual(claims["binding"], binding())

        encoded, signature = result["token"].split(".")
        tampered = encoded[:-1] + ("A" if encoded[-1] != "A" else "B")
        with self.assertRaises(control_plane.ControlError):
            self.store.verify(tampered + "." + signature, binding())

    def test_binding_mismatch_is_rejected(self) -> None:
        result = self.store.grant(binding(), ["status:read"], 60)
        for changed in (
            {"host": "192.0.2.11"},
            {"port": 2200},
            {"username": "other"},
            {"fingerprint": "SHA256:other"},
        ):
            with self.subTest(changed=changed):
                with self.assertRaises(control_plane.ControlError):
                    self.store.verify(result["token"], binding(**changed))

    def test_scope_is_enforced(self) -> None:
        result = self.store.grant(binding(), ["status:read"], 60)
        with self.assertRaises(control_plane.ControlError):
            self.store.verify(result["token"], binding(), "jobs:execute")
        self.assertEqual(self.store.verify(result["token"], binding(), "status:read")["jti"], result["grant_id"])

    def test_expired_token_is_rejected(self) -> None:
        result = self.store.grant(binding(), ["status:read"], 60)
        with mock.patch.object(control_plane.time, "time", return_value=result["expires_at"] + 1):
            with self.assertRaises(control_plane.ControlError):
                self.store.verify(result["token"], binding())

    def test_revoke_blocks_verification_and_authorization(self) -> None:
        result = self.store.grant(binding(), ["status:read"], 60)
        self.assertIsNotNone(self.store.authorize_binding(binding()))
        self.store.revoke(result["grant_id"])
        with self.assertRaises(control_plane.ControlError):
            self.store.verify(result["token"], binding())
        self.assertIsNone(self.store.authorize_binding(binding()))
        with self.assertRaises(KeyError):
            self.store.revoke("missing-grant")

    def test_renewal_extends_expired_grant_but_never_revives_revocation(self) -> None:
        with mock.patch.object(control_plane.time, "time", return_value=100):
            original = self.store.grant(binding(), ["status:read"], 60)
        with mock.patch.object(control_plane.time, "time", return_value=1000):
            renewed = self.store.renew(original["grant_id"], binding(), 600)
        self.assertEqual(renewed["grant_id"], original["grant_id"])
        self.assertEqual(renewed["expires_at"], 1600)
        with mock.patch.object(control_plane.time, "time", return_value=1001):
            with self.assertRaises(control_plane.ControlError):
                self.store.verify(original["token"], binding(), "status:read")
            self.assertEqual(self.store.verify(renewed["token"], binding(), "status:read")["jti"], original["grant_id"])
        self.store.revoke(original["grant_id"])
        with self.assertRaisesRegex(control_plane.ControlError, "revoked"):
            self.store.renew(original["grant_id"], binding(), 600)

    def test_state_and_signing_key_survive_reload(self) -> None:
        result = self.store.grant(binding(), ["files:read"], 60)
        original_key = self.key_path.read_bytes()
        persisted = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertIn(result["grant_id"], persisted)

        reloaded = control_plane.GrantStore(self.state_path, self.key_path)
        self.assertEqual(reloaded.key, original_key)
        self.assertEqual(reloaded.verify(result["token"], binding(), "files:read")["jti"], result["grant_id"])

    def test_invalid_binding_and_grant_inputs_are_rejected(self) -> None:
        with self.assertRaises(control_plane.ControlError):
            self.store.grant({"host": "192.0.2.10"}, ["status:read"], 60)
        with self.assertRaises(control_plane.ControlError):
            self.store.grant(binding(), ["unknown:scope"], 60)
        with self.assertRaises(control_plane.ControlError):
            self.store.grant(binding(), ["status:read"], 59)


class ControlServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.store = control_plane.GrantStore(root / "control_grants.json", root / "control_signing.key")
        self.server = control_plane.ControlServer(("127.0.0.1", 0), self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://{self.server.authority}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.tempdir.cleanup()

    def request(
        self,
        path: str,
        payload: dict[str, object] | None = None,
        *,
        control_key: str | None = None,
    ) -> tuple[int, dict[str, object]]:
        headers = {"Accept": "application/json"}
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if control_key is not None:
            headers["X-Control-Key"] = control_key
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=2)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def post(self, path: str, payload: dict[str, object]) -> tuple[int, dict[str, object]]:
        return self.request(path, payload, control_key=self.store.key.hex())

    def test_health(self) -> None:
        status, result = self.request("/api/v1/health")
        self.assertEqual(status, 200)
        self.assertEqual(result, {"ok": True, "mode": "authorization-control-plane"})

    def test_internal_key_is_required_for_post(self) -> None:
        payload = {"binding": binding(), "scopes": ["status:read"], "ttl_seconds": 60}
        for supplied_key in (None, "incorrect-key"):
            with self.subTest(supplied_key=supplied_key):
                status, result = self.request("/api/v1/grants", payload, control_key=supplied_key)
                self.assertEqual(status, 403)
                self.assertEqual(result, {"error": "control-plane authorization required"})
        self.assertEqual(self.store.grants, {})

    def test_grant_authorize_and_revoke(self) -> None:
        status, granted = self.post(
            "/api/v1/grants",
            {"binding": binding(), "scopes": ["status:read", "jobs:execute"], "ttl_seconds": 60},
        )
        self.assertEqual(status, 201)
        self.assertIsInstance(granted["grant_id"], str)
        self.assertIsInstance(granted["token"], str)
        self.assertEqual(granted["scopes"], ["jobs:execute", "status:read"])

        status, authorized = self.post("/api/v1/authorize", {"binding": binding()})
        self.assertEqual(status, 200)
        self.assertTrue(authorized["authorized"])
        self.assertEqual(authorized["grant"]["grant_id"], granted["grant_id"])

        status, renewed = self.post("/api/v1/grants/renew", {
            "grant_id": granted["grant_id"], "binding": binding(), "ttl_seconds": 600,
        })
        self.assertEqual(status, 200)
        self.assertEqual(renewed["grant_id"], granted["grant_id"])
        self.assertGreaterEqual(renewed["expires_at"], granted["expires_at"])

        status, revoked = self.post("/api/v1/revoke", {"grant_id": granted["grant_id"]})
        self.assertEqual(status, 200)
        self.assertEqual(revoked, {"revoked": True})

        status, authorized = self.post("/api/v1/authorize", {"binding": binding()})
        self.assertEqual(status, 200)
        self.assertEqual(authorized, {"authorized": False, "grant": None})


if __name__ == "__main__":
    unittest.main()
