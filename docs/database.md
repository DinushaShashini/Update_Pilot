# UpdatePilot - Database Architecture & Schema Specification

This document defines the relational database schema, entity relationships, security constraints, and data integrity rules for **UpdatePilot**.

---

## 1. Entity-Relationship Diagram (ERD)

```mermaid
erDiagram
    users ||--o{ devices : "owns (1:N, mandatory device owner)"
    users ||--o{ scan_jobs : "triggers (1:N)"
    users ||--o{ update_jobs : "approves (1:N)"
    users ||--o{ audit_events : "initiates (1:N)"

    devices ||--|| agent_credentials : "authenticates via (1:1)"
    devices ||--o{ applications : "hosts (1:N)"
    devices ||--o{ scan_jobs : "executes on (1:N)"
    devices ||--o{ update_previews : "evaluates for (1:N)"
    devices ||--o{ update_jobs : "installs on (1:N)"
    devices ||--o{ audit_events : "relates to (1:N)"

    applications ||--o{ update_previews : "detects updates for (1:N)"
    applications ||--o{ update_jobs : "target of (1:N)"

    update_previews ||--o| update_jobs : "materializes upon approval (1:1)"

    users {
        uuid id PK
        varchar email "UK, not null"
        varchar password_hash "not null (bcrypt/Argon2)"
        varchar name "not null"
        timestamp created_at "not null"
        timestamp updated_at "not null"
    }

    devices {
        uuid id PK
        uuid user_id FK "not null (strictly 1 user)"
        varchar hardware_uuid "UK, not null"
        varchar computer_name "not null"
        varchar os_version "not null"
        varchar os_build "not null"
        varchar agent_version "not null"
        varchar winget_version "not null"
        varchar status "not null (ONLINE, OFFLINE, REVOKED)"
        timestamp last_heartbeat_at "nullable"
        timestamp created_at "not null"
        timestamp updated_at "not null"
    }

    agent_credentials {
        uuid id PK
        uuid device_id FK "UK, not null (1:1)"
        varchar token_hash "UK, not null (SHA-256)"
        varchar pairing_code_hash "nullable (SHA-256)"
        timestamp pairing_expires_at "nullable"
        timestamp revoked_at "nullable"
        timestamp created_at "not null"
        timestamp updated_at "not null"
    }

    applications {
        uuid id PK
        uuid device_id FK "not null"
        varchar package_id "nullable (Vendor.App or synthetic)"
        varchar name "not null"
        varchar installed_version "not null"
        varchar available_version "nullable"
        varchar source "nullable (winget, msstore, null)"
        boolean is_managed "not null (true if WinGet source)"
        timestamp last_scanned_at "not null"
        timestamp created_at "not null"
        timestamp updated_at "not null"
    }

    scan_jobs {
        uuid id PK
        uuid device_id FK "not null"
        uuid triggered_by_user_id FK "nullable (null if automated)"
        varchar trigger_type "not null (MANUAL, SCHEDULED)"
        varchar status "not null (PENDING, IN_PROGRESS, COMPLETED, FAILED)"
        integer packages_discovered_count "not null default 0"
        integer updates_discovered_count "not null default 0"
        integer exit_code "nullable"
        text error_message "nullable"
        timestamp started_at "nullable"
        timestamp completed_at "nullable"
        timestamp created_at "not null"
    }

    update_previews {
        uuid id PK
        uuid device_id FK "not null"
        uuid application_id FK "not null"
        varchar package_id "not null (Vendor.App)"
        varchar package_name "not null"
        varchar current_version "not null"
        varchar target_version "not null"
        varchar source_url "nullable"
        varchar manifest_hash "nullable"
        varchar status "not null (PENDING_APPROVAL, APPROVED, REJECTED, SUPERSEDED)"
        timestamp created_at "not null"
        timestamp updated_at "not null"
    }

    update_jobs {
        uuid id PK
        uuid device_id FK "not null"
        uuid application_id FK "not null"
        uuid update_preview_id FK "UK, not null (1:1 with approval)"
        uuid approved_by_user_id FK "not null (explicit user approver)"
        varchar status "not null (QUEUED, IN_PROGRESS, COMPLETED, FAILED)"
        varchar command "not null (winget upgrade --id ... --exact)"
        varchar installed_version_before "not null"
        varchar installed_version_after "nullable"
        integer exit_code "nullable"
        text stdout_log "nullable"
        text stderr_log "nullable"
        timestamp approved_at "not null"
        timestamp started_at "nullable"
        timestamp completed_at "nullable"
        timestamp created_at "not null"
    }

    audit_events {
        uuid id PK
        uuid user_id FK "nullable (null for daemon events)"
        uuid device_id FK "nullable"
        varchar event_type "not null"
        varchar entity_type "not null"
        uuid entity_id "nullable"
        jsonb metadata "not null default '{}'"
        varchar ip_address "nullable"
        timestamp created_at "not null"
    }
```

---

## 2. Table Specifications & Data Dictionaries

### 2.1 `users`
Represents dashboard operators and administrators.
- **`id`** (`UUID`, PK): Unique user identifier.
- **`email`** (`VARCHAR(255)`, UNIQUE, NOT NULL): User email address used for login.
- **`password_hash`** (`VARCHAR(255)`, NOT NULL): Salted bcrypt/Argon2 password hash. **Zero plaintext storage.**
- **`name`** (`VARCHAR(100)`, NOT NULL): Human-readable display name.
- **`created_at`** / **`updated_at`** (`TIMESTAMP WITH TIME ZONE`, NOT NULL).

### 2.2 `devices`
Represents registered Windows PC endpoints.
> **Cardinal Invariant**: Every device strictly belongs to exactly one user (`user_id` is `NOT NULL` with a foreign key constraint referencing `users.id`).
- **`id`** (`UUID`, PK): Unique device identifier.
- **`user_id`** (`UUID`, FK -> `users.id`, NOT NULL): Mandatory owner. Cross-tenant device sharing is disallowed.
- **`hardware_uuid`** (`VARCHAR(128)`, UNIQUE, NOT NULL): BIOS / motherboard hardware UUID collected from the Windows host (`Win32_ComputerSystemProduct.UUID`).
- **`computer_name`** (`VARCHAR(100)`, NOT NULL): Windows hostname (e.g. `DESKTOP-DINUSHA`).
- **`os_version`** (`VARCHAR(100)`, NOT NULL): Windows OS edition (e.g. `Windows 11 Home Single Language`).
- **`os_build`** (`VARCHAR(50)`, NOT NULL): Windows build number (e.g. `26200`).
- **`agent_version`** (`VARCHAR(30)`, NOT NULL): Running Python agent version (e.g. `1.0.0`).
- **`winget_version`** (`VARCHAR(30)`, NOT NULL): Detected WinGet CLI version (e.g. `v1.29.380`).
- **`status`** (`VARCHAR(30)`, NOT NULL): Device lifecycle status: `ONLINE`, `OFFLINE`, `REVOKED`.
- **`last_heartbeat_at`** (`TIMESTAMP WITH TIME ZONE`, NULLABLE): Last ping timestamp from agent.
- **`created_at`** / **`updated_at`** (`TIMESTAMP WITH TIME ZONE`, NOT NULL).

### 2.3 `agent_credentials`
Cryptographic authentication credentials for Windows agents.
- **`id`** (`UUID`, PK): Credential record ID.
- **`device_id`** (`UUID`, FK -> `devices.id`, UNIQUE, NOT NULL): 1:1 relationship with device.
- **`token_hash`** (`VARCHAR(128)`, UNIQUE, NOT NULL): Cryptographic hash (SHA-256) of the permanent device secret token. **Raw tokens are never stored.**
- **`pairing_code_hash`** (`VARCHAR(128)`, NULLABLE): Cryptographic hash (SHA-256) of short-lived pairing tokens.
- **`pairing_expires_at`** (`TIMESTAMP WITH TIME ZONE`, NULLABLE): Pairing expiration timestamp (15-minute window).
- **`revoked_at`** (`TIMESTAMP WITH TIME ZONE`, NULLABLE): Set when device pairing is revoked by user.
- **`created_at`** / **`updated_at`** (`TIMESTAMP WITH TIME ZONE`, NOT NULL).

### 2.4 `applications`
Inventory of software discovered on host PCs.
- **`id`** (`UUID`, PK): Unique application record identifier.
- **`device_id`** (`UUID`, FK -> `devices.id`, NOT NULL): Device hosting the software.
- **`package_id`** (`VARCHAR(255)`, NULLABLE): Official WinGet ID (e.g. `Git.Git`, `7zip.7zip`) or synthetic registry path (`ARP\Machine\X64\...`).
- **`name`** (`VARCHAR(255)`, NOT NULL): Display name of application.
- **`installed_version`** (`VARCHAR(100)`, NOT NULL): Active installed version string.
- **`available_version`** (`VARCHAR(100)`, NULLABLE): Available upgrade version (populated if outdated).
- **`source`** (`VARCHAR(50)`, NULLABLE): Package catalog source (`winget`, `msstore`, or `NULL` for unmanaged).
- **`is_managed`** (`BOOLEAN`, NOT NULL): Flag indicating whether WinGet can manage and update the package.
- **`last_scanned_at`** (`TIMESTAMP WITH TIME ZONE`, NOT NULL): Timestamp when package was last verified.
- **`created_at`** / **`updated_at`** (`TIMESTAMP WITH TIME ZONE`, NOT NULL).

### 2.5 `scan_jobs`
Audit record of inventory discovery scans executed on devices.
- **`id`** (`UUID`, PK): Scan job identifier.
- **`device_id`** (`UUID`, FK -> `devices.id`, NOT NULL): Target device.
- **`triggered_by_user_id`** (`UUID`, FK -> `users.id`, NULLABLE): User who triggered the scan (`NULL` if recurring).
- **`trigger_type`** (`VARCHAR(30)`, NOT NULL): `MANUAL` or `SCHEDULED`.
- **`status`** (`VARCHAR(30)`, NOT NULL): `PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED`.
- **`packages_discovered_count`** (`INTEGER`, NOT NULL DEFAULT 0): Total packages discovered.
- **`updates_discovered_count`** (`INTEGER`, NOT NULL DEFAULT 0): Total updates detected.
- **`exit_code`** (`INTEGER`, NULLABLE): Subprocess return code from `winget list` / `winget upgrade`.
- **`error_message`** (`TEXT`, NULLABLE): Captured error diagnostics if failed.
- **`started_at`** / **`completed_at`** (`TIMESTAMP WITH TIME ZONE`, NULLABLE).
- **`created_at`** (`TIMESTAMP WITH TIME ZONE`, NOT NULL).

### 2.6 `update_previews`
Staged candidates detected during scans awaiting user review.
- **`id`** (`UUID`, PK): Preview record ID.
- **`device_id`** (`UUID`, FK -> `devices.id`, NOT NULL): Target host device.
- **`application_id`** (`UUID`, FK -> `applications.id`, NOT NULL): Associated application.
- **`package_id`** (`VARCHAR(255)`, NOT NULL): Canonical WinGet Package ID (e.g. `Git.Git`).
- **`package_name`** (`VARCHAR(255)`, NOT NULL): Display name.
- **`current_version`** (`VARCHAR(100)`, NOT NULL): Version installed prior to update.
- **`target_version`** (`VARCHAR(100)`, NOT NULL): Version available in catalog.
- **`source_url`** (`VARCHAR(500)`, NULLABLE): Link to upstream manifest or release page.
- **`manifest_hash`** (`VARCHAR(128)`, NULLABLE): Installer package SHA-256 hash.
- **`status`** (`VARCHAR(30)`, NOT NULL): `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `SUPERSEDED`.
- **`created_at`** / **`updated_at`** (`TIMESTAMP WITH TIME ZONE`, NOT NULL).

### 2.7 `update_jobs`
Authorized update execution jobs dispatched to Windows agents.
> **Cardinal Invariant**: No update job can be created without an explicit `approved_by_user_id` linked to an active `update_previews` record.
- **`id`** (`UUID`, PK): Update job identifier.
- **`device_id`** (`UUID`, FK -> `devices.id`, NOT NULL): Target device executing the command.
- **`application_id`** (`UUID`, FK -> `applications.id`, NOT NULL): Target application.
- **`update_preview_id`** (`UUID`, FK -> `update_previews.id`, UNIQUE, NOT NULL): 1:1 link to the approved preview.
- **`approved_by_user_id`** (`UUID`, FK -> `users.id`, NOT NULL): Explicit approving user.
- **`status`** (`VARCHAR(30)`, NOT NULL): `QUEUED`, `IN_PROGRESS`, `COMPLETED`, `FAILED`.
- **`command`** (`VARCHAR(500)`, NOT NULL): Exact sanitized command (e.g. `winget upgrade --id Git.Git --exact --silent`).
- **`installed_version_before`** (`VARCHAR(100)`, NOT NULL): Base version before installation.
- **`installed_version_after`** (`VARCHAR(100)`, NULLABLE): Verified version post-installation.
- **`exit_code`** (`INTEGER`, NULLABLE): Installer exit code (`0` for success, `1603` for failure, `3010` for reboot required).
- **`stdout_log`** (`TEXT`, NULLABLE): Captured standard output.
- **`stderr_log`** (`TEXT`, NULLABLE): Captured standard error trace.
- **`approved_at`** (`TIMESTAMP WITH TIME ZONE`, NOT NULL): User authorization timestamp.
- **`started_at`** / **`completed_at`** (`TIMESTAMP WITH TIME ZONE`, NULLABLE).
- **`created_at`** (`TIMESTAMP WITH TIME ZONE`, NOT NULL).

### 2.8 `audit_events`
Immutable audit ledger for security compliance and tracking.
- **`id`** (`UUID`, PK): Event identifier.
- **`user_id`** (`UUID`, FK -> `users.id`, NULLABLE): Actor who triggered the event (`NULL` for automated agent events).
- **`device_id`** (`UUID`, FK -> `devices.id`, NULLABLE): Related device.
- **`event_type`** (`VARCHAR(50)`, NOT NULL): e.g. `USER_LOGIN`, `DEVICE_PAIRED`, `DEVICE_REVOKED`, `SCAN_REQUESTED`, `UPDATE_APPROVED`, `UPDATE_REJECTED`, `UPDATE_COMPLETED`, `UPDATE_FAILED`.
- **`entity_type`** (`VARCHAR(50)`, NOT NULL): Target entity type (`USER`, `DEVICE`, `SCAN_JOB`, `UPDATE_JOB`).
- **`entity_id`** (`UUID`, NULLABLE): Target entity primary key.
- **`metadata`** (`JSONB`, NOT NULL DEFAULT `'{}'`): Detailed event context (before/after version diffs, IP, user-agent, error codes).
- **`ip_address`** (`VARCHAR(45)`, NULLABLE): Origin IP address.
- **`created_at`** (`TIMESTAMP WITH TIME ZONE`, NOT NULL): Event timestamp (append-only, immutable).

---

## 3. Data Integrity & Security Rules

1. **Strict Single-User Device Ownership**:
   - `devices.user_id` is enforced as `NOT NULL`. A foreign key constraint `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT` prevents orphaned devices.
   - All API endpoints querying devices must filter by `user_id = current_user.id`.

2. **Zero Plaintext Secrets**:
   - User passwords stored strictly as salted bcrypt / Argon2 hashes in `users.password_hash`.
   - Agent device tokens stored strictly as SHA-256 hashes in `agent_credentials.token_hash`.
   - Pairing tokens hashed with SHA-256 before insertion in `agent_credentials.pairing_code_hash`.

3. **Mandatory Approval Traceability**:
   - `update_jobs.approved_by_user_id` is non-nullable, enforcing that no update can be dispatched to an agent without a verifiable user authorizer.
   - Every approval immediately records an append-only row in `audit_events`.

4. **Recommended Database Indexes**:
   - `devices(user_id)`: Fast retrieval of user devices.
   - `devices(hardware_uuid)`: Fast lookup during agent heartbeat and registration.
   - `agent_credentials(token_hash)`: Fast constant-time agent authentication.
   - `applications(device_id, package_id)`: Fast lookup during inventory sync.
   - `update_previews(device_id, status)`: Fast query for pending approvals.
   - `update_jobs(device_id, status)`: Fast polling of queued/in-progress update actions.
   - `audit_events(device_id, created_at DESC)`: Fast rendering of chronological activity logs.
