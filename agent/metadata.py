"""Read-only package metadata collection via `winget show`."""

from datetime import datetime, timezone
import logging
import re
import shutil
from typing import List, Optional

from agent.scanner.models import GetPackageMetadataResult, PackageMetadata
from agent.scanner.runner import run_command
from agent.scanner.winget import clean_ansi

logger = logging.getLogger("agent.metadata")

OPERATION_NAME = "get_package_metadata"
MAX_PACKAGE_IDS_PER_JOB = 20
DEFAULT_TIMEOUT_PER_PACKAGE = 15

# Standard WinGet Package Identifier Regex:
# Must consist of 2 or more dot-separated segments, containing only letters, numbers, hyphens, and underscores.
WINGET_PACKAGE_ID_REGEX = re.compile(r"^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$")
SHELL_OR_MALFORMED_CHARS = re.compile(r"[;&|><$`\"'\s\\]|[\x00-\x1F\x7F]")

# Known top-level header prefix pattern in `winget show`
TOP_LEVEL_HEADER_REGEX = re.compile(r"^[A-Za-z][A-Za-z0-9 ]*:\s*")


def is_valid_package_id(package_id: Optional[str]) -> bool:
    """Validate whether candidate string conforms to a legitimate WinGet package identifier."""
    if not package_id or not isinstance(package_id, str):
        return False
    pid = package_id.strip()
    if len(pid) < 3 or len(pid) > 256:
        return False
    if SHELL_OR_MALFORMED_CHARS.search(pid):
        return False
    return bool(WINGET_PACKAGE_ID_REGEX.match(pid))


def parse_winget_show_output(output: str, package_id: str) -> PackageMetadata:
    """Parse key-value and multiline sections from `winget show` text output."""
    cleaned = clean_ansi(output)

    # 1. Version
    version_match = re.search(r"^Version:\s*(.+)$", cleaned, re.MULTILINE | re.IGNORECASE)
    version = version_match.group(1).strip() if version_match else None

    # 2. Publisher
    publisher_match = re.search(r"^Publisher:\s*(.+)$", cleaned, re.MULTILINE | re.IGNORECASE)
    publisher = publisher_match.group(1).strip() if publisher_match else None

    # 3. Homepage URL
    homepage_match = re.search(r"^Homepage:\s*(.+)$", cleaned, re.MULTILINE | re.IGNORECASE)
    homepage_url = homepage_match.group(1).strip() if homepage_match else None

    # 4. Publisher URL
    pub_url_match = re.search(r"^Publisher Url:\s*(.+)$", cleaned, re.MULTILINE | re.IGNORECASE)
    publisher_url = pub_url_match.group(1).strip() if pub_url_match else None

    # 5. Release Notes URL
    rel_url_match = re.search(r"^Release Notes Url:\s*(.+)$", cleaned, re.MULTILINE | re.IGNORECASE)
    release_notes_url = rel_url_match.group(1).strip() if rel_url_match else None

    # 6. Installer Type (can be indented under Installer: or top-level)
    installer_type_match = re.search(r"^\s*Installer Type:\s*(.+)$", cleaned, re.MULTILINE | re.IGNORECASE)
    installer_type = installer_type_match.group(1).strip().lower() if installer_type_match else None

    # 7. Release Notes Text (multiline handling)
    release_notes_text: Optional[str] = None
    lines = cleaned.splitlines()
    in_release_notes = False
    rn_lines: List[str] = []

    for line in lines:
        if in_release_notes:
            # Check if this line starts a new top-level field (unindented key followed by :)
            # Top-level headers don't have leading whitespace and match header pattern
            if line and not line[0].isspace() and TOP_LEVEL_HEADER_REGEX.match(line):
                in_release_notes = False
            else:
                rn_lines.append(line)
                continue

        # Match start of Release Notes: (not Release Notes Url:)
        rn_match = re.match(r"^Release Notes:\s*(.*)$", line, re.IGNORECASE)
        if rn_match:
            in_release_notes = True
            inline_text = rn_match.group(1).strip()
            if inline_text:
                rn_lines.append(inline_text)

    if rn_lines:
        # Strip trailing blank lines and remove common indentation
        joined = "\n".join(rn_lines).strip()
        if joined:
            release_notes_text = joined

    return PackageMetadata(
        package_id=package_id,
        version=version or None,
        publisher=publisher or None,
        homepage_url=homepage_url or None,
        publisher_url=publisher_url or None,
        release_notes_url=release_notes_url or None,
        release_notes_text=release_notes_text or None,
        installer_type=installer_type or None,
        fetch_status="success",
        error=None,
    )


def get_single_package_metadata(
    package_id: str,
    winget_cmd: str = "winget",
    timeout: int = DEFAULT_TIMEOUT_PER_PACKAGE,
) -> PackageMetadata:
    """Execute `winget show` for a single package and parse metadata."""
    if not is_valid_package_id(package_id):
        return PackageMetadata(
            package_id=package_id,
            fetch_status="error",
            error=f"Invalid package ID format: '{package_id}'",
        )

    args = [
        winget_cmd,
        "show",
        "--id",
        package_id,
        "--exact",
        "--disable-interactivity",
        "--accept-source-agreements",
    ]

    try:
        res = run_command(args, timeout=timeout)
    except Exception as exc:
        logger.warning("Unexpected error running winget show for %s: %s", package_id, exc)
        return PackageMetadata(
            package_id=package_id,
            fetch_status="error",
            error=f"Execution error: {type(exc).__name__}",
        )

    if res.timed_out:
        logger.warning("winget show timed out after %ds for %s", timeout, package_id)
        return PackageMetadata(
            package_id=package_id,
            fetch_status="timeout",
            error=f"Command timed out after {timeout}s",
        )

    if res.exit_code != 0:
        logger.debug("winget show failed for %s with exit code %d", package_id, res.exit_code)
        return PackageMetadata(
            package_id=package_id,
            fetch_status="not_found",
            error=f"Package not found or winget exited with code {res.exit_code}",
        )

    metadata = parse_winget_show_output(res.output, package_id=package_id)
    return metadata


def get_package_metadata(
    package_ids: List[str],
    winget_cmd: Optional[str] = None,
    timeout_per_package: int = DEFAULT_TIMEOUT_PER_PACKAGE,
) -> GetPackageMetadataResult:
    """Fetch metadata for up to 20 package IDs sequentially with per-package timeout and isolation."""
    result = GetPackageMetadataResult()
    cmd = winget_cmd or shutil.which("winget") or "winget"

    # Enforce maximum 20 package IDs per job
    target_ids = list(package_ids or [])
    if len(target_ids) > MAX_PACKAGE_IDS_PER_JOB:
        warn_msg = f"Package ID list capped at {MAX_PACKAGE_IDS_PER_JOB} (received {len(target_ids)})"
        logger.warning(warn_msg)
        result.warnings.append(warn_msg)
        target_ids = target_ids[:MAX_PACKAGE_IDS_PER_JOB]

    for pid in target_ids:
        cleaned_id = pid.strip() if isinstance(pid, str) else ""
        if not cleaned_id:
            continue

        try:
            pkg_meta = get_single_package_metadata(
                package_id=cleaned_id,
                winget_cmd=cmd,
                timeout=timeout_per_package,
            )
            result.packages.append(pkg_meta)
            if pkg_meta.fetch_status != "success":
                result.warnings.append(f"{cleaned_id}: {pkg_meta.error or pkg_meta.fetch_status}")
        except Exception as exc:
            logger.error("Failed to collect metadata for %s: %s", cleaned_id, exc)
            result.packages.append(
                PackageMetadata(
                    package_id=cleaned_id,
                    fetch_status="error",
                    error=f"Unexpected error: {type(exc).__name__}",
                )
            )
            result.errors.append(f"{cleaned_id}: {type(exc).__name__}")

    return result
