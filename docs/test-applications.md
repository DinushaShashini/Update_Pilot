# Safe Test Applications for UpdatePilot

This document tracks approved, safe test applications used to validate UpdatePilot's scanning, detection, and user-approved installation flows during development.

---

## 1. Cardinal Safety Rule

> [!CAUTION]
> ### Strict Rule: Never Test Updates on System-Critical Software
> **Never** target or experiment with updates on:
> - Operating system components or Windows service packs
> - Hardware, display, chipset, audio, or network drivers
> - Antivirus, endpoint protection, or firewall software
> - Disk partitioning, volume encryption (BitLocker), or BIOS/UEFI firmware utilities
> - Production database engines or active enterprise services
>
> Any test application must be a user-space, standalone utility that can be updated, closed, or reinstalled with zero risk to host stability.

---

## 2. Safe Candidate Criteria

Applications selected for update testing must satisfy the following:
1. **User-Space Execution**: Installs and runs in standard user space without modifying low-level OS subsystems.
2. **Silent Install Support**: Fully supports WinGet's silent switches (`--silent`) without interactive UI prompts.
3. **No Reboot Required**: Installation and upgrade complete immediately without requiring a machine restart (`Exit Code 3010`).
4. **Fast Download & Small Footprint**: Lightweight installer payload (< 50 MB) for rapid feedback cycles.
5. **Easily Verifiable Version**: Exposes a clear `--version` CLI flag or distinct version identifier in the registry.

---

## 3. Test Applications Table

| Name | Package ID | Installed Version | Update Available (Yes/No) | Why It Is Safe to Test |
| :--- | :--- | :--- | :--- | :--- |
| **7-Zip** | `7zip.7zip` | *[Paste Version]* | *[Yes / No]* | Small standalone archive utility (< 3MB); silent installer, no host restart required, zero system impact. |
| **Notepad++** | `Notepad++.Notepad++` | *[Paste Version]* | *[Yes / No]* | Isolated text editor (< 10MB); lightweight MSI/EXE, clean versioning, non-system-critical. |
| **Git for Windows** | `Git.Git` | *[Paste Version]* | *[Yes / No]* | Well-maintained WinGet manifest with reliable silent flags; easily verifiable via `git --version`. |
| **VLC Media Player** | `VideoLAN.VLC` | *[Paste Version]* | *[Yes / No]* | Standalone media player; self-contained libraries, safe to restart or upgrade anytime. |
| *[Custom App]* | *[Package ID]* | *[Version]* | *[Yes / No]* | *[User to specify]* |

---

## 4. Test Verification Workflow

Before executing any approved test update on a candidate application:
1. **Pre-Check**: Run `winget list --id <PackageId> --exact` to verify the current installed version.
2. **Approval Verification**: Verify that the dashboard registers status as `APPROVED` with an audit record before the agent triggers execution.
3. **Execution**: The agent invokes `winget upgrade --id <PackageId> --exact --accept-source-agreements --accept-package-agreements`.
4. **Post-Check**: The agent runs a subsequent version query to confirm the new version is active and reports the status as `INSTALLED`.
