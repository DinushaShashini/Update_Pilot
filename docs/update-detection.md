# Update Detection Architecture & Specification

This document details the software update detection architecture of **UpdatePilot**, including agent discovery via WinGet, backend job lifecycle, version comparison rules, safety invariants, and known limitations.

---

## 1. Architectural Overview & Data Flow

Update detection is **strictly read-only**. It inspects available package versions without downloading or executing installers.

Update checks operate only on applications that have already achieved `matchStatus: "matched"` against the WinGet package repository. Unknown package IDs, unmanaged registry applications, and unsupported packages are never queried or updated.

```mermaid
flowchart TD
    User([User or Post-Scan Trigger]) -->|POST /api/devices/:id/update-checks| BackendAPI[Backend API]
    BackendAPI -->|Create Job type=check_updates| JobQueue[(PostgreSQL ScanJob)]
    
    Agent[Windows Agent Daemon] -->|Polls GET /api/agent/jobs/poll| JobQueue
    Agent -->|POST /api/agent/jobs/:id/claim| BackendAPI
    
    subgraph Agent Execution [Agent Subprocess Isolation]
        Agent -->|Run winget upgrade --accept-source-agreements --disable-interactivity| WinGet[winget CLI]
        WinGet -->|Raw Output| StreamParser[Stream Parser / Table Extractor]
        StreamParser -->|Structured JSON: updates & warnings| Agent
    end

    Agent -->|POST /api/agent/update-checks/:id/results| Ingestion[Backend Ingestion Controller]
    
    subgraph Backend Processing [Transaction & Comparison]
        Ingestion -->|Zod Schema Validation| SchemaCheck{Valid Payload?}
        SchemaCheck -- No --> Reject400[Reject 400 Bad Request]
        SchemaCheck -- Yes --> LoadMatched[Fetch Device Matched Apps Only]
        LoadMatched --> CompareLoop[For Each Reported Package]
        
        CompareLoop --> InMatchedList{Matched on Device?}
        InMatchedList -- No --> IgnorePkg[Ignore Unknown Package]
        InMatchedList -- Yes --> VersionComp[compareVersions installed, available]
        
        VersionComp --> CompResult{Result}
        CompResult -- older --> MarkAvailable[updateStatus = update_available<br/>availableVersion = pkg.available]
        CompResult -- same / newer --> MarkUpToDate[updateStatus = up_to_date<br/>Record Warning in Audit]
        CompResult -- unknown --> MarkUnknown[updateStatus = unknown<br/>Never Guess]
        
        CompareLoop --> Remaining[Remaining Matched Apps Not in WinGet List]
        Remaining --> WGCheck{WinGet Available?}
        WGCheck -- Yes --> RemUpToDate[updateStatus = up_to_date]
        WGCheck -- No --> RemUnknown[updateStatus = unknown]
    end

    Backend Processing -->|Atomic Commit| DB[(Application & Job Records)]
    DB --> Dashboard[Web UI / Applications Table]
```

---

## 2. Core Safety Invariants

1. **Strictly Read-Only (Never Install Anything)**:
   - The agent executes `winget upgrade` without arguments to inspect the upgrade table. It never executes `winget upgrade --all`, `winget install`, or any installation switches during discovery.
   - All subprocess calls use an explicit argument list, a 45-second execution timeout, and `shell=False`.
2. **Only Matched Apps Are Checked**:
   - The backend matches incoming package IDs strictly against the device's current inventory where `matchStatus = "matched"`.
   - Packages reported by WinGet that are not matched on the device are discarded.
   - Applications with `matchStatus = "unsupported"` or `"ambiguous"` remain `updateStatus = "not_checked"`.
3. **No Version Guessing**:
   - When versions cannot be parsed or compared reliably, or when either version is `"unknown"`, the status is recorded as `"unknown"`. The system **never guesses** or defaults ambiguous comparisons to `update_available`.
4. **WinGet Discrepancy Reconciliation**:
   - If WinGet reports an available upgrade but the semantic/numeric version comparison determines the installed version is `"same"` or `"newer"` (e.g. beta builds or repository lag), the application is marked `"up_to_date"` and an audit warning is recorded.
5. **No Full App Lists or Secrets in Logs**:
   - Log files and audit events redact authentication tokens and avoid logging unbounded software dumps or raw process environments.

---

## 3. Version Comparison Engine (`compareVersions`)

The version comparison utility (`backend/src/versions/compare.ts`) evaluates two version strings: `compareVersions(installed, available) -> "older" | "same" | "newer" | "unknown"`.

An update is marked `update_available` **only when `installed` is `"older"` than `available`**.

### 3.1 Supported Version Formats

| Format | Examples | Rules |
| :--- | :--- | :--- |
| **Semantic Versions (SemVer)** | `1.0.0`, `2.50.0`, `1.2.3-beta.1` | Compares major, minor, patch numerically; evaluates pre-release tags. |
| **2 to 4 Part Numeric** | `23.01`, `17.10.6.1`, `8.0.42.0` | Normalizes missing parts to zeros (`23.01 == 23.01.0.0`). |
| **Leading "v" / "V"** | `v2.50.0`, `V1.4` | Stripped before tokenization. |
| **Numeric Precedence (1.10 vs 1.9)** | `1.10.0` vs `1.9.0` | Evaluated numerically: 10 > 9, so `1.10.0` is newer. |
| **Pre-Release Tags** | `1.0.0-alpha < 1.0.0-beta < 1.0.0` | Core version wins. Pre-release components compare numerically or lexicographically. |
| **Build Metadata** | `1.0.0+20130313144700` | Ignored during version precedence per SemVer 2.0 specification. |
| **Calendar Versions (CalVer)** | `2024.05.01`, `2026.1007.2314.0` | Evaluated numerically component-by-component. |
| **Text Suffixes** | `1.2.3a < 1.2.3b`, `1.2.3rc1 < 1.2.3` | Patch letter revisions are newer than base (`1.2.3 < 1.2.3a`). Pre-release suffixes without hyphens are older than release. |

### 3.2 Unknown & Ambiguous Cases

The engine immediately returns `"unknown"` for:
- Empty, null, undefined, or whitespace version strings.
- Non-version tokens: `"Unknown"`, `"latest"`, `"n/a"`, `"current"`.
- Range or comparison operators produced by certain package managers: e.g. `< 14.0.1.462`.
- Corrupt strings or mixed delimiter garbage (e.g. `1..2`, `alpha_beta`).
- Format mismatches where comparison is structurally ambiguous (e.g. comparing a 4-digit date version `2024.01` with a small SemVer `1.2.3`).

---

## 4. Application Update Statuses

Every application record maintains an `updateStatus` enum field:

| Status | Badge / UI Display | Description |
| :--- | :--- | :--- |
| `update_available` | **Update available** (Blue/Warning) | `installed` is strictly `"older"` than `availableVersion`. Shows `installed -> available`. |
| `up_to_date` | **Up to date** (Green/Success) | `installed` is `"same"` or `"newer"` than available, or package is matched and absent from WinGet upgrade list. |
| `unknown` | **Cannot determine** (Gray/Neutral) | Version is missing, unparseable, or WinGet CLI was missing during the check. |
| `not_checked` | **Not checked** (Muted) | Application is not matched (`unsupported` / `ambiguous`), or check has not been run. |

---

## 5. Job Lifecycle & Automation

1. **Automatic Check After Scan**:
   - Whenever an inventory scan finishes successfully (`status: "succeeded"`), the backend automatically queues an asynchronous `check_updates` job for the device.
2. **On-Demand User Trigger**:
   - Users can manually trigger a check at any time via the **Check for updates** button on the web dashboard (`POST /api/devices/:id/update-checks`).
3. **Concurrency Control**:
   - Only one active job (`queued` or `running`) of any type may exist per device at one time. Concurrent requests receive `409 Conflict`.
4. **WinGet Missing Resilience**:
   - If an agent host lacks WinGet, it reports `winget_available: false`.
   - The backend marks all matched applications as `unknown` rather than falsely asserting they are `up_to_date`.

---

## 6. Known Limitations

1. **Console Column Truncation**:
   - In rare terminal environments without fixed width output, `winget upgrade` may truncate long package names. The agent parser extracts the `Id` and `Available` version columns using header-aligned indexing and fallback space splitting to prevent truncated IDs.
2. **Pinned Packages**:
   - Packages pinned by the user via `winget pin` may appear in upgrade lists with special markers or may be suppressed by WinGet. The agent flags pinned packages in parse warnings.
3. **Multiple Source Discrepancies**:
   - When multiple sources (e.g. `winget` and `msstore`) provide conflicting version strings for the same package ID, UpdatePilot only trusts official WinGet manifests (`source: "winget"` or `"both"`).
4. **Read-Only MVP Scope**:
   - Automated package installation and upgrade execution will be implemented in subsequent phases subject to explicit administrator approvals and rollback controls.
