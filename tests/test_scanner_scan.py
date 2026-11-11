"""Unit tests for scan_inventory orchestrator, progress callbacks, allow-list, and CLI commands."""

import io
import json
import logging
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from agent.cli import main
from agent.config import ALLOWED_OPERATIONS, is_operation_allowed
from agent.scanner.models import InstalledApp, ScanResult
from agent.scanner.registry import FakeRegistryBackend
from agent.scanner.scan import OPERATION_NAME, scan_inventory


class TestOperationAllowList(unittest.TestCase):
    """Test operation allow-list registration and verification."""

    def test_scan_inventory_in_allow_list(self):
        self.assertIn(OPERATION_NAME, ALLOWED_OPERATIONS)
        self.assertTrue(is_operation_allowed("scan_inventory"))
        self.assertTrue(is_operation_allowed("check_updates"))
        self.assertTrue(is_operation_allowed("apply_update"))

    def test_unauthorized_operation_rejected(self):
        self.assertFalse(is_operation_allowed("uninstall_package"))
        self.assertFalse(is_operation_allowed("format_drive"))
        self.assertFalse(is_operation_allowed("arbitrary_exec"))


class TestScanInventoryOrchestrator(unittest.TestCase):
    """Test full workflow, failure modes, progress callbacks, and log privacy."""

    @patch("agent.scanner.scan.list_installed")
    @patch("agent.scanner.scan.get_winget_version")
    def test_scan_inventory_full_success(self, mock_ver, mock_list):
        mock_ver.return_value = "v1.29.380"
        mock_list.return_value = [
            InstalledApp(name="Git", version="2.44.0", package_id="Git.Git", source="winget"),
        ]
        reg_backend = FakeRegistryBackend(entries=[
            {"DisplayName": "Git for Windows", "DisplayVersion": "2.44.0", "Publisher": "The Git Community"},
            {"DisplayName": "7-Zip", "DisplayVersion": "24.09", "Publisher": "Igor Pavlov"},
        ])

        progress_records = []

        def track_progress(step, pct):
            progress_records.append((step, pct))

        result = scan_inventory(
            progress_callback=track_progress,
            registry_backend=reg_backend,
        )

        self.assertIsInstance(result, ScanResult)
        self.assertTrue(result.winget_available)
        self.assertEqual(len(result.errors), 0)
        self.assertEqual(len(result.apps), 2)  # Git (merged) + 7-Zip (reg)

        # Verify progress sequence
        step_names = [s[0] for s in progress_records]
        self.assertEqual(step_names, [
            "check_winget",
            "winget_list",
            "registry_scan",
            "enrich_publishers",
            "normalise_and_merge",
            "completed",
        ])
        percentages = [s[1] for s in progress_records]
        self.assertEqual(percentages, [10, 35, 60, 75, 90, 100])

    @patch("agent.scanner.scan.get_winget_version")
    def test_scan_inventory_winget_missing_continues_with_registry(self, mock_ver):
        mock_ver.return_value = None  # winget not available
        reg_backend = FakeRegistryBackend(entries=[
            {"DisplayName": "VLC media player", "DisplayVersion": "3.0.18", "Publisher": "VideoLAN"},
        ])

        result = scan_inventory(registry_backend=reg_backend)

        self.assertFalse(result.winget_available)
        self.assertTrue(any("WinGet executable is not available" in w for w in result.warnings))
        self.assertEqual(len(result.errors), 0)
        self.assertEqual(len(result.apps), 1)
        self.assertEqual(result.apps[0].name, "VLC media player")
        self.assertEqual(result.apps[0].source, "registry")

    @patch("agent.scanner.scan.scan_registry_installed")
    @patch("agent.scanner.scan.list_installed")
    @patch("agent.scanner.scan.get_winget_version")
    def test_scan_inventory_registry_failure_continues_with_winget(self, mock_ver, mock_list, mock_reg):
        mock_ver.return_value = "v1.29.380"
        mock_list.return_value = [
            InstalledApp(name="Node.js", version="20.11.0", package_id="OpenJS.NodeJS", source="winget"),
        ]
        mock_reg.side_effect = RuntimeError("Registry hive access corrupted")

        result = scan_inventory()

        self.assertTrue(result.winget_available)
        self.assertEqual(len(result.apps), 1)
        self.assertEqual(result.apps[0].name, "Node.js")
        self.assertTrue(any("Registry scanning failed" in e for e in result.errors))

    @patch("agent.scanner.scan.scan_registry_installed")
    @patch("agent.scanner.scan.get_winget_version")
    def test_scan_inventory_both_failing_never_crashes(self, mock_ver, mock_reg):
        mock_ver.return_value = None  # WinGet fails
        mock_reg.side_effect = OSError("Registry inaccessible")  # Registry fails

        result = scan_inventory()

        self.assertIsInstance(result, ScanResult)
        self.assertFalse(result.winget_available)
        self.assertEqual(len(result.apps), 0)
        self.assertTrue(len(result.errors) > 0)

    @patch("agent.scanner.scan.list_installed")
    @patch("agent.scanner.scan.get_winget_version")
    def test_scan_logging_counts_and_timings_only(self, mock_ver, mock_list):
        mock_ver.return_value = "v1.29.380"
        mock_list.return_value = [
            InstalledApp(name="Confidential Internal App", version="1.0", package_id="Secret.App", source="winget"),
        ]

        with self.assertLogs("agent.scanner.scan", level="INFO") as log_capture:
            scan_inventory(registry_backend=FakeRegistryBackend(entries=[]))

        output = "\n".join(log_capture.output)
        self.assertIn("Inventory scan finished in", output)
        self.assertIn("1 apps found", output)
        # Ensure private package names are NOT present in the log text
        self.assertNotIn("Confidential Internal App", output)
        self.assertNotIn("Secret.App", output)


class TestScanCliCommand(unittest.TestCase):
    """Test `agent scan --json` and `agent scan --output <file>` without pairing."""

    @patch("agent.cli.scan_inventory")
    def test_cli_scan_json_unpaired(self, mock_scan):
        mock_scan.return_value = ScanResult(
            apps=[InstalledApp(name="Git", version="2.44.0", package_id="Git.Git", source="winget")],
            started_at="2026-11-11T12:00:00Z",
            finished_at="2026-11-11T12:00:01Z",
            warnings=[],
            errors=[],
            winget_available=True,
        )

        stdout_buf = io.StringIO()
        with patch("sys.stdout", stdout_buf):
            code = main(["scan", "--json"])

        self.assertEqual(code, 0)
        parsed = json.loads(stdout_buf.getvalue())
        self.assertIn("apps", parsed)
        self.assertEqual(len(parsed["apps"]), 1)
        self.assertEqual(parsed["apps"][0]["name"], "Git")
        self.assertTrue(parsed["winget_available"])

    @patch("agent.cli.scan_inventory")
    def test_cli_scan_output_file_unpaired(self, mock_scan):
        mock_scan.return_value = ScanResult(
            apps=[InstalledApp(name="VSCode", version="1.88.0", package_id="Microsoft.VisualStudioCode", source="winget")],
            started_at="2026-11-11T12:00:00Z",
            finished_at="2026-11-11T12:00:01Z",
            warnings=[],
            errors=[],
            winget_available=True,
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            out_path = Path(tmp_dir) / "sub" / "scan_out.json"
            stdout_buf = io.StringIO()
            with patch("sys.stdout", stdout_buf):
                code = main(["scan", "--output", str(out_path)])

            self.assertEqual(code, 0)
            self.assertTrue(out_path.is_file())
            with open(out_path, "r", encoding="utf-8") as f:
                saved = json.load(f)
            self.assertEqual(len(saved["apps"]), 1)
            self.assertEqual(saved["apps"][0]["name"], "VSCode")


if __name__ == "__main__":
    unittest.main()
