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
