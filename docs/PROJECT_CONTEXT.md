# UpdatePilot - Project Context

## Overview
**UpdatePilot** is a centralized software update management platform comprising a modern web dashboard, a secure backend API, and a lightweight Windows agent. The agent monitors installed applications on a Windows PC, queries available updates using the Windows Package Manager (WinGet), and applies updates **only after the user explicitly approves them** in the dashboard.

---

## Technology Stack

- **Dashboard**: React + Vite + TypeScript
- **Backend API**: Node.js + Express + TypeScript
- **Database & ORM**: PostgreSQL + Prisma
- **Windows Agent**: Python (Windows Agent)

---

## Core Rules & Non-Negotiables

1. **Explicit Approval Only**: Never run any software update without explicit user approval through the dashboard.
2. **Zero Plaintext Secrets**: Never store plaintext passwords or authentication tokens in the database, filesystem, or logs.
3. **Strict Input Validation**: Validate all incoming payloads and inputs across all backend endpoints and agent commands.
4. **Single-User Device Ownership**: Every device strictly belongs to exactly one user.
5. **Conventional Commits**: All git commits must strictly follow the Conventional Commits specification (e.g., `feat:`, `fix:`, `docs:`, `test:`, `refactor:`).
6. **Test-Driven Delivery**: Add automated unit/integration tests alongside each new feature.
7. **Transparent Incremental Changes**: Show the plan before changing files and keep all changes small and focused.

---

## Architecture & Workflow

1. **Agent Registration & Heartbeat**:
   - The Python agent registers with the backend using a secure one-time registration token or API key.
   - The backend associates the device with the authenticated user.
   - The agent sends periodic heartbeats to report online/offline status.

2. **Scan & Detection**:
   - The agent executes WinGet inspection (`winget list` / `winget upgrade`) in a safe, non-mutating manner.
   - Detected installed packages and available updates are reported to the backend.

3. **Approval State Machine**:
   - Updates enter the state machine as `PENDING_APPROVAL`.
   - The user reviews pending updates on the dashboard and selects `APPROVE` or `REJECT`.
   - The state transitions to `APPROVED` or `REJECTED` with an immutable audit log entry.

4. **Execution & Verification**:
   - The agent polls or receives notification for `APPROVED` updates only.
   - The agent executes the update via `winget upgrade --id <PackageId> --exact`.
   - The agent reports the execution outcome (`INSTALLED` or `FAILED`), and the dashboard updates in real time.
