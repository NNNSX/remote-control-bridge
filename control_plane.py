#!/usr/bin/env python3
"""Loopback-only authorization control plane for Remote Control Bridge."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


SCOPES = {"status:read", "jobs:read", "jobs:execute", "jobs:cancel", "files:read", "files:write"}


class ControlError(ValueError):
    pass


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class GrantStore:
    def __init__(self, state_path: Path, key_path: Path):
        self.state_path = state_path
        self.key_path = key_path
        self.lock = threading.RLock()
        self.key = self._load_key()
        self.grants: dict[str, dict[str, Any]] = self._load_state()

    def _load_key(self) -> bytes:
        if self.key_path.is_file():
            key = self.key_path.read_bytes()
            if len(key) == 32:
                return key
            raise ControlError("control signing key must contain exactly 32 bytes")
        self.key_path.parent.mkdir(parents=True, exist_ok=True)
        key = secrets.token_bytes(32)
        self.key_path.write_bytes(key)
        return key

    def _load_state(self) -> dict[str, dict[str, Any]]:
        if not self.state_path.is_file():
            return {}
        data = json.loads(self.state_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}

    def _save_state(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.grants, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
        temporary.replace(self.state_path)

    @staticmethod
    def _binding(value: Any) -> dict[str, Any]:
        if not isinstance(value, dict) or set(value) != {"host", "port", "username", "fingerprint"}:
            raise ControlError("binding requires host, port, username, and fingerprint")
        if not isinstance(value["host"], str) or not 1 <= len(value["host"]) <= 255:
            raise ControlError("binding host is invalid")
        if not isinstance(value["port"], int) or not 1 <= value["port"] <= 65535:
            raise ControlError("binding port is invalid")
        if not isinstance(value["username"], str) or not 1 <= len(value["username"]) <= 64:
            raise ControlError("binding username is invalid")
        if not isinstance(value["fingerprint"], str) or not value["fingerprint"].startswith("SHA256:"):
            raise ControlError("binding fingerprint is invalid")
        return dict(value)

    def grant(self, binding: Any, scopes: Any, ttl_seconds: Any) -> dict[str, Any]:
        binding = self._binding(binding)
        if not isinstance(scopes, list) or not scopes or any(scope not in SCOPES for scope in scopes):
            raise ControlError("scopes contain an unsupported permission")
        if not isinstance(ttl_seconds, int) or not 60 <= ttl_seconds <= 86400:
            raise ControlError("ttl_seconds must be between 60 and 86400")
        now = int(time.time())
        grant_id = secrets.token_urlsafe(18)
        payload = {"jti": grant_id, "binding": binding, "scopes": sorted(set(scopes)), "exp": now + ttl_seconds}
        encoded = _b64(json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8"))
        signature = _b64(hmac.new(self.key, encoded.encode("ascii"), hashlib.sha256).digest())
        with self.lock:
            self.grants[grant_id] = {"binding": binding, "scopes": payload["scopes"], "exp": payload["exp"], "revoked": False}
            self._save_state()
        return {"grant_id": grant_id, "token": encoded + "." + signature, "expires_at": payload["exp"], "scopes": payload["scopes"]}

    def verify(self, token: Any, binding: Any, scope: str | None = None) -> dict[str, Any]:
        if not isinstance(token, str) or token.count(".") != 1:
            raise ControlError("invalid capability token")
        encoded, signature = token.split(".")
        expected = _b64(hmac.new(self.key, encoded.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise ControlError("invalid capability signature")
        payload = json.loads(_unb64(encoded).decode("utf-8"))
        checked_binding = self._binding(binding)
        with self.lock:
            grant = self.grants.get(payload.get("jti"))
        if not grant or grant.get("revoked") or int(payload.get("exp", 0)) <= int(time.time()) or grant["binding"] != checked_binding:
            raise ControlError("capability is expired, revoked, or bound to another session")
        if scope is not None and scope not in grant["scopes"]:
            raise ControlError("capability does not include the requested scope")
        return payload

    def authorize_binding(self, binding: Any) -> dict[str, Any] | None:
        checked = self._binding(binding)
        now = int(time.time())
        with self.lock:
            candidates = [
                {"grant_id": grant_id, **grant}
                for grant_id, grant in self.grants.items()
                if not grant.get("revoked") and int(grant.get("exp", 0)) > now and grant.get("binding") == checked
            ]
        return max(candidates, key=lambda item: item["exp"]) if candidates else None

    def revoke(self, grant_id: Any) -> None:
        if not isinstance(grant_id, str):
            raise ControlError("grant_id is required")
        with self.lock:
            grant = self.grants.get(grant_id)
            if grant is None:
                raise KeyError("unknown grant")
            grant["revoked"] = True
            self._save_state()


class ControlServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: GrantStore):
        super().__init__(address, ControlHandler)
        self.store = store
        self.authority = f"127.0.0.1:{self.server_port}"


class ControlHandler(BaseHTTPRequestHandler):
    server: ControlServer
    protocol_version = "HTTP/1.1"
    server_version = "BridgeControl"
    sys_version = ""

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.end_headers()
        self.wfile.write(body)

    def _local(self) -> bool:
        return self.headers.get("Host", "").lower() == self.server.authority

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if not 1 <= length <= 32768:
            raise ControlError("request body is invalid")
        data = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(data, dict):
            raise ControlError("request body must be an object")
        return data

    def _internal(self) -> bool:
        supplied = self.headers.get("X-Control-Key", "")
        return hmac.compare_digest(supplied, self.server.store.key.hex())

    def do_GET(self) -> None:
        if not self._local():
            self._json({"error": "loopback only"}, HTTPStatus.MISDIRECTED_REQUEST)
            return
        if self.path == "/api/v1/health":
            self._json({"ok": True, "mode": "authorization-control-plane"})
        else:
            self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        if not self._local() or not self._internal():
            self._json({"error": "control-plane authorization required"}, HTTPStatus.FORBIDDEN)
            return
        try:
            data = self._body()
            if self.path == "/api/v1/grants":
                self._json(self.server.store.grant(data.get("binding"), data.get("scopes"), data.get("ttl_seconds", 1800)), HTTPStatus.CREATED)
            elif self.path == "/api/v1/authorize":
                result = self.server.store.authorize_binding(data.get("binding"))
                self._json({"authorized": result is not None, "grant": result})
            elif self.path == "/api/v1/verify":
                self._json({"authorized": True, "claims": self.server.store.verify(data.get("token"), data.get("binding"), data.get("scope"))})
            elif self.path == "/api/v1/revoke":
                self.server.store.revoke(data.get("grant_id"))
                self._json({"revoked": True})
            else:
                self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except KeyError as exc:
            self._json({"error": str(exc).strip("'\"")}, HTTPStatus.NOT_FOUND)
        except (ValueError, ControlError, json.JSONDecodeError) as exc:
            self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception:
            self._json({"error": "internal control-plane error"}, HTTPStatus.INTERNAL_SERVER_ERROR)


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8878)
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).with_name("data"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = make_parser().parse_args(argv)
    if not 1024 <= args.port <= 65535:
        print("error: --port must be between 1024 and 65535")
        return 2
    try:
        store = GrantStore(args.data_dir / "control_grants.json", args.data_dir / "control_signing.key")
        server = ControlServer(("127.0.0.1", args.port), store)
    except (OSError, ControlError, json.JSONDecodeError) as exc:
        print(f"error: {exc}")
        return 2
    print(json.dumps({"ok": True, "url": f"http://127.0.0.1:{server.server_port}/", "mode": "authorization-control-plane"}), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
