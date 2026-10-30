# UpdatePilot Helper Tools

This directory contains standalone diagnostics and utility scripts for the UpdatePilot system.

---

## `check_environment.ps1`

A read-only PowerShell diagnostic script that inspects your local Windows machine to verify prerequisites for running the UpdatePilot agent and development environment.

### What it checks:
- **Running as Administrator**: Checks whether the current PowerShell session has elevated administrative privileges.
- **Windows Version**: OS caption, kernel version, and build number.
- **PowerShell Version**: Active PowerShell engine version (`$PSVersionTable`).
- **WinGet**: Verifies whether the Windows Package Manager CLI is present on `PATH` and outputs its installed version.
- **Python**: Verifies whether Python is present on `PATH` and outputs its version.

> **Safety Guarantee**: This script strictly inspects system information. It does not write to the filesystem, modify the registry, or change system settings.

### Usage

Run from PowerShell:

```powershell
.\tools\check_environment.ps1
```

If script execution is restricted on your system by execution policies, run with bypass:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\check_environment.ps1
```

---

## `winget_probe.py`

A safe Python diagnostic probe that queries `winget list` and `winget upgrade` using explicit argument lists (no `shell=True`) with a configurable timeout.

### Capabilities:
- **Injection-Safe Execution**: Uses `subprocess.run(["winget", ...], shell=False)` with argument arrays.
- **Robust Column-Offset Parsing**: Parses fixed-column terminal output based on column boundaries, correctly handling multi-word application names, missing IDs, and unmanaged apps.
- **Exit Code Translation**: Handles non-zero return codes like `0x8A15002B` (no applications found / fully up to date) as clean states rather than crashes.
- **Structured JSON Output**: Emits JSON with `name`, `id`, `version`, `available_version`, `source`, and captured diagnostics.

### Usage:

```bash
python tools/winget_probe.py [timeout_seconds]
```

Example:
```bash
python tools/winget_probe.py 20
```

