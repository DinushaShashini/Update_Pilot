"""Package identifier processing and publisher extraction and enrichment."""

import logging
import re
from typing import List, Optional, Tuple

from agent.scanner.models import InstalledApp, PublisherSource
from agent.scanner.runner import run_command

logger = logging.getLogger("agent.scanner.publisher")

ANSI_ESCAPE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def clean_ansi(text: str) -> str:
    """Remove ANSI escape sequences from terminal text."""
    return ANSI_ESCAPE.sub("", text)


def is_standard_winget_id(package_id: Optional[str]) -> bool:
    """Return True if package_id conforms to standard Publisher.Product notation."""
    if not package_id:
        return False
    pid = package_id.strip()
    if pid.startswith("{") or pid.endswith("}"):
        return False
    upper = pid.upper()
    if upper.startswith("ARP\\") or upper.startswith("MSIX\\"):
        return False
    # Must have at least one separator dot
    if "." not in pid:
        return False
    parts = [p.strip() for p in pid.split(".")]
    return len(parts) >= 2 and all(bool(p) for p in parts)


def derive_publisher_from_id(package_id: Optional[str]) -> Tuple[Optional[str], Optional[PublisherSource]]:
    """Derive fallback publisher name from the first segment of a package ID.

    For example, 'Git.Git' yields ('Git', 'derived').
    Never use the derived publisher as proof of identity.
    """
    if not is_standard_winget_id(package_id):
        return None, None

    first_segment = package_id.strip().split(".")[0].strip()
    if first_segment:
        return first_segment, "derived"
    return None, None


def extract_publisher_from_winget_show(output: str) -> Optional[str]:
    """Parse the Publisher field from `winget show` text output."""
    cleaned = clean_ansi(output)
    match = re.search(r"^\s*Publisher:\s*(.+)$", cleaned, re.MULTILINE | re.IGNORECASE)
    if match:
        pub = match.group(1).strip()
        return pub or None
    return None


def get_publisher_with_winget_show(
    package_id: str,
    winget_cmd: str = "winget",
    timeout: int = 10,
) -> Optional[str]:
    """Query `winget show --id <id> --exact` to retrieve verified manifest publisher."""
    if not is_standard_winget_id(package_id):
        return None

    args = [
        winget_cmd,
        "show",
        "--id",
        package_id,
        "--exact",
        "--disable-interactivity",
        "--accept-source-agreements",
    ]

    res = run_command(args, timeout=timeout)
    if res.exit_code != 0:
        logger.debug("winget show failed for %s with code %d", package_id, res.exit_code)
        return None

    return extract_publisher_from_winget_show(res.output)


def enrich_apps_with_winget_show(
    apps: List[InstalledApp],
    max_enrich: int = 0,
    winget_cmd: str = "winget",
    timeout: int = 10,
) -> List[InstalledApp]:
    """Enrich a bounded number of applications with full manifest publisher info.

    Keeps scanning fast by strictly capping the number of external queries per scan.
    """
    if max_enrich <= 0 or not apps:
        return apps

    enriched_count = 0
    for app in apps:
        if enriched_count >= max_enrich:
            break

        # Only enrich apps that have a valid winget ID and haven't been verified yet
        if not is_standard_winget_id(app.package_id):
            continue

        verified_pub = get_publisher_with_winget_show(
            app.package_id,
            winget_cmd=winget_cmd,
            timeout=timeout,
        )

        if verified_pub:
            app.publisher = verified_pub
            app.publisher_source = "winget_show"
            enriched_count += 1
        elif app.publisher is None:
            # Fall back to derived
            derived_pub, derived_src = derive_publisher_from_id(app.package_id)
            if derived_pub:
                app.publisher = derived_pub
                app.publisher_source = derived_src

    return apps
