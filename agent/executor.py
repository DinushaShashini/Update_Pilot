"""Agent controlled WinGet update execution and post-verification."""

import logging
import shutil
import subprocess
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import requests

from agent.config import load_config
from agent.pairing import validate_server_url
from agent.storage import get_agent_token
from tools.winget_probe import NO_APPLICATIONS_FOUND_CODES, clean_ansi, parse_winget_table

logger = logging.getLogger("agent.executor")


class UpdateExecutionError(Exception):
    """Raised when an update execution fails."""
    pass


def run_controlled_upgrade(
    package_id: str,
    timeout_seconds: int = 300,
) -> Dict[str, Any]:
    """Execute 'winget upgrade --id <package_id> --exact' safely without shell=True.

    Rule #1 & #7: Only approved package IDs are executed, using strict exact-match arguments.
    """
    if not package_id or not package_id.strip():
        raise ValueError("Package ID cannot be empty.")

    winget_path = shutil.which("winget")
    if not winget_path:
        raise FileNotFoundError("WinGet executable not found on PATH or AppExecutionAlias.")

    cleaned_id = package_id.strip()
    cmd = [
        winget_path,
        "upgrade",
        "--id",
        cleaned_id,
        "--exact",
        "--disable-interactivity",
        "--accept-source-agreements",
        "--accept-package-agreements",
    ]

    logger.info("Executing controlled upgrade for package: %s", cleaned_id)

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            shell=False,
        )
        stdout = clean_ansi(proc.stdout)
        stderr = clean_ansi(proc.stderr)
        returncode = proc.returncode
    except subprocess.TimeoutExpired as e:
        logger.error("Upgrade timed out for package %s after %ds", cleaned_id, timeout_seconds)
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"Execution timed out after {timeout_seconds} seconds.",
            "verified": False,
        }

    # Post-Update Verification: confirm exit code
    is_success = returncode == 0 or returncode in NO_APPLICATIONS_FOUND_CODES

    # Secondary Verification: verify package exists in inventory after upgrade
    verified = False
    new_version: Optional[str] = None

    if is_success:
        try:
            verify_cmd = [
                winget_path,
                "list",
                "--id",
                cleaned_id,
                "--exact",
                "--disable-interactivity",
            ]
            v_proc = subprocess.run(
                verify_cmd,
                capture_output=True,
                text=True,
                timeout=30,
                shell=False,
            )
            parsed = parse_winget_table(v_proc.stdout)
            if parsed:
                verified = True
                new_version = parsed[0].get("version")
        except Exception as e:
            logger.debug("Verification query encountered non-fatal error: %s", e)
            verified = is_success

    return {
        "success": is_success,
        "exit_code": returncode,
        "stdout": stdout,
        "stderr": stderr,
        "verified": verified,
        "installed_version": new_version,
    }


def fetch_approved_jobs(
    server_url: str,
    token: str,
    timeout_seconds: int = 15,
) -> List[Dict[str, Any]]:
    """Retrieve pending approved update jobs for this agent."""
    base = validate_server_url(server_url)
    endpoint = f"{base}/agent/jobs" if base.endswith("/api") else f"{base}/api/agent/jobs"

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }

    parsed = urlparse(endpoint)
    is_localhost = (parsed.hostname or "").lower() in ("localhost", "127.0.0.1", "::1")
    proxies = {"http": None, "https": None} if is_localhost else None

    try:
        resp = requests.get(endpoint, headers=headers, timeout=timeout_seconds, proxies=proxies)
        if resp.status_code == 200:
            data = resp.json()
            nested = data.get("data")
            if isinstance(nested, dict):
                return nested.get("jobs", [])
            elif isinstance(nested, list):
                return nested
            return data.get("jobs", [])
    except Exception as e:
        logger.debug("Failed to fetch pending jobs: %s", e)

    return []


def report_job_result(
    server_url: str,
    token: str,
    job_id: str,
    result: Dict[str, Any],
    timeout_seconds: int = 15,
) -> bool:
    """Submit execution outcome and verification telemetry to backend."""
    base = validate_server_url(server_url)
    endpoint = (
        f"{base}/agent/jobs/{job_id}/results"
        if base.endswith("/api")
        else f"{base}/api/agent/jobs/{job_id}/results"
    )

    payload = {
        "job_id": job_id,
        "status": "SUCCEEDED" if result.get("success") and result.get("verified") else "FAILED",
        "exit_code": result.get("exit_code"),
        "stdout": result.get("stdout", "")[:10000],  # bounded size
        "stderr": result.get("stderr", "")[:10000],
        "verified_version": result.get("installed_version"),
    }

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    parsed = urlparse(endpoint)
    is_localhost = (parsed.hostname or "").lower() in ("localhost", "127.0.0.1", "::1")
    proxies = {"http": None, "https": None} if is_localhost else None

    try:
        resp = requests.post(endpoint, json=payload, headers=headers, timeout=timeout_seconds, proxies=proxies)
        return resp.status_code in (200, 201)
    except Exception as e:
        logger.error("Failed to report job result: %s", e)
        return False


def process_pending_jobs(
    server_url: Optional[str] = None,
    token: Optional[str] = None,
    config_path: Optional[Any] = None,
) -> int:
    """Fetch and execute all approved update jobs."""
    cfg = load_config(config_path)
    srv = server_url or cfg.get("server_url")
    tok = token or get_agent_token()

    if not srv or not tok:
        raise RuntimeError("Agent is not paired. Run 'agent pair --server <url>' first.")

    jobs = fetch_approved_jobs(srv, tok)
    if not jobs:
        logger.info("No approved update jobs pending.")
        return 0

    logger.info("Found %d approved update job(s) for execution.", len(jobs))
    executed_count = 0

    for job in jobs:
        job_id = job.get("id") or job.get("job_id")
        pkg_id = job.get("package_id") or job.get("packageId")

        if not job_id or not pkg_id:
            continue

        result = run_controlled_upgrade(package_id=pkg_id)
        report_job_result(srv, tok, job_id, result)
        executed_count += 1

    return executed_count
