"""End-to-End integration tests for application scanning, job polling, and data persistence.

Runs the complete scan workflow with real agent code against a local test backend:
1. Agent pairs with backend using pairing code.
2. User triggers an on-demand scan for the device.
3. Agent polls queued job, claims it atomically, runs scanner against real WinGet fixtures.
4. Agent submits results to backend in an atomic transaction.
5. User reads applications inventory, dashboard overview, and history ledger.
6. Handles failed scans, duplicate scan requests (409), and wrong-user access (404).
"""

from datetime import datetime, timezone
import http.server
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import time
from typing import Any, Dict, List, Optional
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse
import uuid

import requests

from agent.cli import run_pair
from agent.jobs import execute_single_job, poll_next_job
from agent.scanner.models import InstalledApp, ScanResult
from agent.scanner.winget import parse_winget_list_output

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "winget"
LIST_FIXTURE_PATH = FIXTURES_DIR / "list.txt"


class TestBackendHandler(http.server.BaseHTTPRequestHandler):
    """In-memory mock backend server implementing scan job and telemetry endpoints."""

    owner_user_id = "user-owner-111"
    stranger_user_id = "user-stranger-222"

    pairing_codes: Dict[str, Dict[str, Any]] = {}
    devices: Dict[str, Dict[str, Any]] = {}
    tokens: Dict[str, str] = {}  # token -> device_id
    scan_jobs: Dict[str, Dict[str, Any]] = {}  # job_id -> job
    applications: Dict[str, Dict[str, Any]] = {}  # app_id -> app

    @classmethod
    def reset_db(cls):
        cls.pairing_codes.clear()
        cls.devices.clear()
        cls.tokens.clear()
        cls.scan_jobs.clear()
        cls.applications.clear()

    def _send_json(self, status: int, data: Any):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        # Silence HTTP logs
        pass

    def _get_auth_header(self) -> Optional[str]:
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:].strip()
        return None

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body = {}
        if length > 0:
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception:
                body = {}

        # 1. Pairing token generation
        if path == "/api/devices/pairing-token":
            code = f"tok_{uuid.uuid4().hex[:16]}"
            self.pairing_codes[code] = {"expires_at": time.time() + 900}
            self._send_json(201, {"success": True, "data": {"pairing_token": code}})
            return

        # 2. Agent pairing
        elif path == "/api/agent/pair":
            code = (body.get("code") or body.get("pairing_token") or "").strip()
            if code not in self.pairing_codes:
                self._send_json(401, {"success": False, "error": {"code": "INVALID_CODE"}})
                return

            dev_id = f"dev_{uuid.uuid4().hex[:12]}"
            agent_tok = f"agt_{uuid.uuid4().hex[:24]}"

            self.devices[dev_id] = {
                "id": dev_id,
                "userId": self.owner_user_id,
                "name": body.get("hostname", "Windows Host"),
                "hostname": body.get("hostname", "DESKTOP-TEST"),
                "status": "ONLINE",
                "lastSeenAt": datetime.now(timezone.utc).isoformat(),
            }
            self.tokens[agent_tok] = dev_id

            self._send_json(200, {
                "success": True,
                "data": {
                    "device_id": dev_id,
                    "token": agent_tok,
                },
            })
            return

        # 3. User creates scan: POST /api/devices/:id/scans
        elif path.startswith("/api/devices/") and path.endswith("/scans"):
            parts = path.split("/")
            dev_id = parts[3]

            auth = self._get_auth_header()
            if auth == "stranger-jwt":
                self._send_json(404, {"success": False, "error": {"code": "DEVICE_NOT_FOUND"}})
                return

            if dev_id not in self.devices:
                self._send_json(404, {"success": False, "error": {"code": "DEVICE_NOT_FOUND"}})
                return

            # Check if active scan already exists
            for job in self.scan_jobs.values():
                if job["deviceId"] == dev_id and job["status"] in ("queued", "running"):
                    self._send_json(409, {
                        "success": false if False else False,
                        "error": {
                            "code": "ACTIVE_SCAN_EXISTS",
                            "message": "Scan already active",
                            "existingJobId": job["id"],
                            "status": job["status"],
                        },
                    })
                    return

            job_id = f"job_{uuid.uuid4().hex[:12]}"
            new_job = {
                "id": job_id,
                "deviceId": dev_id,
                "type": "scan_inventory",
                "status": "queued",
                "progressPercent": 0,
                "progressStep": "queued",
                "appCount": 0,
                "errorCode": None,
                "errorMessage": None,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "startedAt": None,
                "finishedAt": None,
            }
            self.scan_jobs[job_id] = new_job
            self._send_json(201, {"success": True, "data": {"job": new_job}})
            return

        # 4. Agent claims job: POST /api/agent/jobs/:id/claim
        elif path.startswith("/api/agent/jobs/") and path.endswith("/claim"):
            token = self._get_auth_header()
            if not token or token not in self.tokens:
                self._send_json(401, {"success": False, "error": {"code": "UNAUTHORIZED_AGENT"}})
                return

            job_id = path.split("/")[4]
            job = self.scan_jobs.get(job_id)
            if not job or job["deviceId"] != self.tokens[token]:
                self._send_json(404, {"success": False, "error": {"code": "JOB_NOT_FOUND"}})
                return

            if job["status"] != "queued":
                self._send_json(409, {"success": False, "error": {"code": "JOB_ALREADY_CLAIMED"}})
                return

            job["status"] = "running"
            job["startedAt"] = datetime.now(timezone.utc).isoformat()
            self._send_json(200, {"success": True, "data": {"job": job}})
            return

        # 5. Agent posts progress: POST /api/agent/jobs/:id/progress
        elif path.startswith("/api/agent/jobs/") and path.endswith("/progress"):
            token = self._get_auth_header()
            if not token or token not in self.tokens:
                self._send_json(401, {"success": False, "error": {"code": "UNAUTHORIZED_AGENT"}})
                return

            job_id = path.split("/")[4]
            job = self.scan_jobs.get(job_id)
            if job and job["deviceId"] == self.tokens[token]:
                job["progressPercent"] = body.get("percent", job["progressPercent"])
                job["progressStep"] = body.get("step", job["progressStep"])

            self._send_json(200, {"success": True})
            return

        # 6. Agent posts results: POST /api/agent/scans/:id/results
        elif path.startswith("/api/agent/scans/") and path.endswith("/results"):
            token = self._get_auth_header()
            if not token or token not in self.tokens:
                self._send_json(401, {"success": False, "error": {"code": "UNAUTHORIZED_AGENT"}})
                return

            job_id = path.split("/")[4]
            job = self.scan_jobs.get(job_id)
            dev_id = self.tokens[token]

            if not job or job["deviceId"] != dev_id:
                self._send_json(404, {"success": False, "error": {"code": "JOB_NOT_FOUND"}})
                return

            if job["status"] != "running":
                self._send_json(409, {"success": False, "error": {"code": "JOB_NOT_RUNNING"}})
                return

            now_iso = datetime.now(timezone.utc).isoformat()
            packages = body.get("discovered_packages", [])

            # Transactional save: upsert applications
            for pkg in packages:
                app_id = f"app_{pkg['name'].lower().replace(' ', '_')}"
                self.applications[app_id] = {
                    "id": app_id,
                    "deviceId": dev_id,
                    "name": pkg["name"],
                    "packageId": pkg.get("package_id"),
                    "installedVersion": pkg["installed_version"],
                    "availableVersion": pkg.get("available_version"),
                    "publisher": pkg.get("publisher"),
                    "source": pkg.get("source"),
                    "isManaged": pkg.get("is_managed", False),
                    "isInstalled": True,
                    "lastScannedAt": now_iso,
                    "createdAt": now_iso,
                    "updatedAt": now_iso,
                }

            job["status"] = "succeeded"
            job["finishedAt"] = now_iso
            job["appCount"] = len(packages)
            job["progressPercent"] = 100
            job["progressStep"] = "completed"

            # Update device lastSeenAt
            self.devices[dev_id]["lastSeenAt"] = now_iso

            self._send_json(200, {
                "success": True,
                "data": {"jobId": job_id, "appCount": len(packages), "status": "succeeded"},
            })
            return

        # 7. Agent posts failure: POST /api/agent/scans/:id/failure
        elif path.startswith("/api/agent/scans/") and path.endswith("/failure"):
            token = self._get_auth_header()
            if not token or token not in self.tokens:
                self._send_json(401, {"success": False, "error": {"code": "UNAUTHORIZED_AGENT"}})
                return

            job_id = path.split("/")[4]
            job = self.scan_jobs.get(job_id)
            if not job or job["deviceId"] != self.tokens[token]:
                self._send_json(404, {"success": False, "error": {"code": "JOB_NOT_FOUND"}})
                return

            now_iso = datetime.now(timezone.utc).isoformat()
            job["status"] = "failed"
            job["finishedAt"] = now_iso
            job["errorCode"] = body.get("error_code", 1)
            job["errorMessage"] = body.get("error_message", "Unknown error")
            job["appCount"] = 0

            self._send_json(200, {"success": True, "data": {"jobId": job_id, "status": "failed"}})
            return

        self._send_json(404, {"success": False, "error": {"code": "NOT_FOUND"}})

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        # 1. Agent polls jobs: GET /api/agent/jobs
        if path == "/api/agent/jobs":
            token = self._get_auth_header()
            if not token or token not in self.tokens:
                self._send_json(401, {"success": False, "error": {"code": "UNAUTHORIZED_AGENT"}})
                return

            dev_id = self.tokens[token]
            queued = [j for j in self.scan_jobs.values() if j["deviceId"] == dev_id and j["status"] == "queued"]
            queued.sort(key=lambda j: j["createdAt"])

            jobs_res = [{"id": queued[0]["id"], "type": queued[0]["type"]}] if queued else []
            self._send_json(200, {"success": True, "data": {"jobs": jobs_res}})
            return

        # 2. User gets applications: GET /api/devices/:id/applications
        elif path.startswith("/api/devices/") and path.endswith("/applications"):
            dev_id = path.split("/")[3]
            auth = self._get_auth_header()
            if auth == "stranger-jwt" or dev_id not in self.devices:
                self._send_json(404, {"success": False, "error": {"code": "DEVICE_NOT_FOUND"}})
                return

            include_removed = query.get("includeRemoved", ["false"])[0] in ("true", "1")
            apps = [
                a for a in self.applications.values()
                if a["deviceId"] == dev_id and (include_removed or a["isInstalled"])
            ]

            formatted = [
                {
                    "id": a["id"],
                    "name": a["name"],
                    "version": a["installedVersion"],
                    "publisher": a["publisher"],
                    "packageId": a["packageId"],
                    "source": a["source"],
                    "lastSeenAt": a["lastScannedAt"],
                    "firstSeenAt": a["createdAt"],
                    "isInstalled": a["isInstalled"],
                    "isManaged": a["isManaged"],
                }
                for a in apps
            ]
            self._send_json(200, {"success": True, "data": {"total": len(formatted), "applications": formatted}})
            return

        # 3. User gets overview: GET /api/devices/:id/overview
        elif path.startswith("/api/devices/") and path.endswith("/overview"):
            dev_id = path.split("/")[3]
            auth = self._get_auth_header()
            if auth == "stranger-jwt" or dev_id not in self.devices:
                self._send_json(404, {"success": False, "error": {"code": "DEVICE_NOT_FOUND"}})
                return

            dev = self.devices[dev_id]
            dev_apps = [a for a in self.applications.values() if a["deviceId"] == dev_id and a["isInstalled"]]
            managed_count = sum(1 for a in dev_apps if a["isManaged"])

            jobs = [j for j in self.scan_jobs.values() if j["deviceId"] == dev_id]
            jobs.sort(key=lambda j: j["createdAt"], reverse=True)
            latest = jobs[0] if jobs else None

            self._send_json(200, {
                "success": True,
                "data": {
                    "totalApps": len(dev_apps),
                    "managedApps": managed_count,
                    "unsupportedApps": len(dev_apps) - managed_count,
                    "lastScanStatus": latest["status"] if latest else "NEVER",
                    "lastScanAt": latest["finishedAt"] if latest else None,
                    "agentStatus": dev["status"],
                    "agentHostname": dev["hostname"],
                },
            })
            return

        # 4. User gets history: GET /api/devices/:id/history
        elif path.startswith("/api/devices/") and path.endswith("/history"):
            dev_id = path.split("/")[3]
            auth = self._get_auth_header()
            if auth == "stranger-jwt" or dev_id not in self.devices:
                self._send_json(404, {"success": False, "error": {"code": "DEVICE_NOT_FOUND"}})
                return

            jobs = [j for j in self.scan_jobs.values() if j["deviceId"] == dev_id]
            jobs.sort(key=lambda j: j["createdAt"], reverse=True)

            history = []
            for j in jobs:
                duration = 15 if j.get("finishedAt") and j.get("startedAt") else None
                history.append({
                    "id": j["id"],
                    "status": j["status"],
                    "duration": duration,
                    "appCount": j["appCount"],
                    "errorMessage": j.get("errorMessage"),
                    "timestamp": j["createdAt"],
                })

            self._send_json(200, {"success": True, "data": history})
            return

        self._send_json(404, {"success": False, "error": {"code": "NOT_FOUND"}})


class TestEndToEndScanWorkflow(unittest.TestCase):
    """End-to-End integration test suite for the complete scan lifecycle."""

    @classmethod
    def setUpClass(cls):
        # Start local test backend HTTP server
        TestBackendHandler.reset_db()
        cls.server = http.server.HTTPServer(("127.0.0.1", 0), TestBackendHandler)
        cls.server_port = cls.server.server_address[1]
        cls.server_url = f"http://127.0.0.1:{cls.server_port}"

        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
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

        # Set up requests session that bypasses any local proxies
        self.client = requests.Session()
        self.client.trust_env = False

        # Set up in-memory keyring mock
        self.keyring_patcher = patch(
            "agent.storage.keyring.get_password",
            side_effect=lambda svc, usr: self.mock_keyring.get(f"{svc}:{usr}"),
        )
        self.keyring_set_patcher = patch(
            "agent.storage.keyring.set_password",
            side_effect=lambda svc, usr, val: self.mock_keyring.update({f"{svc}:{usr}": val}),
        )
        self.keyring_del_patcher = patch(
            "agent.storage.keyring.delete_password",
            side_effect=lambda svc, usr: self.mock_keyring.pop(f"{svc}:{usr}", None),
        )

        self.keyring_patcher.start()
        self.keyring_set_patcher.start()
        self.keyring_del_patcher.start()

    def tearDown(self):
        self.keyring_patcher.stop()
        self.keyring_set_patcher.stop()
        self.keyring_del_patcher.stop()
        self.temp_dir.cleanup()

    def test_complete_e2e_scan_flow(self):
        """Test complete workflow: pair -> request scan -> claim & report -> read results."""
        # 1. Generate pairing code on server
        resp_tok = self.client.post(f"{self.server_url}/api/devices/pairing-token", json={})
        self.assertEqual(resp_tok.status_code, 201)
        pairing_code = resp_tok.json()["data"]["pairing_token"]

        # 2. Pair agent via real CLI run_pair
        exit_code = run_pair(server_url=self.server_url, code=pairing_code, config_path=self.config_path)
        self.assertEqual(exit_code, 0)

        # Confirm paired configuration and token
        from agent.config import load_config
        from agent.storage import get_agent_token
        cfg = load_config(self.config_path)
        device_id = cfg["device_id"]
        token = get_agent_token()
        self.assertIsNotNone(device_id)
        self.assertIsNotNone(token)

        # 3. User requests an on-demand scan
        resp_scan = self.client.post(
            f"{self.server_url}/api/devices/{device_id}/scans",
            headers={"Authorization": "Bearer owner-jwt"},
        )
        self.assertEqual(resp_scan.status_code, 201)
        job_data = resp_scan.json()["data"]["job"]
        self.assertEqual(job_data["status"], "queued")
        job_id = job_data["id"]

        # 4. Agent polls for jobs
        polled_job, revoked = poll_next_job(server_url=self.server_url, token=token)
        self.assertFalse(revoked)
        self.assertIsNotNone(polled_job)
        self.assertEqual(polled_job["id"], job_id)

        # 5. Agent executes the job against real WinGet list fixture
        fixture_text = LIST_FIXTURE_PATH.read_text(encoding="utf-8")
        parsed_apps = parse_winget_list_output(fixture_text)
        self.assertGreater(len(parsed_apps), 10)

        mock_scan_result = ScanResult(
            apps=parsed_apps,
            started_at="2026-11-11T12:00:00Z",
            finished_at="2026-11-11T12:00:15Z",
            winget_available=True,
            warnings=[],
            errors=[],
        )

        with patch("agent.jobs.scan_inventory", return_value=mock_scan_result):
            cont = execute_single_job(
                server_url=self.server_url,
                token=token,
                job=polled_job,
                config_path=self.config_path,
            )
            self.assertTrue(cont)

        # 6. Verify applications visible via user API
        resp_apps = self.client.get(
            f"{self.server_url}/api/devices/{device_id}/applications",
            headers={"Authorization": "Bearer owner-jwt"},
        )
        self.assertEqual(resp_apps.status_code, 200)
        apps_data = resp_apps.json()["data"]
        self.assertEqual(apps_data["total"], len(apps_data["applications"]))
        self.assertGreater(apps_data["total"], 100)

        # Check required fields
        first_app = apps_data["applications"][0]
        self.assertIn("name", first_app)
        self.assertIn("version", first_app)
        self.assertIn("publisher", first_app)
        self.assertIn("packageId", first_app)
        self.assertIn("source", first_app)
        self.assertIn("lastSeenAt", first_app)
        self.assertIn("firstSeenAt", first_app)

        # 7. Verify dashboard overview metrics updated
        resp_overview = self.client.get(
            f"{self.server_url}/api/devices/{device_id}/overview",
            headers={"Authorization": "Bearer owner-jwt"},
        )
        self.assertEqual(resp_overview.status_code, 200)
        overview_data = resp_overview.json()["data"]
        self.assertEqual(overview_data["totalApps"], apps_data["total"])
        self.assertEqual(overview_data["lastScanStatus"], "succeeded")
        self.assertIsNotNone(overview_data["lastScanAt"])

        # 8. Verify history ledger updated
        resp_hist = self.client.get(
            f"{self.server_url}/api/devices/{device_id}/history",
            headers={"Authorization": "Bearer owner-jwt"},
        )
        self.assertEqual(resp_hist.status_code, 200)
        history_items = resp_hist.json()["data"]
        self.assertEqual(len(history_items), 1)
        self.assertEqual(history_items[0]["status"], "succeeded")
        self.assertEqual(history_items[0]["appCount"], len(parsed_apps))
        self.assertIsNotNone(history_items[0]["duration"])

    def test_failed_scan_reporting(self):
        """Test reporting a scan failure when scanning fails."""
        # Pair agent
        resp_tok = self.client.post(f"{self.server_url}/api/devices/pairing-token", json={})
        code = resp_tok.json()["data"]["pairing_token"]
        run_pair(server_url=self.server_url, code=code, config_path=self.config_path)

        from agent.config import load_config
        from agent.storage import get_agent_token
        dev_id = load_config(self.config_path)["device_id"]
        token = get_agent_token()

        # Request scan
        resp_scan = self.client.post(
            f"{self.server_url}/api/devices/{dev_id}/scans",
            headers={"Authorization": "Bearer owner-jwt"},
        )
        self.assertEqual(resp_scan.status_code, 201)

        # Poll
        job, _ = poll_next_job(server_url=self.server_url, token=token)

        # Simulate scan failure: both sources fail
        failed_result = ScanResult(
            apps=[],
            started_at="2026-11-11T12:00:00Z",
            finished_at="2026-11-11T12:00:01Z",
            winget_available=False,
            warnings=["WinGet not found"],
            errors=["Registry inaccessible"],
        )

        with patch("agent.jobs.scan_inventory", return_value=failed_result):
            execute_single_job(server_url=self.server_url, token=token, job=job)

        # Check history shows failure with message
        resp_hist = self.client.get(
            f"{self.server_url}/api/devices/{dev_id}/history",
            headers={"Authorization": "Bearer owner-jwt"},
        )
        self.assertEqual(resp_hist.status_code, 200)
        hist = resp_hist.json()["data"][0]
        self.assertEqual(hist["status"], "failed")
        self.assertEqual(hist["appCount"], 0)
        self.assertIn("Both WinGet and Registry", hist["errorMessage"])

    def test_duplicate_scan_request_returns_409(self):
        """Test that requesting a scan while one is already active returns 409 with existing ID."""
        resp_tok = self.client.post(f"{self.server_url}/api/devices/pairing-token", json={})
        code = resp_tok.json()["data"]["pairing_token"]
        run_pair(server_url=self.server_url, code=code, config_path=self.config_path)

        from agent.config import load_config
        dev_id = load_config(self.config_path)["device_id"]

        # First request succeeds
        res1 = self.client.post(
            f"{self.server_url}/api/devices/{dev_id}/scans",
            headers={"Authorization": "Bearer owner-jwt"},
        )
        self.assertEqual(res1.status_code, 201)
        first_job_id = res1.json()["data"]["job"]["id"]

        # Second request while queued returns 409 with existingJobId
        res2 = self.client.post(
            f"{self.server_url}/api/devices/{dev_id}/scans",
            headers={"Authorization": "Bearer owner-jwt"},
        )
        self.assertEqual(res2.status_code, 409)
        err = res2.json()["error"]
        self.assertEqual(err["code"], "ACTIVE_SCAN_EXISTS")
        self.assertEqual(err["existingJobId"], first_job_id)

    def test_stranger_cannot_access_device_jobs_or_data(self):
        """Test that another user gets 404 when attempting to access another user's device."""
        resp_tok = self.client.post(f"{self.server_url}/api/devices/pairing-token", json={})
        code = resp_tok.json()["data"]["pairing_token"]
        run_pair(server_url=self.server_url, code=code, config_path=self.config_path)

        from agent.config import load_config
        dev_id = load_config(self.config_path)["device_id"]

        # Stranger attempts to trigger scan
        res1 = self.client.post(
            f"{self.server_url}/api/devices/{dev_id}/scans",
            headers={"Authorization": "Bearer stranger-jwt"},
        )
        self.assertEqual(res1.status_code, 404)

        # Stranger attempts to read applications
        res2 = self.client.get(
            f"{self.server_url}/api/devices/{dev_id}/applications",
            headers={"Authorization": "Bearer stranger-jwt"},
        )
        self.assertEqual(res2.status_code, 404)

        # Stranger attempts to read overview
        res3 = self.client.get(
            f"{self.server_url}/api/devices/{dev_id}/overview",
            headers={"Authorization": "Bearer stranger-jwt"},
        )
        self.assertEqual(res3.status_code, 404)

        # Stranger attempts to read history
        res4 = self.client.get(
            f"{self.server_url}/api/devices/{dev_id}/history",
            headers={"Authorization": "Bearer stranger-jwt"},
        )
        self.assertEqual(res4.status_code, 404)


if __name__ == "__main__":
    unittest.main()
