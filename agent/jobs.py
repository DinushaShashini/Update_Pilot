"""Agent job polling, claiming, execution and reporting."""

from datetime import datetime, timezone
import logging
import random
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import requests
from requests.exceptions import RequestException

from agent.config import is_operation_allowed
from agent.heartbeat import handle_revocation
from agent.pairing import validate_server_url
from agent.scanner.payload import convert_scan_result_to_api_payload
from agent.scanner.scan import scan_inventory

logger = logging.getLogger("agent.jobs")

# Concurrency lock: never run two jobs at the same time
_JOB_EXECUTION_LOCK = threading.Lock()


def build_agent_endpoint(server_url: str, path: str) -> str:
    """Build full URL for an agent endpoint."""
    base = validate_server_url(server_url)
    clean_path = path.lstrip("/")
    if base.endswith("/api"):
        return f"{base}/{clean_path}"
    return f"{base}/api/{clean_path}"


def _get_proxies(url: str) -> Optional[Dict[str, None]]:
    """Bypass proxies for local/loopback URLs."""
    parsed = urlparse(url)
    is_localhost = (parsed.hostname or "").lower() in ("localhost", "127.0.0.1", "::1")
    return {"http": None, "https": None} if is_localhost else None


def poll_next_job(
    server_url: str,
    token: str,
    timeout_seconds: int = 10,
) -> Tuple[Optional[Dict[str, Any]], bool]:
    """Poll for the oldest queued job for this agent.

    Returns:
        (job_dict or None, is_revoked: bool)
    """
    url = build_agent_endpoint(server_url, "agent/jobs")
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }

    try:
        resp = requests.get(
            url,
            headers=headers,
            timeout=timeout_seconds,
            proxies=_get_proxies(url),
        )
    except RequestException as exc:
        logger.debug("Job polling network error: %s", type(exc).__name__)
        return None, False

    if resp.status_code == 401:
        return None, True

    if resp.status_code in (200, 201):
        try:
            data = resp.json()
            nested = data.get("data")
            jobs: List[Dict[str, Any]] = []
            if isinstance(nested, dict):
                jobs = nested.get("jobs", [])
            elif isinstance(nested, list):
                jobs = nested
            else:
                jobs = data.get("jobs", [])

            if jobs and len(jobs) > 0:
                return jobs[0], False
        except Exception:
            pass

    return None, False


def claim_job(
    server_url: str,
    token: str,
    job_id: str,
    timeout_seconds: int = 10,
) -> Tuple[bool, bool]:
    """Atomically claim a queued job.

    Returns:
        (claimed: bool, is_revoked: bool)
    """
    url = build_agent_endpoint(server_url, f"agent/jobs/{job_id}/claim")
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }

    try:
        resp = requests.post(
            url,
            headers=headers,
            timeout=timeout_seconds,
            proxies=_get_proxies(url),
        )
    except RequestException as exc:
        logger.debug("Job claim network error: %s", type(exc).__name__)
        return False, False

    if resp.status_code == 401:
        return False, True

    if resp.status_code in (200, 201):
        return True, False

    if resp.status_code == 409:
        logger.info("Job %s already claimed by another worker", job_id)
        return False, False

    return False, False


def report_job_progress(
    server_url: str,
    token: str,
    job_id: str,
    percent: int,
    step: str,
    message: Optional[str] = None,
    skipped: bool = False,
    timeout_seconds: int = 5,
) -> Tuple[bool, bool]:
    """Report progress for an active job.

    Returns:
        (success: bool, is_revoked: bool)
    """
    url = build_agent_endpoint(server_url, f"agent/jobs/{job_id}/progress")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload: Dict[str, Any] = {
        "percent": percent,
        "step": step[:100],
    }
    if message is not None:
        payload["message"] = message[:256]
    if skipped:
        payload["skipped"] = True

    try:
        resp = requests.post(
            url,
            json=payload,
            headers=headers,
            timeout=timeout_seconds,
            proxies=_get_proxies(url),
        )
    except RequestException:
        return False, False

    if resp.status_code == 401:
        return False, True

    return resp.status_code in (200, 201), False


class ThrottledProgressReporter:
    """Progress callback that throttles network reports to at most once per interval."""

    def __init__(
        self,
        server_url: str,
        token: str,
        job_id: str,
        min_interval_seconds: float = 2.0,
    ) -> None:
        self.server_url = server_url
        self.token = token
        self.job_id = job_id
        self.min_interval = min_interval_seconds
        self.last_reported = 0.0
        self.last_percent = 0
        self.is_revoked = False

    def __call__(
        self,
        step: str,
        percent: int,
        message: Optional[str] = None,
        skipped: bool = False,
        force: bool = False,
    ) -> None:
        if self.is_revoked:
            return

        safe_pct = max(self.last_percent, min(100, int(percent)))
        self.last_percent = safe_pct

        now = time.perf_counter()
        if force or (now - self.last_reported) >= self.min_interval or safe_pct in (0, 100):
            self.last_reported = now
            _, revoked = report_job_progress(
                server_url=self.server_url,
                token=self.token,
                job_id=self.job_id,
                percent=safe_pct,
                step=step,
                message=message,
                skipped=skipped,
            )
            if revoked:
                self.is_revoked = True


def submit_scan_results(
    server_url: str,
    token: str,
    job_id: str,
    payload: Dict[str, Any],
    max_retries: int = 3,
    base_backoff: float = 1.0,
    timeout_seconds: int = 20,
    sleeper: Optional[Callable[[float], None]] = None,
) -> Tuple[bool, bool]:
    """Submit scan results with exponential backoff retry on network failures.

    Returns:
        (success: bool, is_revoked: bool)
    """
    url = build_agent_endpoint(server_url, f"agent/scans/{job_id}/results")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    sleep_fn = sleeper or time.sleep

    for attempt in range(max_retries + 1):
        try:
            resp = requests.post(
                url,
                json=payload,
                headers=headers,
                timeout=timeout_seconds,
                proxies=_get_proxies(url),
            )

            if resp.status_code == 401:
                return False, True

            if resp.status_code in (200, 201):
                return True, False

            # If client error (e.g. 400 or 409), do not retry
            if 400 <= resp.status_code < 500:
                logger.error("Results submission rejected with HTTP %d for job %s", resp.status_code, job_id)
                return False, False

        except RequestException as exc:
            if attempt < max_retries:
                delay = base_backoff * (2 ** attempt) + random.uniform(0.1, 0.5)
                logger.warning(
                    "Network error submitting scan results (attempt %d/%d): %s. Retrying in %.1fs...",
                    attempt + 1,
                    max_retries + 1,
                    type(exc).__name__,
                    delay,
                )
                sleep_fn(delay)
                continue
            else:
                logger.error(
                    "Failed to submit scan results for job %s after %d retries due to network problems.",
                    job_id,
                    max_retries + 1,
                )
                return False, False

    return False, False


def submit_scan_failure(
    server_url: str,
    token: str,
    job_id: str,
    error_code: int,
    error_message: str,
    timeout_seconds: int = 15,
) -> Tuple[bool, bool]:
    """Report scan failure with safe diagnostic message.

    Returns:
        (success: bool, is_revoked: bool)
    """
    url = build_agent_endpoint(server_url, f"agent/scans/{job_id}/failure")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {
        "error_code": error_code,
        "error_message": error_message[:1024],
    }

    try:
        resp = requests.post(
            url,
            json=payload,
            headers=headers,
            timeout=timeout_seconds,
            proxies=_get_proxies(url),
        )
        if resp.status_code == 401:
            return False, True
        return resp.status_code in (200, 201), False
    except RequestException as exc:
        logger.debug("Failed to report scan failure: %s", type(exc).__name__)
        return False, False


def execute_single_job(
    server_url: str,
    token: str,
    job: Dict[str, Any],
    config_path: Optional[Any] = None,
    sleeper: Optional[Callable[[float], None]] = None,
) -> bool:
    """Execute a single job safely with state transitions and error reporting.

    Returns True to continue running, or False if revoked.
    """
    job_id = job.get("id")
    job_type = job.get("type")

    if not job_id:
        return True

    # Ensure no two jobs run simultaneously
    acquired = _JOB_EXECUTION_LOCK.acquire(blocking=False)
    if not acquired:
        logger.info("Skipping job %s; another job is currently executing", job_id)
        return True

    try:
        logger.info("Processing job %s (type: %s)", job_id, job_type)

        # 1. Claim the job first
        claimed, revoked = claim_job(server_url=server_url, token=token, job_id=job_id)
        if revoked:
            handle_revocation(config_path=config_path)
            return False

        if not claimed:
            logger.info("Job %s could not be claimed; moving to next job", job_id)
            return True

        logger.info("Job %s claimed: status -> running", job_id)

        # 2. Check allow-list
        if not job_type or not is_operation_allowed(job_type):
            msg = f"Disallowed or unsupported job type: '{job_type}'"
            logger.warning("Job %s rejected: %s", job_id, msg)
            _, revoked = submit_scan_failure(
                server_url=server_url,
                token=token,
                job_id=job_id,
                error_code=1,
                error_message=msg,
            )
            if revoked:
                handle_revocation(config_path=config_path)
                return False
            return True

        # 3. Execute scan_inventory
        if job_type == "scan_inventory":
            start_time = time.perf_counter()
            progress_reporter = ThrottledProgressReporter(
                server_url=server_url,
                token=token,
                job_id=job_id,
                min_interval_seconds=2.0,
            )

            try:
                scan_res = scan_inventory(progress_callback=progress_reporter)
            except Exception as exc:
                elapsed = time.perf_counter() - start_time
                safe_err = f"Scan execution error: {type(exc).__name__}"
                logger.error("Job %s failed in %.2fs: %s", job_id, elapsed, safe_err)
                _, revoked = submit_scan_failure(
                    server_url=server_url,
                    token=token,
                    job_id=job_id,
                    error_code=1,
                    error_message=safe_err,
                )
                if revoked:
                    handle_revocation(config_path=config_path)
                    return False
                return True

            elapsed = time.perf_counter() - start_time

            # If progress callback detected revocation mid-scan
            if progress_reporter.is_revoked:
                handle_revocation(config_path=config_path)
                return False

            # Check if both scan sources failed
            if not scan_res.winget_available and len(scan_res.errors) > 0 and len(scan_res.apps) == 0:
                err_msg = "Both WinGet and Registry inventory scans failed."
                logger.error("Job %s failed in %.2fs: %s", job_id, elapsed, err_msg)
                _, revoked = submit_scan_failure(
                    server_url=server_url,
                    token=token,
                    job_id=job_id,
                    error_code=1,
                    error_message=err_msg,
                )
                if revoked:
                    handle_revocation(config_path=config_path)
                    return False
                return True

            # Report submitting_results step (90%) before posting payload
            progress_reporter(
                "submitting_results",
                90,
                f"Submitting {len(scan_res.apps)} apps",
                False,
                force=True,
            )
            if progress_reporter.is_revoked:
                handle_revocation(config_path=config_path)
                return False

            # Convert result to API payload
            payload = convert_scan_result_to_api_payload(scan_res)
            logger.info(
                "Job %s scan completed in %.2fs (%d applications). Submitting results...",
                job_id,
                elapsed,
                len(scan_res.apps),
            )

            success, revoked = submit_scan_results(
                server_url=server_url,
                token=token,
                job_id=job_id,
                payload=payload,
                max_retries=3,
                sleeper=sleeper,
            )

            if revoked:
                handle_revocation(config_path=config_path)
                return False

            if success:
                logger.info("Job %s results accepted: status -> succeeded", job_id)
            else:
                logger.warning("Job %s results submission failed or halted", job_id)

        return True

    finally:
        _JOB_EXECUTION_LOCK.release()


def run_job_polling_loop(
    server_url: str,
    token: str,
    interval_seconds: float = 10.0,
    config_path: Optional[Any] = None,
    shutdown_event: Optional[threading.Event] = None,
    max_iterations: Optional[int] = None,
    sleeper: Optional[Callable[[float], None]] = None,
) -> None:
    """Continuous polling loop for agent jobs with exponential backoff and jitter on errors."""
    stop_event = shutdown_event or threading.Event()
    consecutive_failures = 0
    iteration = 0
    sleep_fn = sleeper or (lambda sec: stop_event.wait(timeout=sec))

    logger.info("Starting job polling loop (interval: %.1fs)", interval_seconds)

    while not stop_event.is_set():
        if max_iterations is not None and iteration >= max_iterations:
            break
        iteration += 1

        job, revoked = poll_next_job(server_url=server_url, token=token)

        if revoked:
            handle_revocation(config_path=config_path)
            stop_event.set()
            return

        if job is not None:
            consecutive_failures = 0
            continue_running = execute_single_job(
                server_url=server_url,
                token=token,
                job=job,
                config_path=config_path,
                sleeper=sleeper,
            )
            if not continue_running:
                stop_event.set()
                return

            # If there was a job, immediately check for another job unless shutting down
            sleep_duration = 0.5
        else:
            sleep_duration = interval_seconds

        sleep_fn(sleep_duration)

    logger.info("Job polling loop stopped.")
