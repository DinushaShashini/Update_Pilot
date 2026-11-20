"""Unit tests for agent WinGet application scanner and inventory reporting."""

import io
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

from agent.cli import main
from agent.config import save_config
from agent.scanner import (
    format_scanned_inventory,
    report_scan_results,
    run_scan,
)


class TestAgentScanner(unittest.TestCase):

    def setUp(self):
        self.temp_dir = TemporaryDirectory()
        self.config_path = Path(self.temp_dir.name) / "config.json"
        self.server_url = "https://app.updatepilot.com"
        self.token = "agt_test_token_12345"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_format_scanned_inventory(self):
        sample_raw = [
            {
                "name": "Git",
                "id": "Git.Git",
                "version": "2.44.0",
                "available_version": "2.45.0",
                "source": "winget",
            },
            {
                "name": "Windows Terminal",
                "id": "Microsoft.WindowsTerminal",
                "version": "1.19.10573.0",
                "available_version": None,
                "source": "msstore",
            },
            {
                "name": "Legacy Internal Utility",
                "id": None,
                "version": "1.0.0",
                "available_version": None,
                "source": None,
            },
        ]

        formatted = format_scanned_inventory(sample_raw)
        self.assertEqual(len(formatted), 3)

        # Git: managed
        self.assertEqual(formatted[0]["name"], "Git")
        self.assertEqual(formatted[0]["package_id"], "Git.Git")
        self.assertTrue(formatted[0]["is_managed"])
        self.assertEqual(formatted[0]["available_version"], "2.45.0")

        # Terminal: managed
        self.assertEqual(formatted[1]["package_id"], "Microsoft.WindowsTerminal")
        self.assertTrue(formatted[1]["is_managed"])

        # Legacy tool: unmanaged
        self.assertEqual(formatted[2]["name"], "Legacy Internal Utility")
        self.assertFalse(formatted[2]["is_managed"])
        self.assertEqual(formatted[2]["source"], "Local")

    @patch("agent.scanner.requests.post")
    def test_report_scan_results_success(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"success": True, "data": {"scanned_count": 2}}
        mock_post.return_value = mock_resp

        apps = [
            {"name": "Git", "package_id": "Git.Git", "installed_version": "2.44.0", "source": "winget", "is_managed": True}
        ]

        res = report_scan_results(self.server_url, self.token, apps)
        self.assertTrue(res["success"])

        mock_post.assert_called_once()
        headers = mock_post.call_args[1]["headers"]
        self.assertEqual(headers["Authorization"], f"Bearer {self.token}")
        payload = mock_post.call_args[1]["json"]
        self.assertEqual(payload["packages_discovered_count"], 1)

    def test_run_scan_unpaired_fails(self):
        with patch("agent.scanner.get_agent_token", return_value=None):
            with self.assertRaises(RuntimeError) as ctx:
                run_scan(config_path=self.config_path)
            self.assertIn("not paired", str(ctx.exception).lower())

    @patch("agent.scanner.requests.post")
    def test_run_scan_with_override_success(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"success": True}
        mock_post.return_value = mock_resp

        save_config(
            {"server_url": self.server_url, "device_id": "dev-123"},
            config_path=self.config_path,
        )

        sample_apps = [
            {"name": "Git", "id": "Git.Git", "version": "2.44.0", "source": "winget", "available_version": None},
            {"name": "Local App", "id": None, "version": "1.0", "source": None, "available_version": None},
        ]

        with patch("agent.scanner.get_agent_token", return_value=self.token):
            result = run_scan(
                config_path=self.config_path,
                raw_apps_override=sample_apps,
            )

        self.assertEqual(result["total_discovered"], 2)
        self.assertEqual(result["managed_count"], 1)
        self.assertEqual(result["unmanaged_count"], 1)

    @patch("agent.cli.run_scan")
    def test_cli_scan_command_output(self, mock_run_scan):
        mock_run_scan.return_value = {
            "total_discovered": 42,
            "managed_count": 30,
            "unmanaged_count": 12,
        }

        stdout = io.StringIO()
        with patch("sys.stdout", stdout):
            code = main(["scan", "--config", str(self.config_path)])

        self.assertEqual(code, 0)
        self.assertIn("Discovered 42 installed applications", stdout.getvalue())
        self.assertIn("30 managed by WinGet/MSStore", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
