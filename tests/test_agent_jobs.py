"""Unit tests for agent job runner, polling, claiming and reporting."""

from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import MagicMock, call, patch

import requests
from requests.exceptions import ConnectionError

from agent.config import save_config
from agent.jobs import (
    ThrottledProgressReporter,
    build_agent_endpoint,
    claim_job,
    execute_single_job,
    poll_next_job,
    report_job_progress,
    run_job_polling_loop,
    submit_scan_failure,
    submit_scan_results,
)
from agent.scanner.models import InstalledApp, ScanResult


class TestAgentJobRunner(unittest.TestCase):

    def setUp(self):
        self.temp_dir = TemporaryDirectory()
        self.config_path = Path(self.temp_dir.name) / "config.json"
        self.server_url = "https://app.updatepilot.com"
        self.token = "agt_test_token_jobs_12345"

        save_config(
            {"server_url": self.server_url, "device_id": "dev-1234-uuid"},
            config_path=self.config_path,
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_build_agent_endpoint(self):
        url1 = build_agent_endpoint("https://app.updatepilot.com", "agent/jobs")
        self.assertEqual(url1, "https://app.updatepilot.com/api/agent/jobs")

        url2 = build_agent_endpoint("https://app.updatepilot.com/api", "agent/jobs/1/claim")
        self.assertEqual(url2, "https://app.updatepilot.com/api/agent/jobs/1/claim")

    # --- Polling Tests ---

    @patch("agent.jobs.requests.get")
    def test_poll_next_job_success(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "success": True,
            "data": {
                "jobs": [{"id": "job-101", "type": "scan_inventory"}],
            },
        }
        mock_get.return_value = mock_resp

        job, revoked = poll_next_job(self.server_url, self.token)
        self.assertFalse(revoked)
        self.assertIsNotNone(job)
        self.assertEqual(job["id"], "job-101")
        self.assertEqual(job["type"], "scan_inventory")

    @patch("agent.jobs.requests.get")
    def test_poll_next_job_revoked(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_get.return_value = mock_resp

        job, revoked = poll_next_job(self.server_url, self.token)
        self.assertTrue(revoked)
        self.assertIsNone(job)

    # --- Claim Tests ---

    @patch("agent.jobs.requests.post")
    def test_claim_job_success(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_post.return_value = mock_resp

        claimed, revoked = claim_job(self.server_url, self.token, "job-101")
        self.assertTrue(claimed)
        self.assertFalse(revoked)

    @patch("agent.jobs.requests.post")
    def test_claim_job_conflict_409(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 409
        mock_post.return_value = mock_resp

        claimed, revoked = claim_job(self.server_url, self.token, "job-101")
        self.assertFalse(claimed)
        self.assertFalse(revoked)

    # --- Full Execution Workflow Tests ---

    @patch("agent.jobs.submit_scan_results")
    @patch("agent.jobs.scan_inventory")
    @patch("agent.jobs.claim_job")
    def test_successful_job_workflow(self, mock_claim, mock_scan, mock_submit):
        mock_claim.return_value = (True, False)
        mock_scan.return_value = ScanResult(
            apps=[
                InstalledApp(name="App1", version="1.0.0", publisher="Pub1", package_id="Pub1.App1", source="winget"),
            ],
            started_at="2026-11-11T12:00:00Z",
            finished_at="2026-11-11T12:00:01Z",
            winget_available=True,
            warnings=[],
            errors=[],
        )
        mock_submit.return_value = (True, False)

        job = {"id": "job-success-1", "type": "scan_inventory"}
        cont = execute_single_job(
            server_url=self.server_url,
            token=self.token,
            job=job,
            config_path=self.config_path,
        )

        self.assertTrue(cont)
        mock_claim.assert_called_once_with(
            server_url=self.server_url,
            token=self.token,
            job_id="job-success-1",
        )
        mock_scan.assert_called_once()
        mock_submit.assert_called_once()
        # Verify submitted payload structure
        call_kwargs = mock_submit.call_args[1]
        payload = call_kwargs["payload"]
        self.assertEqual(len(payload["discovered_packages"]), 1)
        self.assertEqual(payload["discovered_packages"][0]["name"], "App1")

    @patch("agent.jobs.submit_scan_failure")
    @patch("agent.jobs.scan_inventory")
    @patch("agent.jobs.claim_job")
    def test_unknown_type_rejected_and_reported(self, mock_claim, mock_scan, mock_failure):
        mock_claim.return_value = (True, False)
        mock_failure.return_value = (True, False)

        job = {"id": "job-bad-type", "type": "unauthorized_remote_shell"}
        cont = execute_single_job(
            server_url=self.server_url,
            token=self.token,
            job=job,
            config_path=self.config_path,
        )

        self.assertTrue(cont)
        # Scan should never be invoked for unauthorized types
        mock_scan.assert_not_called()
        # Failure should be reported
        mock_failure.assert_called_once()
        call_kwargs = mock_failure.call_args[1]
        self.assertEqual(call_kwargs["job_id"], "job-bad-type")
        self.assertIn("Disallowed or unsupported job type", call_kwargs["error_message"])

    @patch("agent.jobs.submit_scan_failure")
    @patch("agent.jobs.scan_inventory")
    @patch("agent.jobs.claim_job")
    def test_scan_failure_when_both_sources_fail(self, mock_claim, mock_scan, mock_failure):
        mock_claim.return_value = (True, False)
        # Return ScanResult where both WinGet and registry failed
        mock_scan.return_value = ScanResult(
            apps=[],
            started_at="2026-11-11T12:00:00Z",
            finished_at="2026-11-11T12:00:01Z",
            winget_available=False,
            warnings=["WinGet missing"],
            errors=["Registry inaccessible"],
        )
        mock_failure.return_value = (True, False)

        job = {"id": "job-both-fail", "type": "scan_inventory"}
        cont = execute_single_job(
            server_url=self.server_url,
            token=self.token,
            job=job,
            config_path=self.config_path,
        )

        self.assertTrue(cont)
        mock_failure.assert_called_once()
        call_kwargs = mock_failure.call_args[1]
        self.assertEqual(call_kwargs["job_id"], "job-both-fail")
        self.assertIn("Both WinGet and Registry", call_kwargs["error_message"])

    @patch("agent.jobs.scan_inventory")
    @patch("agent.jobs.claim_job")
    def test_claim_conflict_aborts_silently(self, mock_claim, mock_scan):
        mock_claim.return_value = (False, False)  # 409 conflict

        job = {"id": "job-conflict-409", "type": "scan_inventory"}
        cont = execute_single_job(
            server_url=self.server_url,
            token=self.token,
            job=job,
            config_path=self.config_path,
        )

        self.assertTrue(cont)
        mock_scan.assert_not_called()

    @patch("agent.jobs.requests.post")
    def test_network_failure_with_retries(self, mock_post):
        mock_post.side_effect = ConnectionError("Network unreachable")

        slept_intervals = []
        fake_sleeper = lambda d: slept_intervals.append(d)

        success, revoked = submit_scan_results(
            server_url=self.server_url,
            token=self.token,
            job_id="job-retry-net",
            payload={"exit_code": 0, "discovered_packages": []},
            max_retries=3,
            base_backoff=0.5,
            sleeper=fake_sleeper,
        )

        self.assertFalse(success)
        self.assertFalse(revoked)
        # Attempt 0, retry 1, retry 2, retry 3 -> 4 calls total
        self.assertEqual(mock_post.call_count, 4)
        # 3 sleep backoffs were executed
        self.assertEqual(len(slept_intervals), 3)

    @patch("agent.jobs.handle_revocation")
    @patch("agent.jobs.claim_job")
    def test_revoked_mid_job(self, mock_claim, mock_handle_revocation):
        mock_claim.return_value = (False, True)  # 401 Revoked

        job = {"id": "job-revoked", "type": "scan_inventory"}
        cont = execute_single_job(
            server_url=self.server_url,
            token=self.token,
            job=job,
            config_path=self.config_path,
        )

        self.assertFalse(cont)  # Halts loop
        mock_handle_revocation.assert_called_once_with(config_path=self.config_path)

    # --- Throttled Progress Reporter Tests ---

    @patch("agent.jobs.report_job_progress")
    def test_throttled_progress_reporter(self, mock_report):
        mock_report.return_value = (True, False)

        reporter = ThrottledProgressReporter(
            server_url=self.server_url,
            token=self.token,
            job_id="job-throttle-test",
            min_interval_seconds=1.0,
        )

        # First call at 10% reports immediately
        reporter("check_winget", 10)
        self.assertEqual(mock_report.call_count, 1)

        # Immediate second call at 35% is throttled (skipped)
        reporter("winget_list", 35)
        self.assertEqual(mock_report.call_count, 1)

        # Call at 100% (completion) always reports
        reporter("complete", 100)
        self.assertEqual(mock_report.call_count, 2)

    # --- Polling Loop Tests ---

    @patch("agent.jobs.execute_single_job")
    @patch("agent.jobs.poll_next_job")
    def test_run_job_polling_loop_runs_and_exits(self, mock_poll, mock_exec):
        mock_poll.return_value = ({"id": "job-loop-1", "type": "scan_inventory"}, False)
        mock_exec.return_value = True

        stop_event = threading.Event()
        run_job_polling_loop(
            server_url=self.server_url,
            token=self.token,
            interval_seconds=0.1,
            shutdown_event=stop_event,
            max_iterations=1,
            sleeper=lambda _: None,
        )

        mock_poll.assert_called_once()
        mock_exec.assert_called_once()


if __name__ == "__main__":
    unittest.main()
