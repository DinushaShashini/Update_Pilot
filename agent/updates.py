"""Read-only update detection via `winget upgrade`."""

from datetime import datetime, timezone
import logging
import re
import shutil
import time
from typing import List, Optional, Tuple

from agent.scanner.models import CheckUpdatesResult, UpdateCandidate
from agent.scanner.runner import run_command
from agent.scanner.winget import (
    NO_PACKAGES_FOUND_CODES,
    clean_ansi,
    get_winget_version,
    is_spinner_line,
    visual_slice,
)

logger = logging.getLogger("agent.updates")

OPERATION_NAME = "check_updates"

NO_UPDATES_PHRASES = (
    "no installed package found matching input criteria",
    "no applicable update found",
    "no updates found",
    "no available upgrade found",
    "0 upgrades available",
)

PINNED_SECTION_PHRASES = (
    "require explicit targeting for upgrade",
    "following packages are pinned",
    "have an upgrade available, but require explicit targeting",
)


def _normalize_version_value(raw_ver: str) -> str:
    """Normalise version strings; return 'unknown' if empty or uncomparable."""
    v = raw_ver.strip()
    if not v or v.lower() == "unknown":
        return "unknown"
    return v


def _parse_table_section(
    lines: List[str],
    header_idx: int,
    divider_idx: int,
    is_pinned_section: bool = False,
) -> Tuple[List[UpdateCandidate], int]:
    """Parse a single table section starting at header_idx/divider_idx.

    Returns (parsed_candidates, next_line_index_after_section).
    """
    header_line = lines[header_idx]
    divider_line = lines[divider_idx]

    col_name = header_line.find("Name")
    col_id_match = re.search(r"\bId\b", header_line, re.IGNORECASE)
    col_ver_match = re.search(r"\bVersion\b", header_line, re.IGNORECASE)
    col_avail_match = re.search(r"\bAvailable\b", header_line, re.IGNORECASE)
    col_src_match = re.search(r"\bSource\b", header_line, re.IGNORECASE)

    id_start = col_id_match.start() if col_id_match else None
    ver_start = col_ver_match.start() if col_ver_match else None
    avail_start = col_avail_match.start() if col_avail_match else None
    src_start = col_src_match.start() if col_src_match else None

    dash_matches = list(re.finditer(r"-+", divider_line))
    use_dash_spans = len(dash_matches) >= 4 and " " in divider_line

    candidates: List[UpdateCandidate] = []
    idx = divider_idx + 1

    while idx < len(lines):
        line = lines[idx]
        stripped = line.strip()

        # Footer summary ends this table section
        if re.match(r"^\d+\s+(upgrades?|packages?|applications?)\s+(available|found)", stripped, re.IGNORECASE):
            idx += 1
            break

        # Detect start of pinned/explicit-targeting notice section
        lower_line = stripped.lower()
        if any(phrase in lower_line for phrase in PINNED_SECTION_PHRASES):
            break

        # If another table header appears, stop this section
        if re.search(r"\bName\b", line, re.IGNORECASE) and re.search(r"\bAvailable\b", line, re.IGNORECASE):
            break

        if stripped.startswith("---"):
            idx += 1
            continue

        if use_dash_spans:
            name_raw = visual_slice(line, dash_matches[0].start(), dash_matches[0].end())
            id_raw = visual_slice(line, dash_matches[1].start(), dash_matches[1].end()) if len(dash_matches) > 1 else ""
            ver_raw = visual_slice(line, dash_matches[2].start(), dash_matches[2].end()) if len(dash_matches) > 2 else ""
            avail_raw = visual_slice(line, dash_matches[3].start(), dash_matches[3].end()) if len(dash_matches) > 3 else ""
            src_raw = visual_slice(line, dash_matches[4].start(), None) if len(dash_matches) > 4 else ""
        else:
            name_raw = visual_slice(line, col_name if col_name != -1 else 0, id_start or ver_start)
            id_raw = visual_slice(line, id_start, ver_start) if id_start is not None else ""
            ver_raw = visual_slice(line, ver_start, avail_start or src_start) if ver_start is not None else ""
            avail_raw = visual_slice(line, avail_start, src_start) if avail_start is not None else ""
            src_raw = visual_slice(line, src_start, None) if src_start is not None else ""

        if not name_raw or not id_raw:
            idx += 1
            continue

        truncated = False
        if name_raw.endswith("…") or name_raw.endswith("..."):
            truncated = True
            name = re.sub(r"(\.{3}|…)+$", "", name_raw).strip() or name_raw
        else:
            name = name_raw

        if id_raw.endswith("…") or id_raw.endswith("..."):
            truncated = True

        installed_version = _normalize_version_value(ver_raw)
        available_version = _normalize_version_value(avail_raw)
        source = src_raw.strip() or "winget"

        # Check if row itself carries a pinned marker
        row_pinned = is_pinned_section or "(pinned)" in lower_line

        candidates.append(
            UpdateCandidate(
                name=name,
                package_id=id_raw,
                installed_version=installed_version,
                available_version=available_version,
                source=source,
                pinned=row_pinned,
                truncated=truncated,
            )
        )
        idx += 1

    return candidates, idx


def parse_winget_upgrade_output(raw_output: str) -> Tuple[List[UpdateCandidate], List[str]]:
    """Parse raw `winget upgrade` output into UpdateCandidate records and warnings.

    Handles:
    - ANSI escape codes and terminal spinner lines
    - "No updates found" / "No applicable update found" messages
    - Truncated rows (ellipses)
    - Pinned / explicit-targeting sections
    - Unknown or empty version strings (normalized to 'unknown')
    """
    if not raw_output or not raw_output.strip():
        return [], []

    cleaned = clean_ansi(raw_output)
    lower_raw = cleaned.lower()

    if any(phrase in lower_raw for phrase in NO_UPDATES_PHRASES) and "---" not in cleaned:
        return [], []

    lines: List[str] = []
    for raw_line in cleaned.splitlines():
        line = raw_line.rstrip("\r\n")
        if "\r" in line:
            parts = [p for p in line.split("\r") if p.strip()]
            line = parts[-1] if parts else ""
        if is_spinner_line(line):
            continue
        if line.strip():
            lines.append(line)

    if not lines:
        return [], []

    all_candidates: List[UpdateCandidate] = []
    warnings: List[str] = []
    idx = 0
    in_pinned_section = False

    while idx < len(lines):
        line = lines[idx]
        lower_line = line.lower()

        if any(phrase in lower_line for phrase in PINNED_SECTION_PHRASES):
            in_pinned_section = True
            idx += 1
            continue

        if re.search(r"\bName\b", line, re.IGNORECASE) and re.search(r"\bAvailable\b", line, re.IGNORECASE):
            divider_idx = -1
            for d_idx in range(idx + 1, min(idx + 4, len(lines))):
                if "---" in lines[d_idx]:
                    divider_idx = d_idx
                    break
            if divider_idx != -1:
                section_items, next_idx = _parse_table_section(
                    lines,
                    header_idx=idx,
                    divider_idx=divider_idx,
                    is_pinned_section=in_pinned_section,
                )
                all_candidates.extend(section_items)
                idx = next_idx
                continue

        idx += 1

    if any(c.truncated for c in all_candidates):
        warnings.append("One or more rows in winget upgrade output were truncated.")
    if any(c.pinned for c in all_candidates):
        warnings.append("One or more packages are pinned or require explicit targeting.")

    return all_candidates, warnings


def check_updates(
    winget_cmd: Optional[str] = None,
    timeout: int = 45,
) -> CheckUpdatesResult:
    """Execute read-only `winget upgrade` to discover available updates.

    Never installs or modifies software. Uses argument list with shell=False and timeout.
    Logs only counts and timing.
    """
    start_time = time.perf_counter()
    checked_at = datetime.now(timezone.utc).isoformat()
    cmd = winget_cmd or shutil.which("winget") or "winget"

    version = get_winget_version(cmd)
    if not version:
        return CheckUpdatesResult(
            updates=[],
            winget_available=False,
            checked_at=checked_at,
            warnings=["WinGet executable is not available or failed to respond."],
            errors=[],
        )

    args = [
        cmd,
        "upgrade",
        "--accept-source-agreements",
        "--disable-interactivity",
    ]

    res = run_command(args, timeout=timeout)
    elapsed = time.perf_counter() - start_time

    if res.exit_code == -1:
        err_msg = res.error_output.strip() or "winget upgrade execution failed or timed out."
        logger.error("check_updates failed in %.2fs: %s", elapsed, err_msg)
        return CheckUpdatesResult(
            updates=[],
            winget_available=True,
            checked_at=checked_at,
            warnings=[],
            errors=[err_msg],
        )

    if res.exit_code in NO_PACKAGES_FOUND_CODES:
        logger.info("check_updates finished in %.2fs: 0 updates found.", elapsed)
        return CheckUpdatesResult(
            updates=[],
            winget_available=True,
            checked_at=checked_at,
            warnings=[],
            errors=[],
        )

    lower_combined = (res.error_output + " " + res.output).lower()
    if res.exit_code != 0 and any(phrase in lower_combined for phrase in NO_UPDATES_PHRASES):
        logger.info("check_updates finished in %.2fs: 0 updates found.", elapsed)
        return CheckUpdatesResult(
            updates=[],
            winget_available=True,
            checked_at=checked_at,
            warnings=[],
            errors=[],
        )

    candidates, warnings = parse_winget_upgrade_output(res.output)
    errors: List[str] = []

    if res.exit_code != 0 and not candidates:
        err_msg = res.error_output.strip() or f"winget upgrade exited with code {res.exit_code}."
        errors.append(err_msg)

    logger.info(
        "check_updates finished in %.2fs: %d updates found (Warnings: %d, Errors: %d).",
        elapsed,
        len(candidates),
        len(warnings),
        len(errors),
    )

    return CheckUpdatesResult(
        updates=candidates,
        winget_available=True,
        checked_at=checked_at,
        warnings=warnings,
        errors=errors,
    )
