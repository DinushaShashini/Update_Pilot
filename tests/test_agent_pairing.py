"""Unit tests for agent pairing CLI, secure token storage, and unpairing."""

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import requests

from agent.cli import main
from agent.config import load_config, save_config
from agent.pairing import (
    ExpiredCodeError,
    InsecureServerError,
    InvalidCodeError,
    NetworkError,
    TLSError,
    build_pair_endpoint_url,
    validate_server_url,
)
from agent.storage import KEYRING_SERVICE_NAME, KEYRING_USERNAME


class TestAgentPairing(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_path = Path(self.temp_dir.name) / "config.json"

    def tearDown(self):
        self.temp_dir.cleanup()

    # --- URL Validation Tests ---

    def test_validate_server_url_enforces_https_for_remote(self):
        with self.assertRaises(InsecureServerError) as ctx:
            validate_server_url("http://updatepilot.example.com")
        self.assertIn("HTTPS", str(ctx.exception))

    def test_validate_server_url_permits_https_remote(self):
        cleaned = validate_server_url("https://updatepilot.example.com/")
        self.assertEqual(cleaned, "https://updatepilot.example.com")

    def test_validate_server_url_permits_localhost_http(self):
        self.assertEqual(validate_server_url("http://localhost:3000"), "http://localhost:3000")
        self.assertEqual(validate_server_url("http://127.0.0.1:8080/"), "http://127.0.0.1:8080")
        self.assertEqual(validate_server_url("http://[::1]:5000"), "http://[::1]:5000")

    def test_build_pair_endpoint_url(self):
        self.assertEqual(
            build_pair_endpoint_url("https://dashboard.example.com"),
            "https://dashboard.example.com/api/agent/pair",
        )
        self.assertEqual(
            build_pair_endpoint_url("https://dashboard.example.com/api"),
            "https://dashboard.example.com/api/agent/pair",
        )

    # --- Pairing Success Tests ---

    @patch("agent.storage.keyring.set_password")
    @patch("agent.pairing.requests.post")
    def test_pair_success_with_code_argument(self, mock_post, mock_keyring_set):
        secret_code = "PAIR-CODE-9999"
        secret_token = "agt_secret_token_123456789"
        device_uuid = "11111111-2222-3333-4444-555555555555"

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "success": True,
            "data": {
                "device_id": device_uuid,
                "agent_token": secret_token,
            },
        }
        mock_post.return_value = mock_resp

        stdout = io.StringIO()
        stderr = io.StringIO()

        with patch("sys.stdout", stdout), patch("sys.stderr", stderr):
            code = main([
                "pair",
                "--server", "https://app.updatepilot.com",
                "--code", secret_code,
                "--config", str(self.config_path),
            ])

        self.assertEqual(code, 0)
        self.assertIn("Successfully paired device", stdout.getvalue())

        # Verify token saved to keyring
        mock_keyring_set.assert_called_once_with(KEYRING_SERVICE_NAME, KEYRING_USERNAME, secret_token)

        # Verify config saved ONLY server_url and device_id
        config = load_config(self.config_path)
        self.assertEqual(config.get("server_url"), "https://app.updatepilot.com")
        self.assertEqual(config.get("device_id"), device_uuid)

        # Strictly verify no secret is in config file
        with open(self.config_path, "r", encoding="utf-8") as f:
            raw_config = f.read()
        self.assertNotIn(secret_token, raw_config)
        self.assertNotIn(secret_code, raw_config)

        # Verify stdout / stderr NEVER printed the secret token or code
        self.assertNotIn(secret_token, stdout.getvalue())
        self.assertNotIn(secret_code, stdout.getvalue())
        self.assertNotIn(secret_token, stderr.getvalue())
        self.assertNotIn(secret_code, stderr.getvalue())

    @patch("agent.cli.prompt_pairing_code")
    @patch("agent.storage.keyring.set_password")
    @patch("agent.pairing.requests.post")
    def test_pair_prompts_code_when_omitted(self, mock_post, mock_keyring_set, mock_prompt):
        secret_code = "PROMPTED-SECRET-CODE"
        mock_prompt.return_value = secret_code

        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {
            "success": True,
            "data": {
                "device_id": "dev-001",
                "agent_token": "token-xyz",
            },
        }
        mock_post.return_value = mock_resp

        stdout = io.StringIO()
        with patch("sys.stdout", stdout):
            code = main([
                "pair",
                "--server", "http://localhost:3000",
                "--config", str(self.config_path),
            ])

        self.assertEqual(code, 0)
        mock_prompt.assert_called_once()
        # Ensure post received the prompted code
        post_json = mock_post.call_args[1]["json"]
        self.assertEqual(post_json["code"], secret_code)

    @patch("agent.cli.prompt_pairing_code")
    def test_pair_empty_code_fails(self, mock_prompt):
        mock_prompt.return_value = ""

        stderr = io.StringIO()
        with patch("sys.stderr", stderr):
            code = main([
                "pair",
                "--server", "http://localhost:3000",
                "--config", str(self.config_path),
            ])

        self.assertEqual(code, 1)
        self.assertIn("Pairing code is required", stderr.getvalue())

    # --- Error Handling Tests ---

    @patch("agent.pairing.requests.post")
    def test_pair_enforces_https_blocks_remote_http(self, mock_post):
        stderr = io.StringIO()
        with patch("sys.stderr", stderr):
            code = main([
                "pair",
                "--server", "http://insecure-server.com",
                "--code", "code123",
                "--config", str(self.config_path),
            ])

        self.assertEqual(code, 1)
        self.assertIn("Server URL must use HTTPS", stderr.getvalue())
        mock_post.assert_not_called()

    @patch("agent.pairing.requests.post")
    def test_pair_handles_expired_code(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 403
        mock_resp.json.return_value = {
            "success": False,
            "error": {
                "code": "TOKEN_EXPIRED",
                "message": "The pairing token has expired.",
            },
        }
        mock_post.return_value = mock_resp

        stderr = io.StringIO()
        with patch("sys.stderr", stderr):
            code = main([
                "pair",
                "--server", "https://app.updatepilot.com",
                "--code", "expired-code-123",
                "--config", str(self.config_path),
            ])

        self.assertEqual(code, 1)
        self.assertIn("expired", stderr.getvalue().lower())

    @patch("agent.pairing.requests.post")
    def test_pair_handles_invalid_code(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.json.return_value = {
            "success": False,
            "error": {
                "code": "INVALID_PAIRING_CODE",
                "message": "Invalid pairing code provided.",
            },
        }
        mock_post.return_value = mock_resp

        stderr = io.StringIO()
        with patch("sys.stderr", stderr):
            code = main([
                "pair",
                "--server", "https://app.updatepilot.com",
                "--code", "wrong-code",
                "--config", str(self.config_path),
            ])

        self.assertEqual(code, 1)
        self.assertIn("Invalid", stderr.getvalue())

    @patch("agent.pairing.requests.post")
    def test_pair_handles_tls_error(self, mock_post):
        mock_post.side_effect = requests.exceptions.SSLError("Self-signed certificate")

        stderr = io.StringIO()
        with patch("sys.stderr", stderr):
            code = main([
                "pair",
                "--server", "https://untrusted.updatepilot.com",
                "--code", "some-code",
                "--config", str(self.config_path),
            ])

        self.assertEqual(code, 1)
        self.assertIn("TLS/SSL error", stderr.getvalue())

    @patch("agent.pairing.requests.post")
    def test_pair_handles_network_error(self, mock_post):
        mock_post.side_effect = requests.exceptions.ConnectionError("Failed to establish a new connection")

        stderr = io.StringIO()
        with patch("sys.stderr", stderr):
            code = main([
                "pair",
                "--server", "https://offline.updatepilot.com",
                "--code", "some-code",
                "--config", str(self.config_path),
            ])

        self.assertEqual(code, 1)
        self.assertIn("Network error", stderr.getvalue())

    # --- Unpair Tests ---

    @patch("agent.storage.keyring.delete_password")
    def test_unpair_clears_device_id_and_deletes_token(self, mock_keyring_del):
        # Prepopulate config with server_url and device_id
        save_config(
            {"server_url": "https://app.updatepilot.com", "device_id": "paired-device-123"},
            config_path=self.config_path,
        )

        stdout = io.StringIO()
        with patch("sys.stdout", stdout):
            code = main([
                "unpair",
                "--config", str(self.config_path),
            ])

        self.assertEqual(code, 0)
        self.assertIn("unpaired", stdout.getvalue().lower())

        # Verify keyring deletion called
        mock_keyring_del.assert_called_once_with(KEYRING_SERVICE_NAME, KEYRING_USERNAME)

        # Verify device_id is cleared from config
        config = load_config(self.config_path)
        self.assertIsNone(config.get("device_id"))
        self.assertEqual(config.get("server_url"), "https://app.updatepilot.com")

    def test_save_config_forbids_secret_fields(self):
        with self.assertRaises(ValueError):
            save_config({"agent_token": "secret"}, config_path=self.config_path)

        with self.assertRaises(ValueError):
            save_config({"code": "secret"}, config_path=self.config_path)


if __name__ == "__main__":
    unittest.main()
