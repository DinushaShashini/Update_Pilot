# UpdatePilot

A secure, centralized software update management platform for Windows endpoints. UpdatePilot continuously monitors installed applications, detects available updates through WinGet, and **applies updates only after explicit user approval** via a modern web dashboard.

---

## Architecture & Workspaces

The repository is organized as a monorepo containing three core components and supporting documentation:

```text
Update_Pilot/
├── frontend/    # Web Dashboard (React + Vite + TypeScript)
├── backend/     # REST API & Database Layer (Node.js + Express + TypeScript + Prisma)
├── agent/       # Windows Client Service (Python 3 WinGet Automation)
├── docs/        # Architecture, Database, Wireframes, and API Specifications
└── tools/       # Diagnostic probes and environment verification scripts
```

---

## Core Security & Operational Principles

1. **Explicit Approval Only**: No software update is ever applied without direct human authorization recorded in the dashboard.
2. **Zero Plaintext Credentials**: Passwords, device secrets, and pairing keys are strictly stored and verified as cryptographic hashes.
3. **Single-User Device Ownership**: Every device strictly belongs to exactly one user.
4. **Resilient WinGet Automation**: Subprocess execution uses explicit argument lists (no `shell=True`) with strict regex whitelisting and post-install version verification.

---

## Setup & Getting Started

<!-- Setup steps placeholder - Do not install dependencies until instructed -->

### Prerequisites
- Node.js (v20+ LTS recommended)
- Python (3.11+ / 3.14 on Windows)
- Windows Package Manager (`winget`)
- PostgreSQL 15+

### Installation & Run Steps
*(Placeholder: Setup steps will be documented as each workspace is configured.)*

```bash
# 1. Backend setup
# cd backend && npm install && npx prisma migrate dev && npm run dev

# 2. Frontend setup
# cd frontend && npm install && npm run dev

# 3. Agent setup
# cd agent && python -m venv .venv && pip install -r requirements.txt && python -m updatepilot
```

---

## Documentation Quick Links

- [Project Context & Rules](file:///docs/PROJECT_CONTEXT.md)
- [Requirements & Workflows](file:///docs/requirements.md)
- [WinGet Behavior & Limits](file:///docs/winget-research.md)
- [Database Schema & ERD](file:///docs/database.md)
- [Job State Machines](file:///docs/job-states.md)
- [REST API Specification](file:///docs/api.md)
- [UI Wireframes & Navigation Map](file:///docs/wireframes/README.md)
