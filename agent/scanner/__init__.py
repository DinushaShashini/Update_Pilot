"""Agent WinGet application scanner and inventory reporter."""

import logging
import platform
import shutil
import socket
import subprocess
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import requests

from agent.config import get_default_config_path, load_config
from agent.pairing import validate_server_url
from agent.scanner.scan import scan_inventory
from agent.storage import get_agent_token
from tools.winget_probe import NO_APPLICATIONS_FOUND_CODES, clean_ansi, parse_winget_table

logger = logging.getLogger("agent.scanner")


def run_winget_list(timeout_seconds: int = 45) -> List[Dict[str, Optional[str]]]:
    """Execute 'winget list' safely using argument list without shell=True."""
    winget_path = shutil.which("winget")
    if not winget_path:
        raise FileNotFoundError("WinGet executable not found on PATH or AppExecutionAlias.")

    cmd = [winget_path, "list", "--disable-interactivity", "--accept-source-agreements"]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            shell=False,
        )
    except subprocess.TimeoutExpired as e:
        raise TimeoutError(f"WinGet scan timed out after {timeout_seconds} seconds.") from e

    if proc.returncode != 0 and proc.returncode not in NO_APPLICATIONS_FOUND_CODES:
        err_msg = clean_ansi(proc.stderr.strip() or proc.stdout.strip())
        raise RuntimeError(f"WinGet scan failed with exit code {proc.returncode}: {err_msg}")

    return parse_winget_table(proc.stdout)


def format_scanned_inventory(raw_apps: List[Dict[str, Optional[str]]]) -> List[Dict[str, Any]]:
    """Format raw parsed WinGet applications into clean inventory records."""
    formatted = []
    for app in raw_apps:
        name = (app.get("name") or "").strip()
        pkg_id = (app.get("id") or "").strip() or None
        version = (app.get("version") or "").strip() or "Unknown"
        available_version = (app.get("available_version") or "").strip() or None
        source = (app.get("source") or "").strip() or None

        # Determine if package is managed by WinGet/MSStore
        is_managed = bool(
            (source and source.lower() in ("winget", "msstore")) or
            (pkg_id and "." in pkg_id and not pkg_id.startswith("{"))
        )

        formatted.append({
            "name": name,
            "package_id": pkg_id,
            "installed_version": version,
            "available_version": available_version,
            "source": source or "Local",
            "is_managed": is_managed,
        })
    return formatted


def build_scan_results_url(server_url: str) -> str:
    """Build the scan reporting endpoint URL."""
    base = validate_server_url(server_url)
    if base.endswith("/api"):
        return f"{base}/agent/scans/results"
    return f"{base}/api/agent/scans/results"


def report_scan_results(
    server_url: str,
    token: str,
    applications: List[Dict[str, Any]],
    timeout_seconds: int = 20,
) -> Dict[str, Any]:
    """Submit scanned applications inventory to the backend API."""
    url = build_scan_results_url(server_url)
    hostname = socket.gethostname() or platform.node() or "UNKNOWN-HOST"

    payload = {
        "hostname": hostname,
        "packages_discovered_count": len(applications),
        "applications": applications,
    }

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    parsed = urlparse(url)
    is_localhost = (parsed.hostname or "").lower() in ("localhost", "127.0.0.1", "::1")
    proxies = {"http": None, "https": None} if is_localhost else None

    resp = requests.post(
        url,
        json=payload,
        headers=headers,
        timeout=timeout_seconds,
        proxies=proxies,
    )

    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Server rejected scan results with HTTP {resp.status_code}")

    try:
        return resp.json()
    except Exception:
        return {"success": True}


def run_scan(
    server_url: Optional[str] = None,
    token: Optional[str] = None,
    config_path: Optional[Any] = None,
    raw_apps_override: Optional[List[Dict[str, Optional[str]]]] = None,
) -> Dict[str, Any]:
    """Execute complete application inventory scan and report to backend."""
    cfg = load_config(config_path)
    srv = server_url or cfg.get("server_url")
    tok = token or get_agent_token()

    if not srv or not tok:
        raise RuntimeError("Agent is not paired. Run 'agent pair --server <url>' first.")

    raw_apps = raw_apps_override if raw_apps_override is not None else run_winget_list()
    inventory = format_scanned_inventory(raw_apps)

    managed_count = sum(1 for a in inventory if a["is_managed"])
    logger.info(
        "Discovered %d installed applications (%d managed by WinGet/MSStore).",
        len(inventory),
        managed_count,
    )

    result = report_scan_results(server_url=srv, token=tok, applications=inventory)
    return {
        "total_discovered": len(inventory),
        "managed_count": managed_count,
        "unmanaged_count": len(inventory) - managed_count,
        "applications": inventory,
        "server_response": result,
    }
