"""End-to-End integration tests for agent pairing, heartbeat, status updates, and revocation.

Runs the complete flow with real agent code against a local test backend:
1. Generate pairing code
2. Pair agent (CLI and API)
3. Send periodic heartbeat
4. Verify device shows Online in devices list
5. Revoke device
6. Confirm subsequent heartbeat is rejected (401 REVOKED)
7. Test expired, reused, and wrong pairing codes
"""

import http.server
import json
import threading
import time
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict
from unittest.mock import MagicMock, patch
from urllib.parse import urlparse

import requests

from agent.cli import run_pair
from agent.config import load_config
from agent.heartbeat import HeartbeatResult, run_heartbeat_loop, send_single_heartbeat
from agent.pairing import ExpiredCodeError, InvalidCodeError, call_pair_endpoint
from agent.storage import KEYRING_SERVICE_NAME, KEYRING_USERNAME


class TestBackendHandler(http.server.BaseHTTPRequestHandler):
    """Mock backend server handling real agent endpoints for E2E testing."""

    # Server-wide in-memory database
    pairing_codes: Dict[str, Dict[str, Any]] = {}
    devices: Dict[str, Dict[str, Any]] = {}
    tokens: Dict[str, Dict[str, Any]] = {}

    @classmethod
    def reset_db(cls):
        cls.pairing_codes.clear()
        cls.devices.clear()
        cls.tokens.clear()

    def _send_json(self, status: int, data: Any):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        # Silence HTTP server logs during tests
        pass

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # Read JSON body if present
        content_length = int(self.headers.get("Content-Length", 0))
        body = {}
        if content_length > 0:
            try:
                body = json.loads(self.rfile.read(content_length).decode("utf-8"))
            except Exception:
                body = {}

        # 1. POST /api/devices/pairing-token
        if path in ("/api/devices/pairing-token", "/api/v1/devices/pairing-token"):
            token_str = f"tok_{uuid.uuid4().hex[:16]}"
            expires_in = body.get("expires_in_seconds", 900)
            expires_at = time.time() + expires_in

            self.pairing_codes[token_str] = {
                "expires_at": expires_at,
                "redeemed": False,
            }

            self._send_json(201, {
                "success": True,
                "data": {
                    "pairing_token": token_str,
                    "expires_at": datetime.fromtimestamp(expires_at, timezone.utc).isoformat(),
                    "expires_in_seconds": expires_in,
                },
            })
            return

        # 2. POST /api/agent/pair
        elif path in ("/api/agent/pair", "/api/v1/agent/pair"):
            code = (body.get("code") or body.get("pairing_token") or "").strip()

            if code not in self.pairing_codes:
                self._send_json(401, {
                    "success": false if "false" in dir() else False,
                    "error": {
                        "code": "INVALID_PAIRING_CODE",
                        "message": "Invalid pairing code provided.",
                    },
                })
                return

            code_record = self.pairing_codes[code]
            if time.time() > code_record["expires_at"]:
                self._send_json(403, {
                    "success": False,
                    "error": {
                        "code": "TOKEN_EXPIRED",
                        "message": "The pairing code has expired.",
                    },
                })
                return

            if code_record["redeemed"]:
                self._send_json(403, {
                    "success": False,
                    "error": {
                        "code": "TOKEN_ALREADY_USED",
                        "message": "This pairing code has already been redeemed.",
                    },
                })
                return

            # Mark redeemed
            code_record["redeemed"] = True

            device_id = str(uuid.uuid4())
            agent_token = f"agt_{uuid.uuid4().hex}"

            hostname = body.get("hostname") or body.get("computer_name") or "TEST-PC"
            os_ver = body.get("os_version") or "Windows 11"
            agent_ver = body.get("agent_version") or "1.0.0"

            self.devices[device_id] = {
                "id": device_id,
                "name": hostname,
                "hostname": hostname,
                "os": os_ver,
                "agentVersion": agent_ver,
                "status": "OFFLINE",
                "connectionStatus": "Offline",
                "lastSeenAt": None,
                "pairedAt": datetime.now(timezone.utc).isoformat(),
            }

            self.tokens[agent_token] = {
                "device_id": device_id,
                "revoked": False,
            }

            self._send_json(201, {
                "success": True,
                "data": {
                    "device_id": device_id,
                    "agent_token": agent_token,
                    "heartbeat_interval_seconds": 30,
                    "message": "Device successfully paired.",
                },
            })
            return

        # 3. POST /api/agent/heartbeat
        elif path in ("/api/agent/heartbeat", "/api/v1/agent/heartbeat"):
            auth = self.headers.get("Authorization", "")
            if not auth.startswith("Bearer "):
                self._send_json(401, {
                    "success": False,
                    "error": {"code": "UNAUTHORIZED", "message": "Missing bearer token."},
                })
                return

            token = auth.split("Bearer ")[1].strip()
            token_rec = self.tokens.get(token)

            if not token_rec or token_rec["revoked"]:
                self._send_json(401, {
                    "success": False,
                    "error": {
                        "code": "DEVICE_REVOKED",
                        "message": "This agent pairing has been revoked by the device owner.",
                    },
                })
                return

            # Update device status
            dev_id = token_rec["device_id"]
            if dev_id in self.devices:
                now_iso = datetime.now(timezone.utc).isoformat()
                self.devices[dev_id]["status"] = "ONLINE"
                self.devices[dev_id]["connectionStatus"] = "Online"
                self.devices[dev_id]["lastSeenAt"] = now_iso

            self._send_json(200, {
                "success": True,
                "data": {
                    "acknowledged_at": datetime.now(timezone.utc).isoformat(),
                    "has_pending_jobs": False,
                },
            })
            return

        # 4. POST /api/devices/<id>/revoke
        elif "/revoke" in path:
            parts = path.strip("/").split("/")
            # Expected /api/devices/<id>/revoke
            dev_id = parts[2] if len(parts) >= 4 else None

            if dev_id and dev_id in self.devices:
                self.devices[dev_id]["status"] = "REVOKED"
                self.devices[dev_id]["connectionStatus"] = "Revoked"

                # Revoke all tokens for this device
                for t_val, t_info in self.tokens.items():
                    if t_info["device_id"] == dev_id:
                        t_info["revoked"] = True

                self._send_json(200, {
                    "success": True,
                    "data": {
                        "device_id": dev_id,
                        "status": "REVOKED",
                        "message": "Device successfully revoked.",
                    },
                })
                return

            self._send_json(404, {"success": False, "error": {"message": "Device not found."}})
            return

        self._send_json(404, {"error": "Not Found"})

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # GET /api/devices
        if path in ("/api/devices", "/api/v1/devices"):
            self._send_json(200, {
                "success": True,
                "data": list(self.devices.values()),
            })
            return

        self._send_json(404, {"error": "Not Found"})


class TestAgentEndToEndPairing(unittest.TestCase):
    """End-to-End integration tests for the full pairing lifecycle."""

    @classmethod
    def setUpClass(cls):
        TestBackendHandler.reset_db()
        cls.server = http.server.HTTPServer(("127.0.0.1", 0), TestBackendHandler)
        cls.port = cls.server.server_port
        cls.server_url = f"http://127.0.0.1:{cls.port}"

        cls.server_thread = threading.Thread(target=cls.server.serve_forever)
        cls.server_thread.daemon = True
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        TestBackendHandler.reset_db()
        self.temp_dir = TemporaryDirectory()
        self.config_path = Path(self.temp_dir.name) / "config.json"
        self.mock_keyring = {}

    def tearDown(self):
        self.temp_dir.cleanup()

    def _mock_set_password(self, service, username, password):
        self.mock_keyring[(service, username)] = password

    def _mock_get_password(self, service, username):
        return self.mock_keyring.get((service, username))

    def _mock_delete_password(self, service, username):
        self.mock_keyring.pop((service, username), None)

    # --- Full E2E Flow Test ---

    def test_full_lifecycle_flow(self):
        """Test the complete pairing, heartbeat, online detection, revoke, and rejection cycle."""

        # Step 1: Generate a pairing code from backend
        token_resp = requests.post(
            f"{self.server_url}/api/devices/pairing-token",
            json={"expires_in_seconds": 900},
            proxies={"http": None, "https": None},
        )
        self.assertEqual(token_resp.status_code, 201)
        code = token_resp.json()["data"]["pairing_token"]
        self.assertTrue(code.startswith("tok_"))

        # Step 2: Run agent pair with the generated code
        with patch("agent.storage.keyring.set_password", side_effect=self._mock_set_password):
            exit_code = run_pair(
                server_url=self.server_url,
                code=code,
                config_path=self.config_path,
            )
        self.assertEqual(exit_code, 0)

        # Verify config saved ONLY server_url and device_id
        config = load_config(self.config_path)
        self.assertEqual(config.get("server_url"), self.server_url)
        device_id = config.get("device_id")
        self.assertIsNotNone(device_id)

        # Verify token stored securely in keyring
        token = self.mock_keyring.get((KEYRING_SERVICE_NAME, KEYRING_USERNAME))
        self.assertIsNotNone(token)
        self.assertTrue(token.startswith("agt_"))

        # Step 3: Check device is listed (initially OFFLINE before heartbeat)
        dev_list_resp = requests.get(
            f"{self.server_url}/api/devices",
            proxies={"http": None, "https": None},
        )
        self.assertEqual(dev_list_resp.status_code, 200)
        devices = dev_list_resp.json()["data"]
        self.assertEqual(len(devices), 1)
        self.assertEqual(devices[0]["status"], "OFFLINE")

        # Step 4: Agent sends a heartbeat
        heartbeat_result = send_single_heartbeat(
            server_url=self.server_url,
            token=token,
        )
        self.assertEqual(heartbeat_result, HeartbeatResult.SUCCESS)

        # Step 5: Verify device is now ONLINE in the dashboard endpoint
        dev_list_resp2 = requests.get(
            f"{self.server_url}/api/devices",
            proxies={"http": None, "https": None},
        )
        devices2 = dev_list_resp2.json()["data"]
        self.assertEqual(devices2[0]["status"], "ONLINE")
        self.assertIsNotNone(devices2[0]["lastSeenAt"])

        # Step 6: Revoke device pairing via dashboard endpoint
        revoke_resp = requests.post(
            f"{self.server_url}/api/devices/{device_id}/revoke",
            json={"confirmation": "REVOKE"},
            proxies={"http": None, "https": None},
        )
        self.assertEqual(revoke_resp.status_code, 200)
        self.assertEqual(revoke_resp.json()["data"]["status"], "REVOKED")

        # Step 7: Confirm next agent heartbeat is REJECTED (401 REVOKED)
        next_heartbeat = send_single_heartbeat(
            server_url=self.server_url,
            token=token,
        )
        self.assertEqual(next_heartbeat, HeartbeatResult.REVOKED)

        # Step 8: Verify heartbeat loop handles revocation by purging credentials
        with patch("agent.storage.keyring.delete_password", side_effect=self._mock_delete_password):
            run_heartbeat_loop(
                server_url=self.server_url,
                token=token,
                config_path=self.config_path,
                max_iterations=1,
            )

        # Verify token purged from keyring and device_id cleared from config
        self.assertNotIn((KEYRING_SERVICE_NAME, KEYRING_USERNAME), self.mock_keyring)
        refreshed_config = load_config(self.config_path)
        self.assertIsNone(refreshed_config.get("device_id"))

    # --- Negative & Edge Case Tests ---

    def test_expired_code_rejected(self):
        """Verify an expired pairing code is rejected with ExpiredCodeError."""
        # Create an already expired code
        token_resp = requests.post(
            f"{self.server_url}/api/devices/pairing-token",
            json={"expires_in_seconds": -10},  # Expired 10 seconds ago
            proxies={"http": None, "https": None},
        )
        expired_code = token_resp.json()["data"]["pairing_token"]

        with self.assertRaises(ExpiredCodeError):
            call_pair_endpoint(
                server_url=self.server_url,
                code=expired_code,
            )

    def test_reused_code_rejected(self):
        """Verify a code cannot be redeemed more than once."""
        token_resp = requests.post(
            f"{self.server_url}/api/devices/pairing-token",
            json={"expires_in_seconds": 900},
            proxies={"http": None, "https": None},
        )
        code = token_resp.json()["data"]["pairing_token"]

        # First pairing succeeds
        dev_id, tok = call_pair_endpoint(server_url=self.server_url, code=code)
        self.assertTrue(dev_id)
        self.assertTrue(tok)

        # Second pairing with the same code must fail
        with self.assertRaises(InvalidCodeError):
            call_pair_endpoint(server_url=self.server_url, code=code)

    def test_wrong_code_rejected(self):
        """Verify a non-existent or wrong code is rejected."""
        with self.assertRaises(InvalidCodeError):
            call_pair_endpoint(
                server_url=self.server_url,
                code="tok_completely_fake_and_wrong_code",
            )


if __name__ == "__main__":
    unittest.main()
