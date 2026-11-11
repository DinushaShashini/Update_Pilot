"""Agent pairing client and URL validation."""

from typing import Dict, Optional, Tuple
from urllib.parse import urlparse

import requests
from requests.exceptions import ConnectionError as ReqConnectionError
from requests.exceptions import SSLError as ReqSSLError
from requests.exceptions import Timeout as ReqTimeout

from agent.sysinfo import collect_system_info


class PairingError(Exception):
    """Base exception for agent pairing errors with user-friendly messages."""
    pass


class InsecureServerError(PairingError):
    """Raised when an insecure HTTP URL is used for non-localhost server."""
    pass


class ExpiredCodeError(PairingError):
    """Raised when the pairing code has expired."""
    pass


class InvalidCodeError(PairingError):
    """Raised when the pairing code is invalid."""
    pass


class NetworkError(PairingError):
    """Raised when a network failure occurs."""
    pass


class TLSError(PairingError):
    """Raised when TLS/SSL handshake fails."""
    pass


def validate_server_url(server_url: str) -> str:
    """Validate server URL and enforce HTTPS (except for localhost).

    Returns:
        Cleaned server URL with trailing slashes stripped.

    Raises:
        PairingError: If URL format is invalid.
        InsecureServerError: If HTTP is used for a non-localhost host.
    """
    if not server_url:
        raise PairingError("Server URL cannot be empty.")

    cleaned = server_url.strip().rstrip("/")
    parsed = urlparse(cleaned)

    if not parsed.scheme or not parsed.netloc:
        raise PairingError(f"Invalid server URL: '{server_url}'. Must include protocol (e.g., https://example.com).")

    if parsed.scheme not in ("http", "https"):
        raise PairingError(f"Unsupported protocol: '{parsed.scheme}'. Server URL must use HTTPS or HTTP.")

    hostname = (parsed.hostname or "").lower()
    is_localhost = hostname in ("localhost", "127.0.0.1", "::1")

    if parsed.scheme == "http" and not is_localhost:
        raise InsecureServerError(
            "Insecure connection error: Server URL must use HTTPS (HTTP is only allowed for localhost during development)."
        )

    return cleaned


def build_pair_endpoint_url(server_url: str) -> str:
    """Build the full pairing endpoint URL (/api/agent/pair)."""
    base = validate_server_url(server_url)
    if base.endswith("/api"):
        return f"{base}/agent/pair"
    return f"{base}/api/agent/pair"


def call_pair_endpoint(
    server_url: str,
    code: str,
    system_info: Optional[Dict[str, str]] = None,
    timeout_seconds: int = 15,
) -> Tuple[str, str]:
    """Call the backend /api/agent/pair endpoint.

    Args:
        server_url: Backend server base URL.
        code: Secret one-time pairing code.
        system_info: Hostname, OS version, agent version.
        timeout_seconds: Request timeout in seconds.

    Returns:
        Tuple of (device_id, agent_token).

    Raises:
        TLSError: If SSL/TLS certificate verification fails.
        NetworkError: If the server cannot be reached or times out.
        ExpiredCodeError: If the code has expired.
        InvalidCodeError: If the code is rejected as invalid.
        PairingError: For general errors.
    """
    if not code or not code.strip():
        raise InvalidCodeError("Pairing code cannot be empty.")

    endpoint_url = build_pair_endpoint_url(server_url)
    info = system_info or collect_system_info()

    payload = {
        "code": code.strip(),
        "pairing_token": code.strip(),
        "hostname": info.get("hostname", ""),
        "computer_name": info.get("hostname", ""),
        "os_version": info.get("os_version", ""),
        "agent_version": info.get("agent_version", ""),
    }

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    try:
        response = requests.post(
            endpoint_url,
            json=payload,
            headers=headers,
            timeout=timeout_seconds,
        )
    except ReqSSLError as e:
        raise TLSError(
            "TLS/SSL error: Secure connection could not be established. Please verify server certificate and URL."
        ) from e
    except (ReqConnectionError, ReqTimeout) as e:
        raise NetworkError(
            f"Network error: Unable to connect to server at {server_url}. Please check your connection and server URL."
        ) from e
    except Exception as e:
        raise NetworkError(f"Network error: {str(e)}") from e

    # Check status and response body
    try:
        data = response.json()
    except Exception:
        data = {}

    if response.status_code in (200, 201):
        # Extract device_id and agent_token from response
        # Standard wraps in { "data": { ... } } or flat
        nested_data = data.get("data") if isinstance(data, dict) else None
        source = nested_data if isinstance(nested_data, dict) else data

        device_id = source.get("device_id") or source.get("deviceId")
        agent_token = source.get("agent_token") or source.get("token")

        if not device_id or not agent_token:
            raise PairingError("Server responded successfully but did not return device credentials.")

        return str(device_id), str(agent_token)

    # Handle error responses
    error_msg = ""
    error_code = ""
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            error_msg = str(err.get("message") or "")
            error_code = str(err.get("code") or "")
        elif isinstance(err, str):
            error_msg = err
        elif "message" in data:
            error_msg = str(data["message"])

    msg_lower = error_msg.lower()
    code_upper = error_code.upper()

    if "expired" in msg_lower or "EXPIRED" in code_upper:
        raise ExpiredCodeError(
            "Pairing failed: The pairing code has expired. Please generate a new code from the dashboard."
        )

    if response.status_code in (400, 401, 403, 404):
        if error_msg:
            raise InvalidCodeError(f"Pairing failed: {error_msg}")
        raise InvalidCodeError("Pairing failed: Invalid pairing code. Please check the code and try again.")

    raise PairingError(f"Pairing failed: Server returned HTTP status {response.status_code}.")
