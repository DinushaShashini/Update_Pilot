"""Unit tests for agent periodic heartbeat loop and credential revocation handling."""

import logging
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, call, patch

import requests

from agent.cli import main
from agent.config import load_config, save_config
from agent.heartbeat import (
    ConnectionState,
    HeartbeatResult,
    calculate_backoff_delay,
    handle_revocation,
    run_heartbeat_loop,
    send_single_heartbeat,
)
from agent.storage import KEYRING_SERVICE_NAME, KEYRING_USERNAME


class TestAgentHeartbeat(unittest.TestCase):

    def setUp(self):
        self.temp_dir = TemporaryDirectory()
        self.config_path = Path(self.temp_dir.name) / "config.json"
        self.server_url = "https://app.updatepilot.com"
        self.token = "agt_test_token_abcdef123456"

    def tearDown(self):
        self.temp_dir.cleanup()

    # --- Backoff and Jitter Calculation Tests ---

    def test_calculate_backoff_delay_exponential(self):
        delay1 = calculate_backoff_delay(1, base_interval=5.0, max_interval=60.0)
        delay2 = calculate_backoff_delay(2, base_interval=5.0, max_interval=60.0)
        delay3 = calculate_backoff_delay(3, base_interval=5.0, max_interval=60.0)

        # Base increases: 5 * 2^0 = 5, 5 * 2^1 = 10, 5 * 2^2 = 20
        self.assertGreaterEqual(delay1, 5.0)
        self.assertGreaterEqual(delay2, 10.0)
        self.assertGreaterEqual(delay3, 20.0)
        self.assertLess(delay1, delay2)
        self.assertLess(delay2, delay3)

    def test_calculate_backoff_caps_at_max_interval(self):
        delay = calculate_backoff_delay(10, base_interval=5.0, max_interval=60.0)
        # Should not exceed max_interval + max jitter (3.0)
        self.assertLessEqual(delay, 63.5)

    # --- Single Heartbeat Tests ---

    @patch("agent.heartbeat.requests.post")
    def test_send_single_heartbeat_success(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_post.return_value = mock_resp

        result = send_single_heartbeat(self.server_url, self.token)
        self.assertEqual(result, HeartbeatResult.SUCCESS)

        # Verify Authorization header contains Bearer token
        mock_post.assert_called_once()
        headers = mock_post.call_args[1]["headers"]
        self.assertEqual(headers["Authorization"], f"Bearer {self.token}")
        # Verify request timeout is present
        self.assertIn("timeout", mock_post.call_args[1])
        self.assertGreater(mock_post.call_args[1]["timeout"], 0)

    @patch("agent.heartbeat.requests.post")
    def test_send_single_heartbeat_401_revoked(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_post.return_value = mock_resp

        result = send_single_heartbeat(self.server_url, self.token)
        self.assertEqual(result, HeartbeatResult.REVOKED)

    @patch("agent.heartbeat.requests.post")
    def test_send_single_heartbeat_network_failure(self, mock_post):
        mock_post.side_effect = requests.exceptions.ConnectionError("Connection refused")

        result = send_single_heartbeat(self.server_url, self.token)
        self.assertEqual(result, HeartbeatResult.FAILURE)

    # --- Heartbeat Loop and Connection State Changes Logging ---

    @patch("agent.heartbeat.send_single_heartbeat")
    def test_heartbeat_loop_logs_connection_state_changes_only(self, mock_heartbeat):
        # Sequence: SUCCESS (connected), SUCCESS (silent), FAILURE (lost), FAILURE (silent), SUCCESS (restored)
        mock_heartbeat.side_effect = [
            HeartbeatResult.SUCCESS,
            HeartbeatResult.SUCCESS,
            HeartbeatResult.FAILURE,
            HeartbeatResult.FAILURE,
            HeartbeatResult.SUCCESS,
        ]

        logger = logging.getLogger("agent.heartbeat")
        sleep_durations = []

        def fake_sleep(duration):
            sleep_durations.append(duration)

        with self.assertLogs(logger, level=logging.INFO) as log_ctx:
            run_heartbeat_loop(
                server_url=self.server_url,
                token=self.token,
                interval_seconds=30.0,
                max_iterations=5,
                sleeper=fake_sleep,
            )

        messages = [record.getMessage() for record in log_ctx.records]

        # Should log "Connected" once on initial success
        connected_logs = [m for m in messages if "Connected to server" in m]
        self.assertEqual(len(connected_logs), 1)

        # Should log "Connection lost" once on initial failure
        lost_logs = [m for m in messages if "Connection lost" in m]
        self.assertEqual(len(lost_logs), 1)

        # Should log "Connection restored" once when connection recovers
        restored_logs = [m for m in messages if "Connection restored" in m]
        self.assertEqual(len(restored_logs), 1)

        # Backoff sleep was applied during failures
        self.assertEqual(len(sleep_durations), 5)

    # --- Revocation Handling Tests ---

    @patch("agent.heartbeat.delete_agent_token")
    @patch("agent.heartbeat.send_single_heartbeat")
    def test_heartbeat_loop_handles_revocation_401(self, mock_heartbeat, mock_delete_token):
        # Save initial config with device_id
        save_config(
            {"server_url": self.server_url, "device_id": "device-to-revoke-123"},
            config_path=self.config_path,
        )

        mock_heartbeat.return_value = HeartbeatResult.REVOKED
        logger = logging.getLogger("agent.heartbeat")

        with self.assertLogs(logger, level=logging.WARNING) as log_ctx:
            run_heartbeat_loop(
                server_url=self.server_url,
                token=self.token,
                config_path=self.config_path,
                max_iterations=10,  # Should exit immediately on first call, not loop
            )

        # Must exit after exactly 1 call (no retrying in a loop)
        self.assertEqual(mock_heartbeat.call_count, 1)

        # Must remove token and clear device_id
        mock_delete_token.assert_called_once()
        cfg = load_config(self.config_path)
        self.assertIsNone(cfg.get("device_id"))

        # Must log clear message without leaking token
        messages = " ".join([r.getMessage() for r in log_ctx.records])
        self.assertIn("revoked", messages.lower())
        self.assertNotIn(self.token, messages)

    # --- CLI Run Integration Tests ---

    @patch("agent.cli.get_agent_token")
    def test_run_fails_if_unpaired(self, mock_get_token):
        mock_get_token.return_value = None

        code = main(["run", "--config", str(self.config_path)])
        self.assertEqual(code, 1)

    @patch("agent.cli.run_heartbeat_loop")
    @patch("agent.cli.get_agent_token")
    def test_run_success_when_paired(self, mock_get_token, mock_loop):
        save_config(
            {"server_url": self.server_url, "device_id": "dev-123"},
            config_path=self.config_path,
        )
        mock_get_token.return_value = self.token

        code = main([
            "run",
            "--interval", "15",
            "--config", str(self.config_path),
        ])

        self.assertEqual(code, 0)
        mock_loop.assert_called_once()
        self.assertEqual(mock_loop.call_args[1]["interval_seconds"], 15.0)

    # --- Clean Shutdown Tests ---

    @patch("agent.heartbeat.send_single_heartbeat")
    def test_clean_shutdown_on_event(self, mock_heartbeat):
        mock_heartbeat.return_value = HeartbeatResult.SUCCESS
        shutdown_event = threading.Event()

        # Stop after 2 heartbeats
        call_count = 0

        def fake_sleep(_):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                shutdown_event.set()

        run_heartbeat_loop(
            server_url=self.server_url,
            token=self.token,
            shutdown_event=shutdown_event,
            sleeper=fake_sleep,
        )

        self.assertEqual(call_count, 2)


if __name__ == "__main__":
    unittest.main()
