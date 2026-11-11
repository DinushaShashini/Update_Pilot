"""Unit tests for agent controlled update execution and post-verification."""

import io
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, call, patch

from agent.cli import main
from agent.config import save_config
from agent.executor import (
    fetch_approved_jobs,
    process_pending_jobs,
    report_job_result,
    run_controlled_upgrade,
)


class TestAgentExecutor(unittest.TestCase):

    def setUp(self):
        self.temp_dir = TemporaryDirectory()
        self.config_path = Path(self.temp_dir.name) / "config.json"
        self.server_url = "https://app.updatepilot.com"
        self.token = "agt_executor_token_12345"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_run_controlled_upgrade_empty_package_fails(self):
        with self.assertRaises(ValueError):
            run_controlled_upgrade("")

    @patch("agent.executor.shutil.which", return_value="C:\\Program Files\\winget.exe")
    @patch("agent.executor.subprocess.run")
    def test_run_controlled_upgrade_success_and_verification(self, mock_run, mock_which):
        # First call: winget upgrade (success 0)
        # Second call: winget list (verification)
        upg_proc = MagicMock()
        upg_proc.returncode = 0
        upg_proc.stdout = "Successfully installed"
        upg_proc.stderr = ""

        verify_proc = MagicMock()
        verify_proc.returncode = 0
        verify_proc.stdout = "Name Id Version\n-----------------\nGit Git.Git 2.45.0"
        verify_proc.stderr = ""

        mock_run.side_effect = [upg_proc, verify_proc]

        res = run_controlled_upgrade("Git.Git")

        self.assertTrue(res["success"])
        self.assertTrue(res["verified"])
        self.assertEqual(res["exit_code"], 0)

        # Invariant check: strict arguments, exact matching, never shell=True
        upgrade_call_args = mock_run.call_args_list[0]
        cmd = upgrade_call_args[0][0]
        self.assertIn("--exact", cmd)
        self.assertIn("Git.Git", cmd)
        self.assertEqual(upgrade_call_args[1].get("shell"), False)

    @patch("agent.executor.shutil.which", return_value="C:\\Program Files\\winget.exe")
    @patch("agent.executor.subprocess.run")
    def test_run_controlled_upgrade_failure_handled(self, mock_run, mock_which):
        upg_proc = MagicMock()
        upg_proc.returncode = 1603  # Fatal error during installation
        upg_proc.stdout = ""
        upg_proc.stderr = "Fatal error during installation (1603)"

        mock_run.return_value = upg_proc

        res = run_controlled_upgrade("Faulty.App")

        self.assertFalse(res["success"])
        self.assertEqual(res["exit_code"], 1603)
        self.assertIn("1603", res["stderr"])

    @patch("agent.executor.shutil.which", return_value="C:\\Program Files\\winget.exe")
    @patch("agent.executor.subprocess.run")
    def test_run_controlled_upgrade_timeout_handled(self, mock_run, mock_which):
        mock_run.side_effect = subprocess.TimeoutExpired(cmd=["winget"], timeout=10)

        res = run_controlled_upgrade("Hanging.Package", timeout_seconds=10)

        self.assertFalse(res["success"])
        self.assertIn("timed out", res["stderr"])

    @patch("agent.executor.requests.get")
    def test_fetch_approved_jobs(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "success": True,
            "data": {
                "jobs": [
                    {"id": "job-1", "package_id": "Git.Git"},
                    {"id": "job-2", "package_id": "7zip.7zip"},
                ]
            },
        }
        mock_get.return_value = mock_resp

        jobs = fetch_approved_jobs(self.server_url, self.token)
        self.assertEqual(len(jobs), 2)
        self.assertEqual(jobs[0]["package_id"], "Git.Git")

    @patch("agent.executor.requests.post")
    def test_report_job_result(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_post.return_value = mock_resp

        result = {
            "success": True,
            "verified": True,
            "exit_code": 0,
            "stdout": "Installed successfully",
            "installed_version": "2.45.0",
        }

        ok = report_job_result(self.server_url, self.token, "job-1", result)
        self.assertTrue(ok)

        posted_payload = mock_post.call_args[1]["json"]
        self.assertEqual(posted_payload["status"], "SUCCEEDED")
        self.assertEqual(posted_payload["exit_code"], 0)

    @patch("agent.executor.report_job_result")
    @patch("agent.executor.run_controlled_upgrade")
    @patch("agent.executor.fetch_approved_jobs")
    def test_process_pending_jobs(self, mock_fetch, mock_upgrade, mock_report):
        mock_fetch.return_value = [{"id": "job-100", "package_id": "Git.Git"}]
        mock_upgrade.return_value = {"success": True, "verified": True, "exit_code": 0}

        save_config(
            {"server_url": self.server_url, "device_id": "dev-123"},
            config_path=self.config_path,
        )

        with patch("agent.executor.get_agent_token", return_value=self.token):
            count = process_pending_jobs(config_path=self.config_path)

        self.assertEqual(count, 1)
        mock_upgrade.assert_called_once_with(package_id="Git.Git")
        mock_report.assert_called_once()


if __name__ == "__main__":
    unittest.main()
