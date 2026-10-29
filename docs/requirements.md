# UpdatePilot - Requirements Specification

## 1. Overview
UpdatePilot provides centralized visibility and controlled management of Windows desktop software updates using WinGet. A core invariant across the entire system is that **no update is ever installed without explicit user approval** recorded in the web dashboard.

---

## 2. Users and Roles

### 2.1 Device Owner / Administrator (Web Dashboard User)
- **Description**: The human operator who owns and oversees their registered Windows devices and software updates.
- **Goals**:
  - Maintain a centralized inventory of installed desktop software across their Windows machines.
  - Monitor available software updates, security patches, and version diffs.
  - Retain total, explicit control over which updates get executed on their machines.
  - Review an immutable history/audit trail of scans, approvals, rejections, and execution outcomes.
- **What they CAN do**:
  - Register an account, authenticate, and manage their session securely.
  - Generate device pairing credentials/tokens to onboard their Windows devices.
  - Trigger or request on-demand inventory/update scans on paired online devices.
  - View discovered software packages, installed versions, and available updates.
  - Preview update metadata (package ID, current version, new version, source).
  - Explicitly **Approve** or **Reject** specific pending updates.
  - Revoke an agent/device pairing at any time.
  - View scan logs, approval history, and agent update execution reports.
- **What they CANNOT do**:
  - Access or control devices belonging to other registered users (strict 1:1 device-to-user ownership).
  - Store or view plaintext secrets, passwords, or raw agent device tokens after initial generation.
  - Force an agent to execute an update without recording an approved state in the backend audit log.

### 2.2 Windows Agent (Machine Identity / Device Service)
- **Description**: A local Python background process running on the user's Windows PC.
- **Goals**:
  - Accurately inspect installed applications and detect updates via the Windows Package Manager (`winget`).
  - Securely report system inventory, heartbeat, and update availability to the UpdatePilot API.
  - Safely apply updates approved by the user and report execution success or failure.
- **What it CAN do**:
  - Pair with the backend using a secure device token.
  - Execute read-only WinGet commands (`winget list`, `winget upgrade`) to gather inventory.
  - Send heartbeat pings and scan payloads over HTTPS with authenticated headers.
  - Poll for or receive commands for updates marked strictly as `APPROVED`.
  - Execute `winget upgrade --id <PackageId> --exact` for verified, approved updates.
  - Report execution exit codes, logs, and new installed versions.
- **What it CANNOT do**:
  - Execute any update that has not been explicitly marked `APPROVED` by the device owner in the backend.
  - Self-approve updates or bypass backend state verification.
  - Read, write, or access any data from devices owned by other users.
  - Store plaintext credentials on the host disk.

### 2.3 Open Questions
*(Pending detailed requirements from `docs/proposal.md`)*
1. **Multi-User / Team Roles**: Does UpdatePilot only target single individual users managing personal devices, or will there be organization-level roles (e.g., Viewer vs. Approver vs. Admin)?
2. **Scheduled vs. Manual Scans**: Should the agent perform automated scheduled scans (e.g., daily at 09:00), or only run scans when manually initiated by the user?
3. **Reboots & User Interruption**: If an update requires a system restart or closes a running application (e.g., browser), how should the agent notify or handle the local interactive Windows session?
4. **WinGet Source Scopes**: Should the agent scan all configured WinGet sources (msstore, winget-cli) or only official community repositories?

---

## 3. Main Workflows

### Workflow 1: User Login
- **Start State**: The user is unauthenticated and visits the UpdatePilot Web Dashboard (`/login`).
- **Steps**:
  1. The user enters their email and password.
  2. The frontend validates the input format (valid email pattern, non-empty password) using client-side schema validation.
  3. The request is submitted to `POST /api/v1/auth/login`.
  4. The backend validates the payload with Zod, queries the user by email, and verifies the password hash with bcrypt/argon2.
  5. The backend generates a cryptographically signed JWT or secure session cookie.
  6. The frontend receives the auth token, stores it securely in memory/HTTP-only cookie, and redirects to `/dashboard`.
- **Success Result**: The user is authenticated and lands on the dashboard overview displaying their devices.
- **Failure Result**:
  - *Invalid credentials*: Backend returns `401 Unauthorized`. Frontend displays an alert: *"Invalid email or password"*; no session is created.
  - *Validation error / malformed payload*: Backend returns `400 Bad Request` with structured error messages.

---

### Workflow 2: Pair a Device
- **Start State**: The user is logged into the dashboard, and a fresh Python agent is installed on a Windows PC without pairing credentials.
- **Steps**:
  1. The user navigates to **Devices** and clicks **"Pair New Device"**.
  2. The backend generates a cryptographically secure one-time pairing key/token with an expiration window (e.g., 15 minutes) and stores its salted hash associated with the user's ID.
  3. The dashboard displays the pairing token and instructions (e.g., `python -m updatepilot pair --token <TOKEN> --server <URL>`).
  4. The user runs the pairing command on the Windows host.
  5. The Python agent contacts `POST /api/v1/agent/register` providing the pairing token, host hardware UUID, computer name, and OS build.
  6. The backend verifies the token hash and expiration, links the device to the user, issues a permanent hashed device secret, and invalidates the one-time token.
  7. The agent saves the device secret in a secure local configuration file.
- **Success Result**: The device appears in the dashboard as **"Online - Paired"**, and the agent confirms pairing locally.
- **Failure Result**:
  - *Expired or invalid token*: Backend returns `403 Forbidden`. The agent displays: *"Pairing failed: Token expired or invalid"*. Device is not added.
  - *Network unreachable*: The agent times out and displays: *"Could not reach UpdatePilot server at <URL>"*.

---

### Workflow 3: Run a Scan
- **Start State**: A device is paired and online. The user or a scheduled trigger requests an application scan.
- **Steps**:
  1. The user clicks **"Scan Now"** on the device page in the dashboard.
  2. The backend records a scan request `PENDING` for the device.
  3. On its next polling interval or via real-time channel, the agent picks up the `SCAN_REQUEST` command.
  4. The agent executes `winget list` and `winget upgrade` in read-only inspection mode.
  5. The agent parses the structured output into a list of installed packages and available updates (Package ID, Name, Current Version, Available Version).
  6. The agent transmits the inventory payload via `POST /api/v1/agent/scans` with its device auth header.
  7. The backend validates the payload, updates the device's package inventory, creates/updates pending updates, and marks the scan as `COMPLETED`.
- **Success Result**: The dashboard updates to show the updated package inventory and timestamp: *"Scan completed just now. 4 updates available."*
- **Failure Result**:
  - *WinGet CLI error or permission issue*: Agent catches the subprocess failure, sends an error report to the backend, and the dashboard displays: *"Scan failed: WinGet returned error code 0x80070005"*.
  - *Agent offline*: The backend flags the scan request as timed out after a threshold and informs the user: *"Device unreachable"*.

---

### Workflow 4: View Available Updates
- **Start State**: A completed scan has discovered packages with newer versions available.
- **Steps**:
  1. The user navigates to the **"Updates"** tab on the dashboard or selects a specific device.
  2. The dashboard queries `GET /api/v1/updates/pending?deviceId=<ID>`.
  3. The backend returns a list of update objects containing: Package ID, Software Name, Current Version, New Available Version, Source, and Status (`PENDING_APPROVAL`).
  4. The dashboard renders a rich table with sorting, filtering by device, and visual indicators for version deltas (e.g. major vs. minor).
- **Success Result**: The user sees an organized, clear list of outdated software with action buttons: `[Preview & Approve]` and `[Reject]`.
- **Failure Result**:
  - *No updates available*: Dashboard displays a clean empty state: *"All applications are up to date! Last scanned: <date>"*.
  - *Server error*: Dashboard displays a retry button with error banner: *"Failed to load pending updates. Please try again."*

---

### Workflow 5: Preview and Approve an Update
- **Start State**: The user is viewing an update in `PENDING_APPROVAL` status on the dashboard.
- **Steps**:
  1. The user clicks **"Preview & Approve"** on an update (e.g., `Git.Git: 2.44.0 -> 2.45.0`).
  2. A confirmation modal opens displaying:
     - Target Device Name
     - Package Name & WinGet ID
     - Version diff: Current vs. Target
     - Notice: *"Update will be queued for installation on the target device upon next agent poll."*
  3. The user clicks **"Confirm & Approve"**.
  4. The frontend sends `POST /api/v1/updates/:id/approve` with anti-CSRF token / auth header.
  5. The backend validates that the update belongs to a device owned by the authenticated user, transitions the update status from `PENDING_APPROVAL` to `APPROVED`, and writes an immutable entry into `AuditLog`.
  6. The agent polls `GET /api/v1/agent/approved-actions`, receives the signed approval payload, and invokes `winget upgrade --id Git.Git --exact`.
  7. Upon completion, the agent reports the result (`INSTALLED` or `FAILED`) back to `POST /api/v1/agent/action-status`.
- **Success Result**: The dashboard displays the status progressing: `APPROVED` -> `IN_PROGRESS` -> `INSTALLED`, and the application version is updated in the inventory.
- **Failure Result**:
  - *User rejects instead*: User clicks **"Reject"**; status transitions to `REJECTED`, the agent is never notified to install, and the update is dismissed from pending views.
  - *WinGet installer error*: If installation fails on the host (e.g. installer exit code != 0), the agent reports `FAILED` with stderr; the dashboard alerts the user: *"Installation failed: Installer returned exit code 1603"*.

---

### Workflow 6: View History (Audit Logs & Update History)
- **Start State**: Past scans, approvals, rejections, and installations have taken place.
- **Steps**:
  1. The user navigates to **"Audit Logs & History"** on the dashboard.
  2. The frontend calls `GET /api/v1/audit-logs` and `GET /api/v1/updates/history`.
  3. The backend returns paginated chronological records with filters (by date range, device, package, outcome).
  4. The dashboard displays an interactive timeline and table showing: Timestamp, Action (Approved/Rejected/Installed/Failed), Operator (User email), Target Device, Package, and Installer Output.
- **Success Result**: The user can inspect the full historical lineage of any update from detection to completion.
- **Failure Result**:
  - *Unauthorized access*: If attempting to view logs for a device not owned by the user, backend responds `403 Forbidden` and hides other users' logs.

---

### Workflow 7: Revoke an Agent
- **Start State**: A device is currently paired, but the user wishes to decommission it, unpair it, or invalidate compromised credentials.
- **Steps**:
  1. The user navigates to **"Devices"**, locates the device, and selects **"Revoke / Unpair Device"**.
  2. A danger-zone confirmation modal prompts the user: *"Are you sure you want to revoke this agent? It will no longer be able to sync or receive approved updates until repaired."*
  3. The user confirms the action.
  4. The frontend calls `POST /api/v1/devices/:id/revoke`.
  5. The backend validates device ownership, invalidates all active device tokens, marks the device status as `REVOKED`, and cancels all unexecuted approved updates.
  6. When the agent next attempts to ping `POST /api/v1/agent/heartbeat` or poll actions, the backend returns `401 Unauthorized` with body `{ error: "DEVICE_REVOKED" }`.
  7. The agent deletes or deactivates its local cached token and enters an unconfigured state.
- **Success Result**: The device is marked `REVOKED` or removed from active devices on the dashboard, and the agent stops communicating.
- **Failure Result**:
  - *Device not found or not owned by user*: Backend responds with `404 Not Found` or `403 Forbidden`; no changes are made.
