"""Unit tests for scanner data models and safe command runner."""

import subprocess
import unittest
from unittest.mock import MagicMock, patch

from agent.scanner.models import InstalledApp, ScanResult
from agent.scanner.runner import CommandResult, run_command


class TestScannerModels(unittest.TestCase):
    """Test InstalledApp and ScanResult data models."""

    def test_installed_app_model(self):
        app = InstalledApp(
            name="7-Zip",
            version="24.09",
            publisher="Igor Pavlov",
            package_id="7zip.7zip",
            source="winget",
            raw_name="7-Zip 24.09 (x64)",
        )
        self.assertEqual(app.name, "7-Zip")
        self.assertEqual(app.version, "24.09")
        self.assertEqual(app.publisher, "Igor Pavlov")
        self.assertEqual(app.package_id, "7zip.7zip")
        self.assertEqual(app.source, "winget")

        d = app.to_dict()
        self.assertEqual(d["name"], "7-Zip")
        self.assertEqual(d["package_id"], "7zip.7zip")
        self.assertEqual(d["source"], "winget")

    def test_scan_result_model(self):
        app = InstalledApp(
            name="Git",
            version="2.44.0",
            package_id="Git.Git",
            source="winget",
        )
        scan = ScanResult(
            apps=[app],
            started_at="2026-11-11T10:00:00Z",
            finished_at="2026-11-11T10:00:05Z",
            warnings=["Package X has non-standard version"],
            errors=[],
            winget_available=True,
        )
        self.assertTrue(scan.winget_available)
        self.assertEqual(len(scan.apps), 1)

        d = scan.to_dict()
        self.assertEqual(len(d["apps"]), 1)
        self.assertEqual(d["apps"][0]["name"], "Git")
        self.assertTrue(d["winget_available"])
        self.assertEqual(d["warnings"], ["Package X has non-standard version"])


class TestSafeCommandRunner(unittest.TestCase):
    """Test safe command execution, argument lists, timeouts, and error handling."""

    @patch("subprocess.run")
    def test_run_command_success(self, mock_run):
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = b"Hello from command\n"
        mock_proc.stderr = b""
        mock_run.return_value = mock_proc

        res = run_command(["echo", "hello"], timeout=10)

        self.assertIsInstance(res, CommandResult)
        self.assertEqual(res.exit_code, 0)
        self.assertIn("Hello from command", res.output)
        self.assertEqual(res.error_output, "")
        self.assertFalse(res.timed_out)
        self.assertIsNone(res.error)

        # Verify tuple unpacking
        code, out, timed_out = res
        self.assertEqual(code, 0)
        self.assertIn("Hello from command", out)
        self.assertFalse(timed_out)

        mock_run.assert_called_once_with(
            ["echo", "hello"],
            shell=False,
            capture_output=True,
            timeout=10,
        )

    @patch("subprocess.run")
    def test_run_command_nonzero_exit(self, mock_run):
        mock_proc = MagicMock()
        mock_proc.returncode = 1
        mock_proc.stdout = b""
        mock_proc.stderr = b"Fatal: invalid parameter\n"
        mock_run.return_value = mock_proc

        res = run_command(["winget", "invalid"], timeout=15)

        self.assertEqual(res.exit_code, 1)
        self.assertFalse(res.timed_out)
        self.assertIn("Fatal: invalid parameter", res.error_output)
        self.assertIsNotNone(res.error)

    @patch("subprocess.run")
    def test_run_command_timeout(self, mock_run):
        mock_run.side_effect = subprocess.TimeoutExpired(
            cmd=["long_running"],
            timeout=5,
            output=b"partial output",
            stderr=b"timeout occurred",
        )

        res = run_command(["long_running"], timeout=5)

        self.assertEqual(res.exit_code, -1)
        self.assertTrue(res.timed_out)
        self.assertIn("partial output", res.output)
        self.assertIn("timed out after 5 seconds", res.error)

    @patch("subprocess.run")
    def test_run_command_missing_executable(self, mock_run):
        mock_run.side_effect = FileNotFoundError(2, "No such file or directory")

        res = run_command(["nonexistent_binary", "--help"], timeout=5)

        self.assertEqual(res.exit_code, -1)
        self.assertFalse(res.timed_out)
        self.assertEqual(res.error, "command not found")
        self.assertIn("executable not found", res.error_output)

    @patch("subprocess.run")
    def test_run_command_oversized_output_capped(self, mock_run):
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = b"A" * 500
        mock_proc.stderr = b"B" * 200
        mock_run.return_value = mock_proc

        res = run_command(["large_stream"], timeout=5, max_output_bytes=50)

        self.assertEqual(res.exit_code, 0)
        self.assertEqual(len(res.output), 50)
        self.assertEqual(res.output, "A" * 50)
        self.assertEqual(len(res.error_output), 50)
        self.assertEqual(res.error_output, "B" * 50)

    def test_run_command_rejects_raw_shell_string(self):
        res = run_command("winget list --all")
        self.assertEqual(res.exit_code, -1)
        self.assertIn("shell string rejected", res.error)

    def test_run_command_rejects_empty_args(self):
        res = run_command([])
        self.assertEqual(res.exit_code, -1)
        self.assertEqual(res.error, "invalid command arguments")


if __name__ == "__main__":
    unittest.main()
