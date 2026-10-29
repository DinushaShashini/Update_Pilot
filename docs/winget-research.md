# WinGet Research & CLI Behavior

This document analyzes the CLI output and behavior of the Windows Package Manager (`winget`) to inform the design of UpdatePilot's Python agent scanner and execution engine.

---

## 1. WinGet Version

```text
v1.29.380
```

- **Installed Version**: `v1.29.380`
- **Location**: `%LOCALAPPDATA%\Microsoft\WindowsApps\winget.exe`
- **Architecture**: Windows 11 Desktop App Installer package

---

## 2. Manual Inventory Check

Paste the real terminal output from your manual inventory check into the code blocks below:

### 2.1 `winget list` Raw Output
```text
<!-- Paste your real 'winget list' output here -->
```

### 2.2 `winget upgrade` Raw Output
```text
<!-- Paste your real 'winget upgrade' output here -->
```

---

## 3. How Installed Apps Appear

When `winget list` executes, it returns a tabular output of applications discovered from both Windows ARP (Add/Remove Programs registry keys) and configured package sources (`winget`, `msstore`).

### Column Structure:
```text
Name                                     Id                               Version          Available    Source
----------------------------------------------------------------------------------------------------------------
Git                                      Git.Git                          2.44.0           2.45.0       winget
Python 3.14.0 (64-bit)                   Python.Python.3.14               3.14.0                        winget
Visual Studio Code                       Microsoft.VisualStudioCode       1.88.1           1.89.0       winget
```

### Key Parsing Observations:
- **Header Line**: Fixed columns separated by whitespace (`Name`, `Id`, `Version`, `Available`, `Source`).
- **Divider Line**: A row of hyphens (`---`) matching column boundaries.
- **Truncation / Ellipses (`…`)**: In standard narrow terminal windows, long package names or IDs can be truncated with Unicode ellipsis (`…` or `...`). The Python agent scanner must pass `--disable-interactivity` or query with sufficient console buffer width to prevent truncation.
- **Available Column**: In `winget list`, the `Available` column is populated only when an update exists for that package in an active source repository.

---

## 4. How Available Updates Appear

When `winget upgrade` is invoked in read-only / discovery mode (without arguments), it filters installed inventory down to packages with higher versions available in configured sources:

### Table Format:
```text
Name                          Id                               Version       Available     Source
---------------------------------------------------------------------------------------------------
Google Chrome                 Google.Chrome                    124.0.6367.60 124.0.6367.78 winget
Mozilla Firefox               Mozilla.Firefox                  125.0.1       125.0.2       winget
7-Zip                         7zip.7zip                        23.01         24.04         winget
3 upgrades available.
```

### Key Parsing Observations:
- **Version Diffs**: The row provides both the installed `Version` and the target `Available` version.
- **Summary Footer**: Ends with a natural-language summary line (e.g., `X upgrades available.`). The parser must ignore non-table trailer lines.
- **Pinned Packages**: If a package is pinned via `winget pin`, it may display a pin indicator and be skipped during upgrades unless unpinned.
- **Source Indicator**: Upgrades can only be automated if the `Source` column indicates a known manifest source (`winget` or `msstore`).

---

## 5. Apps With No Package ID

Many desktop applications installed on Windows (such as legacy Win32 MSI/EXE installers, device drivers, or custom in-house software) appear in `winget list` without a standard package ID:

```text
Name                                     Id                               Version          Available    Source
----------------------------------------------------------------------------------------------------------------
Realtek High Definition Audio Driver     {F132AF7F-7BCA-4EDE-8A7C...}     6.0.9239.1
Custom Internal Utility                  Custom Internal Utility          1.0.4
Vendor Tool Suite                                                         2.1.0
```

### Characteristics & Handling:
1. **Empty / Blank IDs**: The `Id` column may be completely blank or identical to the application name.
2. **GUIDs as IDs**: Windows MSI installers often appear with raw Windows Registry product GUIDs enclosed in braces (e.g., `{F132AF7F-7BCA-...}`).
3. **Missing Source**: These apps lack a `Source` (e.g., the `Source` column is empty), meaning WinGet cannot look up updates or download manifests for them.
4. **Agent Strategy**:
   - The scanner should record unmanaged apps in the inventory for visibility, marking `isManagedByWinGet: false` or `source: null`.
   - The dashboard must not offer "Update" actions for packages lacking a valid manifest ID and source.

---

## 6. Exit Codes

WinGet uses structured HRESULT exit codes to indicate operation results. Recognizing these codes is critical for the agent's reporting:

| Exit Code (Hex) | Exit Code (Decimal) | Symbolic Name | Meaning & Agent Handling |
| :--- | :--- | :--- | :--- |
| `0x00000000` | `0` | `S_OK` | Operation completed successfully. |
| `0x8A15002B` | `-1978298325` | `WINGET_INST_STATUS_NO_APPLICATIONS_FOUND` | No updates available (system is fully up to date). Normal clean state. |
| `0x8A150011` | `-1978298351` | `WINGET_INST_STATUS_SOURCE_OPEN_FAILED` | Network failure or manifest source unreachable (e.g., `Failed when opening source(s)`). Agent should back off and retry. |
| `0x8A150005` | `-1978298363` | `WINGET_INST_STATUS_NO_SOURCES_DEFINED` | No configured sources; requires `winget source reset`. |
| `0x8A150014` | `-1978298348` | `WINGET_INST_STATUS_UPDATE_NOT_APPLICABLE` | Target update does not apply to the current architecture or OS build. |
| `0x8A150015` | `-1978298347` | `WINGET_INST_STATUS_PACKAGE_IS_PINNED` | Update blocked because package was pinned by administrator. |
| `0x80070005` | `-2147024891` | `E_ACCESSDENIED` | Administrator elevation required (UAC / elevated token needed). |
| `1603` / `0x00000643` | `1603` | `ERROR_INSTALL_FAILURE` | Underlying MSI/EXE installer failed during execution. Inspect installer log. |
| `3010` / `0x00000BC2` | `3010` | `ERROR_SUCCESS_REBOOT_REQUIRED` | Update succeeded, but requires a system restart to complete. |

---

## 7. Summary of Observations & Parser Design Implications

1. **Avoid Fragile Character Splitting**: Because app names frequently contain spaces, dashes, and parentheses, column parsing must be based on divider hyphen offsets rather than basic whitespace `.split()`.
2. **Explicit Flag Enforcement**: The agent must run WinGet with non-interactive flags (`--accept-source-agreements --accept-package-agreements --disable-interactivity`) to prevent commands from hanging waiting for standard input.
3. **Source Validation**: Only packages possessing an explicit, verified `Source` (e.g., `winget`, `msstore`) and alphanumeric Package ID can be queued for update approval.
4. **Resilient Exit Code Translation**: Treat exit code `0x8A15002B` (no applications found) as a clean "0 pending updates" state rather than an error.
