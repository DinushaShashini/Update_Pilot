"""WinGet execution and tabular output parser for installed applications."""

import logging
import re
import shutil
import unicodedata
from typing import List, Optional, Tuple

from agent.scanner.models import InstalledApp
from agent.scanner.runner import run_command

logger = logging.getLogger("agent.scanner.winget")

# ANSI escape sequence regex
ANSI_ESCAPE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")

# Common progress spinner characters in terminal output
SPINNER_CHARS = set("\\/|\b\r⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏-")


def is_spinner_line(line: str) -> bool:
    """Return True if line consists solely of terminal spinner characters."""
    s = line.strip()
    if not s or "---" in s:
        return False
    return len(s) <= 4 and all(ch in SPINNER_CHARS for ch in s)

# Known WinGet error codes for no applications found
NO_PACKAGES_FOUND_CODES = {-1978298325, 2316632107, 0x8A15002B}

# Phrases indicating zero packages or empty query
NO_PACKAGES_PHRASES = (
    "no installed package found",
    "no packages found",
    "no applications found",
    "0 packages found",
)


def clean_ansi(text: str) -> str:
    """Remove ANSI escape sequences from terminal text."""
    return ANSI_ESCAPE.sub("", text)


def get_char_visual_width(ch: str) -> int:
    """Return visual cell width of a character (2 for East Asian Wide/Fullwidth, 1 otherwise)."""
    return 2 if unicodedata.east_asian_width(ch) in ("F", "W") else 1


def visual_slice(line: str, visual_start: int, visual_end: Optional[int]) -> str:
    """Extract substring based on terminal visual cell offsets."""
    curr = 0
    chars: List[str] = []
    for ch in line:
        w = get_char_visual_width(ch)
        if visual_end is not None and curr >= visual_end:
            break
        if curr + w > visual_start and (visual_end is None or curr < visual_end):
            chars.append(ch)
        curr += w
    return "".join(chars).strip()


def parse_winget_list_output(raw_output: str) -> List[InstalledApp]:
    """Parse raw fixed-column output of `winget list` into structured InstalledApp records.

    Handles:
    - ANSI escape codes and progress spinners
    - Warning/notice messages preceding table
    - Dashed separator boundaries
    - Truncated names with ellipses
    - Packages without package IDs (ARP/local software)
    - Wide Unicode characters
    - Empty or 'no packages found' output
    """
    if not raw_output or not raw_output.strip():
        return []

    cleaned = clean_ansi(raw_output)

    # Check for empty / no packages indicators
    lower_raw = cleaned.lower()
    if any(phrase in lower_raw for phrase in NO_PACKAGES_PHRASES) and "---" not in cleaned:
        return []

    raw_lines = cleaned.splitlines()
    lines: List[str] = []
    for raw_line in raw_lines:
        line = raw_line.rstrip("\r\n")
        # Strip trailing carriage returns if line contains inline spinner overwrites
        if "\r" in line:
            parts = [p for p in line.split("\r") if p.strip()]
            line = parts[-1] if parts else ""
        # Skip pure spinner lines
        if is_spinner_line(line):
            continue
        if line.strip():
            lines.append(line)

    if not lines:
        return []

    # Find the header row (contains Name and at least one other column)
    header_idx = -1
    for idx, line in enumerate(lines):
        if re.search(r"\bName\b", line, re.IGNORECASE) and (
            re.search(r"\bId\b", line, re.IGNORECASE)
            or re.search(r"\bVersion\b", line, re.IGNORECASE)
        ):
            header_idx = idx
            break

    if header_idx == -1:
        # Check if entire output was an informative message
        return []

    header_line = lines[header_idx]

    # Find the dashed separator line following the header
    divider_idx = -1
    for idx in range(header_idx + 1, min(header_idx + 4, len(lines))):
        if "---" in lines[idx]:
            divider_idx = idx
            break

    if divider_idx == -1:
        return []

    divider_line = lines[divider_idx]

    # Calculate column boundaries
    col_name = header_line.find("Name")
    col_id_match = re.search(r"\bId\b", header_line, re.IGNORECASE)
    col_ver_match = re.search(r"\bVersion\b", header_line, re.IGNORECASE)
    col_avail_match = re.search(r"\bAvailable\b", header_line, re.IGNORECASE)
    col_src_match = re.search(r"\bSource\b", header_line, re.IGNORECASE)

    id_start = col_id_match.start() if col_id_match else None
    ver_start = col_ver_match.start() if col_ver_match else None
    avail_start = col_avail_match.start() if col_avail_match else None
    src_start = col_src_match.start() if col_src_match else None

    # Check if divider line has grouped dashes (e.g. `----   ----   ----`)
    dash_matches = list(re.finditer(r"-+", divider_line))
    use_dash_spans = len(dash_matches) >= 3 and any(" " in divider_line for _ in [1])

    start_row = divider_idx + 1
    apps: List[InstalledApp] = []

    for line in lines[start_row:]:
        # Stop on summary footer (e.g., "X upgrades available." or "X packages found.")
        if re.match(r"^\d+\s+(upgrades?|packages?|applications?)\s+(available|found)", line.strip(), re.IGNORECASE):
            break
        # Skip divider-like lines
        if line.strip().startswith("---"):
            continue

        if use_dash_spans:
            name_raw = visual_slice(line, dash_matches[0].start(), dash_matches[0].end())
            pkg_id_raw = visual_slice(line, dash_matches[1].start(), dash_matches[1].end()) if len(dash_matches) > 1 else ""
            version_raw = visual_slice(line, dash_matches[2].start(), dash_matches[2].end()) if len(dash_matches) > 2 else ""
        else:
            name_raw = visual_slice(line, col_name if col_name != -1 else 0, id_start or ver_start)
            pkg_id_raw = visual_slice(line, id_start, ver_start) if id_start else ""
            version_raw = visual_slice(line, ver_start, avail_start or src_start) if ver_start else ""

        if not name_raw:
            continue

        # Handle truncated names (ending with ellipsis)
        raw_name = name_raw
        if name_raw.endswith("…") or name_raw.endswith("..."):
            clean_name = re.sub(r"(\.{3}|…)+$", "", name_raw).strip()
            name = clean_name or name_raw
        else:
            name = name_raw

        package_id = pkg_id_raw or None
        version = version_raw or "Unknown"

        apps.append(
            InstalledApp(
                name=name,
                version=version,
                publisher=None,
                package_id=package_id,
                source="winget",
                raw_name=raw_name,
            )
        )

    return apps


def get_winget_version(winget_cmd: str = "winget") -> Optional[str]:
    """Retrieve installed WinGet version string (e.g., 'v1.29.380').

    Returns None if WinGet is unavailable or fails to respond.
    """
    res = run_command([winget_cmd, "--version"], timeout=10)
    if res.exit_code == 0 and res.output.strip():
        # Clean potential ANSI or whitespace
        return clean_ansi(res.output.strip()).splitlines()[0].strip()
    return None


def list_installed(
    winget_cmd: Optional[str] = None,
    timeout: int = 45,
) -> List[InstalledApp]:
    """Execute `winget list` with non-interactive flags and parse installed inventory.

    Returns empty list if WinGet is missing or reports zero applications.
    """
    cmd = winget_cmd or shutil.which("winget") or "winget"
    args = [
        cmd,
        "list",
        "--disable-interactivity",
        "--accept-source-agreements",
    ]

    res = run_command(args, timeout=timeout)

    # WinGet returns 0x8A15002B if no applications match
    if res.exit_code in NO_PACKAGES_FOUND_CODES:
        return []

    if res.exit_code != 0:
        lower_err = (res.error_output + " " + res.output).lower()
        if any(phrase in lower_err for phrase in NO_PACKAGES_PHRASES):
            return []
        logger.warning(
            "winget list exited with code %d: %s",
            res.exit_code,
            res.error_output.strip() or res.output.strip(),
        )
        # Attempt to parse output if table was output despite non-zero exit
        return parse_winget_list_output(res.output)

    return parse_winget_list_output(res.output)
