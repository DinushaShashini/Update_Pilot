# UpdatePilot - User-Facing REST API Specification

This document specifies the user-facing REST API for the **UpdatePilot Web Dashboard**.

---

## 1. Global Conventions & Standards

### 1.1 Base URL & Content Negotiation
- **Base URL**: `/api/v1`
- **Transport**: HTTPS strictly required (TLS 1.3 / 1.2).
- **Default Headers**:
  - `Content-Type: application/json`
  - `Accept: application/json` (or `text/csv` for export endpoints)

### 1.2 Authentication Requirement
- **Public Endpoints**: No token required.
- **Protected Endpoints**: Requires `Authorization: Bearer <JWT_ACCESS_TOKEN>` header.
- The JWT payload securely encodes the authenticated user's ID (`sub`) and email. **Every request is scoped to the authenticated user's owned resources.**

### 1.3 Standard Error Format
All errors across the API adhere strictly to a uniform envelope:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request payload or parameters.",
    "details": [
      {
        "field": "email",
        "issue": "Invalid email format"
      }
    ],
    "trace_id": "req_8f19ab24c",
    "timestamp": "2026-10-30T14:38:00Z"
  }
}
```

#### Standard HTTP Error Status Codes:
- `400 Bad Request`: Validation failure or malformed payload.
- `401 Unauthorized`: Missing, expired, or invalid JWT token.
- `403 Forbidden`: User attempts to access a device or resource owned by another user.
- `404 Not Found`: Resource ID does not exist.
- `409 Conflict`: Conflict with active state (e.g. scan already in progress, active update job for package).
- `500 Internal Server Error`: Server or database failure.

---

## 2. Authentication & User Profile (`auth`, `me`)

### 2.1 Register User
- **Method & Path**: `POST /api/v1/auth/register`
- **Auth**: Public
- **Request Body**:
```json
{
  "name": "Dinusha",
  "email": "dinusha@example.com",
  "password": "CorrectHorseBatteryStaple123!"
}
```
- **Success Response (201 Created)**:
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "11111111-1111-1111-1111-111111111111",
      "name": "Dinusha",
      "email": "dinusha@example.com",
      "created_at": "2026-10-30T14:30:00Z"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```
- **Error Codes**: `400 Bad Request` (weak password, invalid email), `409 Conflict` (`EMAIL_ALREADY_EXISTS`).

---

### 2.2 Login User
- **Method & Path**: `POST /api/v1/auth/login`
- **Auth**: Public
- **Request Body**:
```json
{
  "email": "dinusha@example.com",
  "password": "CorrectHorseBatteryStaple123!"
}
```
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "11111111-1111-1111-1111-111111111111",
      "name": "Dinusha",
      "email": "dinusha@example.com"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```
- **Error Codes**: `400 Bad Request`, `401 Unauthorized` (`INVALID_CREDENTIALS`).

---

### 2.3 Current User Profile (`me`)
- **Method & Path**: `GET /api/v1/auth/me`
- **Auth**: `Bearer <JWT>`
- **Request Body**: None
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "id": "11111111-1111-1111-1111-111111111111",
    "name": "Dinusha",
    "email": "dinusha@example.com",
    "created_at": "2026-10-30T14:30:00Z"
  }
}
```
- **Error Codes**: `401 Unauthorized`.

---

## 3. Devices & Pairing Codes (`devices`)

### 3.1 List User Devices
- **Method & Path**: `GET /api/v1/devices`
- **Auth**: `Bearer <JWT>`
- **Request Body**: None
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": [
    {
      "id": "22222222-2222-2222-2222-222222222222",
      "computer_name": "DESKTOP-DINUSHA",
      "os_version": "Windows 11 Home Single Language",
      "os_build": "26200",
      "agent_version": "1.0.0",
      "winget_version": "v1.29.380",
      "status": "ONLINE",
      "last_heartbeat_at": "2026-10-30T14:37:00Z",
      "created_at": "2026-10-29T14:18:00Z"
    }
  ]
}
```
- **Error Codes**: `401 Unauthorized`.

---

### 3.2 Generate Device Pairing Token
Generates a short-lived cryptographic pairing token for onboarding a Windows PC.
- **Method & Path**: `POST /api/v1/devices/pairing-token`
- **Auth**: `Bearer <JWT>`
- **Request Body**: None
- **Success Response (201 Created)**:
```json
{
  "success": true,
  "data": {
    "pairing_token": "tok_8f92ab14ce67d0219b",
    "expires_at": "2026-10-30T14:52:00Z",
    "expires_in_seconds": 900,
    "pairing_command": "python -m updatepilot pair --token tok_8f92ab14ce67d0219b --server https://updatepilot.app"
  }
}
```
- **Error Codes**: `401 Unauthorized`.

---

### 3.3 Revoke Device Pairing
Destructive action: invalidates all device tokens and disconnects the agent permanently.
- **Method & Path**: `POST /api/v1/devices/:id/revoke`
- **Auth**: `Bearer <JWT>`
- **Request Body**:
```json
{
  "confirmation": "REVOKE"
}
```
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "id": "22222222-2222-2222-2222-222222222222",
    "status": "REVOKED",
    "revoked_at": "2026-10-30T14:38:00Z",
    "message": "Device tokens invalidated. Agent communication severed."
  }
}
```
- **Error Codes**: `400 Bad Request` (confirmation word mismatch), `401 Unauthorized`, `403 Forbidden`, `404 Not Found`.

---

## 4. Dashboard Summary (`dashboard`)

### 4.1 Get Overview Metrics
Returns aggregate cards for the active device.
- **Method & Path**: `GET /api/v1/dashboard/summary?deviceId=:id`
- **Auth**: `Bearer <JWT>`
- **Query Parameters**:
  - `deviceId` (`UUID`, required): Target device identifier.
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "device": {
      "id": "22222222-2222-2222-2222-222222222222",
      "computer_name": "DESKTOP-DINUSHA",
      "status": "ONLINE",
      "last_heartbeat_at": "2026-10-30T14:37:00Z"
    },
    "metrics": {
      "total_apps_count": 196,
      "managed_apps_count": 112,
      "unsupported_apps_count": 84,
      "pending_updates_count": 33,
      "last_scan_status": "COMPLETED",
      "last_scan_at": "2026-10-30T14:15:00Z"
    },
    "recent_activity": [
      {
        "id": "evt_91a01",
        "event_type": "UPDATE_COMPLETED",
        "title": "Update Installed: Git for Windows",
        "description": "Upgraded to v2.56.0.3 (Exit Code: 0)",
        "timestamp": "2026-10-30T14:20:00Z"
      }
    ]
  }
}
```
- **Error Codes**: `401 Unauthorized`, `403 Forbidden`, `404 Not Found`.

---

## 5. Applications Inventory (`applications`)

### 5.1 Search, Filter, Sort & Paginate Applications
- **Method & Path**: `GET /api/v1/devices/:id/applications`
- **Auth**: `Bearer <JWT>`
- **Query Parameters**:
  - `search` (`string`, optional): Case-insensitive match on `name` or `package_id`.
  - `status` (`string`, optional): `all` | `update_available` | `supported` | `unsupported` (default: `all`).
  - `source` (`string`, optional): `all` | `winget` | `msstore` | `none` (default: `all`).
  - `sort_by` (`string`, optional): `name` | `package_id` | `installed_version` | `status` (default: `name`).
  - `sort_order` (`string`, optional): `asc` | `desc` (default: `asc`).
  - `page` (`integer`, optional): Page number starting at 1 (default: `1`).
  - `limit` (`integer`, optional): Page size (default: `20`, max: `100`).
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "33333333-3333-3333-3333-333333333333",
        "package_id": "Git.Git",
        "name": "Git for Windows",
        "installed_version": "2.50.0.2",
        "available_version": "2.56.0.3",
        "source": "winget",
        "is_managed": true,
        "status": "UPDATE_AVAILABLE",
        "last_scanned_at": "2026-10-30T14:15:00Z"
      },
      {
        "id": "33333333-3333-3333-3333-333333333334",
        "package_id": "Python.Python.3.14",
        "name": "Python 3.14.0 (64-bit)",
        "installed_version": "3.14.0",
        "available_version": null,
        "source": "winget",
        "is_managed": true,
        "status": "SUPPORTED",
        "last_scanned_at": "2026-10-30T14:15:00Z"
      }
    ],
    "pagination": {
      "total_items": 196,
      "total_pages": 10,
      "current_page": 1,
      "page_size": 20
    }
  }
}
```
- **Error Codes**: `400 Bad Request` (invalid sort parameter), `401 Unauthorized`, `403 Forbidden`, `404 Not Found`.

---

### 5.2 Application Details Panel
- **Method & Path**: `GET /api/v1/devices/:id/applications/:appId`
- **Auth**: `Bearer <JWT>`
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "id": "33333333-3333-3333-3333-333333333333",
    "package_id": "Git.Git",
    "name": "Git for Windows",
    "installed_version": "2.50.0.2",
    "available_version": "2.56.0.3",
    "source": "winget",
    "is_managed": true,
    "status": "UPDATE_AVAILABLE",
    "publisher": "The Git Development Community",
    "architecture": "x64",
    "install_scope": "Machine",
    "manifest_url": "https://github.com/microsoft/winget-pkgs/tree/master/manifests/g/Git/Git",
    "pending_preview_id": "44444444-4444-4444-4444-444444444444",
    "last_scanned_at": "2026-10-30T14:15:00Z"
  }
}
```
- **Error Codes**: `401 Unauthorized`, `403 Forbidden`, `404 Not Found`.

---

## 6. Scans (`scans`)

### 6.1 Trigger On-Demand Scan
Dispatches a request for the Windows agent to execute `winget list` and `winget upgrade`.
- **Method & Path**: `POST /api/v1/devices/:id/scans`
- **Auth**: `Bearer <JWT>`
- **Request Body**: None
- **Success Response (202 Accepted)**:
```json
{
  "success": true,
  "data": {
    "scan_id": "55555555-5555-5555-5555-555555555555",
    "device_id": "22222222-2222-2222-2222-222222222222",
    "status": "QUEUED",
    "trigger_type": "MANUAL",
    "created_at": "2026-10-30T14:38:00Z",
    "message": "Scan queued. Agent will execute inspection on next poll."
  }
}
```
- **Error Codes**: `401 Unauthorized`, `403 Forbidden`, `404 Not Found`, `409 Conflict` (`ACTIVE_SCAN_IN_PROGRESS`).

---

### 6.2 Get Scan Status
- **Method & Path**: `GET /api/v1/devices/:id/scans/:scanId`
- **Auth**: `Bearer <JWT>`
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "scan_id": "55555555-5555-5555-5555-555555555555",
    "status": "COMPLETED",
    "packages_discovered_count": 196,
    "updates_discovered_count": 33,
    "exit_code": 0,
    "started_at": "2026-10-30T14:38:02Z",
    "completed_at": "2026-10-30T14:38:18Z"
  }
}
```
- **Error Codes**: `401 Unauthorized`, `403 Forbidden`, `404 Not Found`.

---

## 7. Update Approvals & Execution (`update_previews`, `update_jobs`)

### 7.1 List Pending Updates
- **Method & Path**: `GET /api/v1/devices/:id/updates/pending`
- **Auth**: `Bearer <JWT>`
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": [
    {
      "preview_id": "44444444-4444-4444-4444-444444444444",
      "package_id": "Git.Git",
      "package_name": "Git for Windows",
      "current_version": "2.50.0.2",
      "target_version": "2.56.0.3",
      "source": "winget",
      "source_url": "https://github.com/microsoft/winget-pkgs/...",
      "status": "PENDING_APPROVAL",
      "discovered_at": "2026-10-30T14:15:00Z"
    }
  ]
}
```
- **Error Codes**: `401 Unauthorized`, `403 Forbidden`, `404 Not Found`.

---

### 7.2 Approve an Update (Explicit User Approval Gate)
> **Cardinal Non-Negotiable**: Enforces explicit human approval before any update command is queued for agent execution.
- **Method & Path**: `POST /api/v1/updates/previews/:previewId/approve`
- **Auth**: `Bearer <JWT>`
- **Request Body**:
```json
{
  "authorized": true
}
```
- **Success Response (201 Created)**:
```json
{
  "success": true,
  "data": {
    "job_id": "66666666-6666-6666-6666-666666666666",
    "preview_id": "44444444-4444-4444-4444-444444444444",
    "package_id": "Git.Git",
    "status": "QUEUED",
    "command": "winget upgrade --id Git.Git --exact --silent",
    "approved_at": "2026-10-30T14:38:30Z",
    "approved_by_user": "dinusha@example.com",
    "message": "Update approved. Agent will execute update on next poll."
  }
}
```
- **Error Codes**: 
  - `400 Bad Request` (`AUTHORIZATION_REQUIRED`: `authorized` must be true)
  - `401 Unauthorized`
  - `403 Forbidden`
  - `404 Not Found`
  - `409 Conflict` (`ACTIVE_UPDATE_IN_PROGRESS`: Package is already running or queued)

---

### 7.3 Reject an Update
- **Method & Path**: `POST /api/v1/updates/previews/:previewId/reject`
- **Auth**: `Bearer <JWT>`
- **Request Body**:
```json
{
  "reason": "Not approved for this host"
}
```
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "preview_id": "44444444-4444-4444-4444-444444444444",
    "status": "REJECTED",
    "rejected_at": "2026-10-30T14:38:35Z"
  }
}
```
- **Error Codes**: `401 Unauthorized`, `403 Forbidden`, `404 Not Found`.

---

### 7.4 Get Update Job Real-Time Status & Logs
- **Method & Path**: `GET /api/v1/devices/:id/update-jobs/:jobId`
- **Auth**: `Bearer <JWT>`
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "job_id": "66666666-6666-6666-6666-666666666666",
    "package_id": "Git.Git",
    "status": "COMPLETED",
    "installed_version_before": "2.50.0.2",
    "installed_version_after": "2.56.0.3",
    "exit_code": 0,
    "stdout_log": "Found Git [Git.Git] Version 2.56.0.3\nSuccessfully installed.",
    "stderr_log": "",
    "approved_at": "2026-10-30T14:38:30Z",
    "started_at": "2026-10-30T14:38:35Z",
    "completed_at": "2026-10-30T14:39:17Z",
    "duration_seconds": 42
  }
}
```
- **Error Codes**: `401 Unauthorized`, `403 Forbidden`, `404 Not Found`.

---

## 8. Audit History & CSV Exports (`history`, `export`)

### 8.1 List History Events
- **Method & Path**: `GET /api/v1/devices/:id/history`
- **Auth**: `Bearer <JWT>`
- **Query Parameters**:
  - `type` (`string`, optional): `all` | `scan` | `update` (default: `all`).
  - `status` (`string`, optional): `all` | `succeeded` | `failed` | `rejected`.
  - `from` (`ISO8601`, optional): Filter start date.
  - `to` (`ISO8601`, optional): Filter end date.
  - `page` (`integer`, optional): Page number (default: `1`).
  - `limit` (`integer`, optional): Results per page (default: `20`, max: `100`).
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "77777777-7777-7777-7777-777777777777",
        "job_type": "UPDATE",
        "package_id": "Git.Git",
        "package_name": "Git for Windows",
        "status": "SUCCEEDED",
        "exit_code": 0,
        "operator": "Dinusha",
        "version_before": "2.50.0.2",
        "version_after": "2.56.0.3",
        "duration_seconds": 42,
        "timestamp": "2026-10-30T14:39:17Z"
      }
    ],
    "pagination": {
      "total_items": 28,
      "total_pages": 2,
      "current_page": 1,
      "page_size": 20
    }
  }
}
```
- **Error Codes**: `400 Bad Request`, `401 Unauthorized`, `403 Forbidden`, `404 Not Found`.

---

### 8.2 Export Applications Inventory to CSV
- **Method & Path**: `GET /api/v1/devices/:id/applications/export.csv`
- **Auth**: `Bearer <JWT>`
- **Response Headers**:
  - `Content-Type: text/csv; charset=utf-8`
  - `Content-Disposition: attachment; filename="applications-DESKTOP-DINUSHA-2026-10-30.csv"`
- **Success Response (200 OK)**:
```csv
Name,PackageId,InstalledVersion,AvailableVersion,Source,IsManaged,LastScannedAt
"Git for Windows","Git.Git","2.50.0.2","2.56.0.3","winget",true,"2026-10-30T14:15:00Z"
"7-Zip 24.09 (x64)","7zip.7zip","24.09","26.05","winget",true,"2026-10-30T14:15:00Z"
"Python 3.14.0 (64-bit)","Python.Python.3.14","3.14.0","","winget",true,"2026-10-30T14:15:00Z"
"Google Chrome","ARP\Machine\X86\Google Chrome","156.0.8078.48","","",false,"2026-10-30T14:15:00Z"
```
- **Error Codes**: `401 Unauthorized`, `403 Forbidden`, `404 Not Found`.

---

### 8.3 Export History to CSV
- **Method & Path**: `GET /api/v1/devices/:id/history/export.csv`
- **Auth**: `Bearer <JWT>`
- **Response Headers**:
  - `Content-Type: text/csv; charset=utf-8`
  - `Content-Disposition: attachment; filename="history-DESKTOP-DINUSHA-2026-10-30.csv"`
- **Success Response (200 OK)**:
```csv
JobId,JobType,PackageId,Status,ExitCode,VersionBefore,VersionAfter,Operator,Timestamp
"66666666-6666-6666-6666-666666666666","UPDATE","Git.Git","SUCCEEDED",0,"2.50.0.2","2.56.0.3","Dinusha","2026-10-30T14:39:17Z"
"55555555-5555-5555-5555-555555555555","SCAN","Full Inventory","SUCCEEDED",0,"","","Dinusha","2026-10-30T14:38:18Z"
"44444444-4444-4444-4444-444444444444","UPDATE","Zoom.Zoom.EXE","REJECTED",,"5.10.7","7.2.1","Dinusha","2026-10-29T17:15:00Z"
```
- **Error Codes**: `401 Unauthorized`, `403 Forbidden`, `404 Not Found`.

---

## 9. Agent-Facing REST API (`/api/v1/agent`)

The agent-facing API facilitates communication between the local Python Windows agent running on the user's PC and the UpdatePilot backend.

### 9.1 Agent Authentication & Security Model
1. **Bearer Token Authentication**:
   - Every agent request (except initial pairing) must transmit the permanent device secret in the header:
     `Authorization: Bearer <AGENT_DEVICE_TOKEN>`
2. **Backend Hash Verification**:
   - The backend **never** stores or compares plaintext agent tokens.
   - Upon receiving the token, the backend computes `SHA-256(AGENT_DEVICE_TOKEN)` and queries `agent_credentials` where `token_hash = computed_hash`.
3. **Revocation & Decommissioning Handling**:
   - If `agent_credentials.revoked_at IS NOT NULL` or `devices.status = 'REVOKED'`, the request is immediately rejected with:
     ```json
     {
       "success": false,
       "error": {
         "code": "DEVICE_REVOKED",
         "message": "This agent pairing has been revoked by the device owner.",
         "action_required": "PURGE_LOCAL_CREDENTIALS"
       }
     }
     ```
   - Upon encountering `DEVICE_REVOKED` (HTTP 401), the Python agent **must** immediately delete its locally cached configuration and enter an unconfigured, dormant state.
4. **Strict Job & Device Ownership Validation**:
   - The backend infers `device_id` directly from the authenticated token hash.
   - When claiming jobs, submitting logs, or reporting progress, the backend verifies that `job.device_id == authenticated_device_id`.
   - Attempts to access or mutate tasks belonging to other machines are rejected with `403 Forbidden` (`JOB_OWNERSHIP_MISMATCH`).

---

### 9.2 Device Pairing (`pair`)
Initial onboarding exchange: redeems a short-lived user pairing token for a permanent device identity and secret token.
- **Method & Path**: `POST /api/v1/agent/pair`
- **Auth**: Public (Authenticated by one-time pairing token)
- **Request Body**:
```json
{
  "pairing_token": "tok_8f92ab14ce67d0219b",
  "hardware_uuid": "4C4C4544-004E-5210-8054-C3C04F343233",
  "computer_name": "DESKTOP-DINUSHA",
  "os_version": "Windows 11 Home Single Language",
  "os_build": "26200",
  "agent_version": "1.0.0",
  "winget_version": "v1.29.380"
}
```
- **Backend Validation**:
  - Computes `SHA-256(pairing_token)`.
  - Verifies token exists, has not expired (`pairing_expires_at > NOW()`), and has not been redeemed.
  - Binds the device to the user who generated the token.
  - Generates a cryptographically random permanent token (32 bytes / 64 hex characters), hashes it with SHA-256, and stores the hash in `agent_credentials.token_hash`.
- **Success Response (201 Created)**:
```json
{
  "success": true,
  "data": {
    "device_id": "22222222-2222-2222-2222-222222222222",
    "agent_token": "agt_9f82ab14e76c01283d59a0f443b7e829",
    "heartbeat_interval_seconds": 60,
    "message": "Device successfully paired. Store agent_token securely in host DPAPI / protected storage."
  }
}
```
- **Error Codes**: `400 Bad Request` (missing hardware info), `403 Forbidden` (`TOKEN_EXPIRED_OR_INVALID`).

---

### 9.3 Agent Heartbeat (`heartbeat`)
Periodic ping sent by the agent (e.g. every 60 seconds) to update online status and report runtime metrics.
- **Method & Path**: `POST /api/v1/agent/heartbeat`
- **Auth**: `Bearer <AGENT_DEVICE_TOKEN>`
- **Request Body**:
```json
{
  "agent_version": "1.0.0",
  "winget_version": "v1.29.380",
  "os_build": "26200",
  "uptime_seconds": 14200
}
```
- **Backend Validation**:
  - Authenticates device token hash; verifies device is not revoked.
  - Updates `devices.last_heartbeat_at = NOW()` and `devices.status = 'ONLINE'`.
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "acknowledged_at": "2026-10-30T14:40:00Z",
    "has_pending_jobs": true
  }
}
```
- **Error Codes**: `401 Unauthorized` (`DEVICE_REVOKED` / `INVALID_TOKEN`).

---

### 9.4 Poll for Pending Jobs (`jobs`)
Retrieves active tasks in `queued` status waiting for agent pickup on this device.
- **Method & Path**: `GET /api/v1/agent/jobs`
- **Auth**: `Bearer <AGENT_DEVICE_TOKEN>`
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "jobs": [
      {
        "id": "66666666-6666-6666-6666-666666666666",
        "job_type": "UPDATE_PACKAGE",
        "package_id": "Git.Git",
        "command": "winget upgrade --id Git.Git --exact --silent",
        "target_version": "2.56.0.3",
        "approved_at": "2026-10-30T14:38:30Z",
        "approved_by_user": "dinusha@example.com"
      }
    ]
  }
}
```
- **Error Codes**: `401 Unauthorized` (`DEVICE_REVOKED`).

---

### 9.5 Claim a Job (`claim`)
Atomically claims a queued job, transitioning it from `queued` to `running`.
- **Method & Path**: `POST /api/v1/agent/jobs/:jobId/claim`
- **Auth**: `Bearer <AGENT_DEVICE_TOKEN>`
- **Backend Validation**:
  - Verifies `job.device_id == authenticated_device.id`.
  - Verifies `job.status == 'QUEUED'`. Rejects if already claimed or cancelled.
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "job_id": "66666666-6666-6666-6666-666666666666",
    "status": "RUNNING",
    "claimed_at": "2026-10-30T14:40:05Z",
    "execution_timeout_seconds": 1200
  }
}
```
- **Error Codes**: `401 Unauthorized`, `403 Forbidden` (`JOB_OWNERSHIP_MISMATCH`), `409 Conflict` (`JOB_ALREADY_CLAIMED_OR_TERMINAL`).

---

### 9.6 Report Job Live Progress (`progress`)
Streams ongoing progress during lengthy downloads or installations for dashboard display.
- **Method & Path**: `POST /api/v1/agent/jobs/:jobId/progress`
- **Auth**: `Bearer <AGENT_DEVICE_TOKEN>`
- **Request Body**:
```json
{
  "stage": "DOWNLOADING",
  "progress_percentage": 75,
  "message": "Downloading Git-2.56.0.3-64-bit.exe (48.1 MB / 64.2 MB)",
  "stdout_line": "> [██████████████████████████████      ] 75%"
}
```
- **Backend Validation**:
  - Verifies `job.device_id == authenticated_device.id` and `job.status == 'RUNNING'`.
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "received": true
  }
}
```
- **Error Codes**: `401 Unauthorized`, `403 Forbidden`, `404 Not Found`.

---

### 9.7 Submit Scan Results (`scans/results`)
Transmits parsed inventory discovered from `winget list` and `winget upgrade`.
- **Method & Path**: `POST /api/v1/agent/scans/:scanId/results`
- **Auth**: `Bearer <AGENT_DEVICE_TOKEN>`
- **Request Body**:
```json
{
  "exit_code": 0,
  "discovered_packages": [
    {
      "name": "Git for Windows",
      "package_id": "Git.Git",
      "installed_version": "2.50.0.2",
      "available_version": "2.56.0.3",
      "source": "winget",
      "is_managed": true
    },
    {
      "name": "Google Chrome",
      "package_id": "ARP\\Machine\\X86\\Google Chrome",
      "installed_version": "156.0.8078.48",
      "available_version": null,
      "source": null,
      "is_managed": false
    }
  ],
  "available_upgrades": [
    {
      "name": "Git for Windows",
      "package_id": "Git.Git",
      "installed_version": "2.50.0.2",
      "target_version": "2.56.0.3",
      "source": "winget"
    }
  ],
  "raw_stderr": ""
}
```
- **Backend Processing**:
  - Synchronizes device `applications` inventory.
  - Generates or updates `update_previews` in `PENDING_APPROVAL` status for actionable upgrades.
  - Transitions `scan_jobs` status to `COMPLETED` (or `FAILED` if non-zero exit code).
  - Logs `SCAN_COMPLETED` in `audit_events`.
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "scan_id": "55555555-5555-5555-5555-555555555555",
    "status": "COMPLETED",
    "synced_packages_count": 196,
    "synced_previews_count": 33
  }
}
```
- **Error Codes**: `400 Bad Request`, `401 Unauthorized`, `403 Forbidden`, `404 Not Found`.

---

### 9.8 Submit Update Execution Result (`update-jobs/results`)
Transmits the final outcome of an approved `winget upgrade` command execution.
- **Method & Path**: `POST /api/v1/agent/update-jobs/:jobId/results`
- **Auth**: `Bearer <AGENT_DEVICE_TOKEN>`
- **Request Body**:
```json
{
  "exit_code": 0,
  "verified_installed_version": "2.56.0.3",
  "stdout_log": "Successfully installed Git [Git.Git] Version 2.56.0.3",
  "stderr_log": ""
}
```
- **Backend Verification**:
  - Evaluates exit code and verifies `verified_installed_version == preview.target_version`.
  - Transitions `update_jobs.status` to `COMPLETED` (if exit code 0) or `FAILED` (if non-zero).
  - Updates `applications.installed_version` to target version.
  - Records final status in `audit_events`.
- **Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "job_id": "66666666-6666-6666-6666-666666666666",
    "status": "COMPLETED",
    "acknowledged_at": "2026-10-30T14:41:00Z"
  }
}
```
- **Error Codes**: `400 Bad Request`, `401 Unauthorized`, `403 Forbidden`, `404 Not Found`.

