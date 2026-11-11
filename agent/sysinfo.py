"""System information collection for agent registration and heartbeats."""

import platform
import socket
from typing import Dict

from agent import __version__


def collect_system_info() -> Dict[str, str]:
    """Collect hostname, OS version, and agent version.

    Returns:
        dict with 'hostname', 'os_version', 'agent_version'
    """
    hostname = socket.gethostname() or platform.node() or "UNKNOWN-HOST"

    system = platform.system() or "Windows"
    release = platform.release() or ""
    version = platform.version() or ""
    os_version = f"{system} {release} ({version})".strip()

    return {
        "hostname": hostname,
        "os_version": os_version,
        "agent_version": __version__,
    }
