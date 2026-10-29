#!/usr/bin/env python3
"""
tools/winget_probe.py
Safely probes WinGet for installed applications and available updates using argument lists (no shell=True).
Parses tabular output into structured JSON with name, id, version, available_version, and source.
"""

import json
import re
import shutil
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple

# Regex to strip ANSI escape sequences (colors, cursor movements)
ANSI_ESCAPE = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')

# WinGet HRESULT constants
# 0x8A15002B (-1978298325 in signed 32-bit int, 2316632107 in unsigned) = No applications found / up to date
NO_APPLICATIONS_FOUND_CODES = {-1978298325, 2316632107, 0x8A15002B}


def clean_ansi(text: str) -> str:
    """Removes ANSI color and control sequences from terminal output."""
    return ANSI_ESCAPE.sub('', text)


def parse_winget_table(raw_output: str) -> List[Dict[str, Optional[str]]]:
    """
    Parses fixed-column WinGet tabular output into a list of structured dictionaries.
    Uses column header start offsets to slice fields reliably.
    """
    cleaned = clean_ansi(raw_output)
    lines = [line.rstrip('\r\n') for line in cleaned.splitlines() if line.strip()]

    if not lines:
        return []

    # Find the header line that contains 'Name' and either 'Id' or 'Version'
    header_idx = -1
    for idx, line in enumerate(lines):
        if 'Name' in line and ('Id' in line or 'Version' in line):
            header_idx = idx
            break

    if header_idx == -1:
        return []

    header = lines[header_idx]

    # Look for the divider line (e.g. '--------------------')
    divider_idx = -1
    for idx in range(header_idx + 1, min(header_idx + 4, len(lines))):
        if '---' in lines[idx]:
            divider_idx = idx
            break

    # Calculate column slice start positions
    col_name = header.find('Name')
    col_id = header.find('Id')
    col_version = header.find('Version')
    col_available = header.find('Available')
    col_source = header.find('Source')

    # If header parsing finds valid column offsets
    start_row = (divider_idx + 1) if divider_idx != -1 else (header_idx + 1)
    results: List[Dict[str, Optional[str]]] = []

    for line in lines[start_row:]:
        # Stop if we hit a summary footer (e.g., '3 upgrades available.')
        if re.match(r'^\d+\s+(upgrades?|packages?)\s+available', line.strip(), re.IGNORECASE):
            break
        # Stop on separator lines
        if line.strip().startswith('---'):
            continue

        # Extract values using slice boundaries
        name = None
        pkg_id = None
        version = None
        available_version = None
        source = None

        def safe_slice(start: int, end: Optional[int]) -> str:
            if start < 0 or start >= len(line):
                return ""
            if end is not None and end > 0:
                return line[start:end].strip()
            return line[start:].strip()

        if col_name != -1:
            name = safe_slice(col_name, col_id if col_id != -1 else col_version) or None

        if col_id != -1:
            pkg_id = safe_slice(col_id, col_version if col_version != -1 else col_available) or None

        if col_version != -1:
            end_v = col_available if col_available != -1 else (col_source if col_source != -1 else None)
            version = safe_slice(col_version, end_v) or None

        if col_available != -1:
            end_avail = col_source if col_source != -1 else None
            available_version = safe_slice(col_available, end_avail) or None

        if col_source != -1:
            source = safe_slice(col_source, None) or None

        # A valid package row must have at least a Name or an Id
        if name or pkg_id:
            results.append({
                "name": name,
                "id": pkg_id,
                "version": version,
                "available_version": available_version,
                "source": source
            })

    return results


def run_winget_command(args: List[str], timeout_seconds: int = 45) -> Tuple[int, str, str]:
    """
    Executes a winget command with a timeout using an explicit argument list.
    Never uses shell=True.
    """
    winget_path = shutil.which("winget")
    if not winget_path:
        raise FileNotFoundError("WinGet executable not found on PATH or AppExecutionAlias.")

    cmd = [winget_path] + args
    process = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        shell=False
    )
    return process.returncode, process.stdout, process.stderr


def probe_winget(timeout_per_command: int = 45) -> Dict[str, Any]:
    """
    Runs winget list and winget upgrade, returning structured JSON results.
    """
    output: Dict[str, Any] = {
        "success": True,
        "winget_found": True,
        "installed_apps": [],
        "available_updates": [],
        "errors": []
    }

    # Verify WinGet presence
    if not shutil.which("winget"):
        output["success"] = False
        output["winget_found"] = False
        output["errors"].append({
            "command": "check",
            "message": "WinGet executable ('winget') was not found on PATH."
        })
        return output

    # 1. Run 'winget list'
    try:
        code, stdout, stderr = run_winget_command(
            ["list", "--disable-interactivity", "--accept-source-agreements"],
            timeout_seconds=timeout_per_command
        )
        if code == 0 or code in NO_APPLICATIONS_FOUND_CODES:
            output["installed_apps"] = parse_winget_table(stdout)
        else:
            output["errors"].append({
                "command": "winget list",
                "exit_code": code,
                "stderr": stderr.strip() or stdout.strip()
            })
    except subprocess.TimeoutExpired:
        output["errors"].append({
            "command": "winget list",
            "error": f"Command timed out after {timeout_per_command} seconds."
        })
    except Exception as exc:
        output["errors"].append({
            "command": "winget list",
            "error": str(exc)
        })

    # 2. Run 'winget upgrade' (read-only query)
    try:
        code, stdout, stderr = run_winget_command(
            ["upgrade", "--disable-interactivity", "--accept-source-agreements"],
            timeout_seconds=timeout_per_command
        )
        if code == 0 or code in NO_APPLICATIONS_FOUND_CODES:
            output["available_updates"] = parse_winget_table(stdout)
        else:
            output["errors"].append({
                "command": "winget upgrade",
                "exit_code": code,
                "stderr": stderr.strip() or stdout.strip()
            })
    except subprocess.TimeoutExpired:
        output["errors"].append({
            "command": "winget upgrade",
            "error": f"Command timed out after {timeout_per_command} seconds."
        })
    except Exception as exc:
        output["errors"].append({
            "command": "winget upgrade",
            "error": str(exc)
        })

    if output["errors"] and not output["installed_apps"] and not output["available_updates"]:
        output["success"] = False

    return output


def main() -> None:
    timeout = 30
    if len(sys.argv) > 1:
        try:
            timeout = int(sys.argv[1])
        except ValueError:
            pass

    probe_result = probe_winget(timeout_per_command=timeout)
    print(json.dumps(probe_result, indent=2))


if __name__ == "__main__":
    main()
