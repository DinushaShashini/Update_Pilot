"""Agent periodic heartbeat and credential revocation handling."""

import logging
import random
import threading
import time
from enum import Enum
from pathlib import Path
from typing import Callable, Dict, Optional
from urllib.parse import urlparse

import requests
from requests.exceptions import RequestException

from agent.config import clear_device_id, get_default_config_path, load_config
from agent.pairing import validate_server_url
from agent.storage import delete_agent_token, get_agent_token
from agent.sysinfo import collect_system_info

logger = logging.getLogger("agent.heartbeat")


class ConnectionState(Enum):
    UNKNOWN = "UNKNOWN"
    CONNECTED = "CONNECTED"
    LOST = "LOST"


class HeartbeatResult(Enum):
    SUCCESS = "SUCCESS"
    REVOKED = "REVOKED"
    FAILURE = "FAILURE"


def build_heartbeat_url(server_url: str) -> str:
    """Build the heartbeat endpoint URL."""
    base = validate_server_url(server_url)
    if base.endswith("/api"):
        return f"{base}/agent/heartbeat"
    return f"{base}/api/agent/heartbeat"


def send_single_heartbeat(
    server_url: str,
    token: str,
    system_info: Optional[Dict[str, str]] = None,
    timeout_seconds: int = 10,
) -> HeartbeatResult:
    """Send a single heartbeat request to the backend.

    Never logs or exposes the token.
    Returns:
        HeartbeatResult: SUCCESS, REVOKED (on 401), or FAILURE.
    """
    url = build_heartbeat_url(server_url)
    info = system_info or collect_system_info()

    payload = {
        "agent_version": info.get("agent_version", "1.0.0"),
        "os_version": info.get("os_version", ""),
        "hostname": info.get("hostname", ""),
    }

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    parsed = urlparse(url)
    is_localhost = (parsed.hostname or "").lower() in ("localhost", "127.0.0.1", "::1")
    proxies = {"http": None, "https": None} if is_localhost else None

    try:
        response = requests.post(
            url,
            json=payload,
            headers=headers,
            timeout=timeout_seconds,
            proxies=proxies,
        )
    except RequestException as e:
        logger.debug("Heartbeat request failed with exception: %s", type(e).__name__)
        return HeartbeatResult.FAILURE

    if response.status_code in (200, 201):
        return HeartbeatResult.SUCCESS

    if response.status_code == 401:
        # Credential has been revoked or invalidated by server
        return HeartbeatResult.REVOKED

    return HeartbeatResult.FAILURE


def calculate_backoff_delay(
    retry_count: int,
    base_interval: float = 5.0,
    max_interval: float = 60.0,
) -> float:
    """Calculate exponential backoff with random jitter.

    Formula: min(max_interval, base_interval * 2^(retry_count - 1)) + jitter
    """
    exponent = max(0, retry_count - 1)
    backoff = min(max_interval, base_interval * (2 ** exponent))
    jitter = random.uniform(0.1, min(3.0, backoff * 0.1 + 0.5))
    return backoff + jitter


def handle_revocation(config_path: Optional[Path] = None) -> None:
    """Handle 401 revocation: log clean message, delete token, and clear device_id."""
    logger.warning("Device pairing has been revoked by server. Purging local credentials.")
    delete_agent_token()
    clear_device_id(config_path=config_path)


def run_heartbeat_loop(
    server_url: str,
    token: str,
    interval_seconds: float = 30.0,
    config_path: Optional[Path] = None,
    shutdown_event: Optional[threading.Event] = None,
    max_iterations: Optional[int] = None,
    sleeper: Optional[Callable[[float], None]] = None,
) -> None:
    """Execute the periodic heartbeat loop.

    - Sends heartbeats at configured interval (default 30 seconds).
    - Uses exponential backoff with jitter on failures.
    - Times out every request.
    - Transitions connection state and logs ONLY state changes:
      connected, lost, restored.
    - Stops sending immediately on 401 Revoked, purges credentials, and enters
      an unpaired state without retrying in a loop.
    - Gracefully exits on shutdown_event.
    """
    stop_event = shutdown_event or threading.Event()
    connection_state = ConnectionState.UNKNOWN
    consecutive_failures = 0
    iteration = 0

    while not stop_event.is_set():
        if max_iterations is not None and iteration >= max_iterations:
            break
        iteration += 1

        result = send_single_heartbeat(server_url=server_url, token=token)

        if result == HeartbeatResult.REVOKED:
            # Revocation encountered: log without token, clear credentials, exit immediately
            handle_revocation(config_path=config_path)
            return

        elif result == HeartbeatResult.SUCCESS:
            consecutive_failures = 0

            # Log connection state changes only
            if connection_state == ConnectionState.UNKNOWN:
                connection_state = ConnectionState.CONNECTED
                logger.info("Connected to server at %s", server_url)
            elif connection_state == ConnectionState.LOST:
                connection_state = ConnectionState.CONNECTED
                logger.info("Connection restored to server at %s", server_url)
            # If already CONNECTED, do not log

            sleep_duration = interval_seconds

        else:  # HeartbeatResult.FAILURE
            consecutive_failures += 1

            # Log connection state changes only
            if connection_state == ConnectionState.CONNECTED:
                connection_state = ConnectionState.LOST
                logger.warning("Connection lost to server at %s", server_url)
            elif connection_state == ConnectionState.UNKNOWN:
                connection_state = ConnectionState.LOST
                logger.warning("Connection lost: initial connection failed to %s", server_url)
            # If already LOST, do not log repeatedly

            sleep_duration = calculate_backoff_delay(consecutive_failures)

        # Sleep or wait for shutdown event
        if sleeper is not None:
            sleeper(sleep_duration)
        else:
            stop_event.wait(timeout=sleep_duration)

    logger.info("Heartbeat loop stopped.")
