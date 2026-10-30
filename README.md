# UpdatePilot

A secure, centralized software update management platform for Windows endpoints. UpdatePilot continuously monitors installed applications, detects available updates through WinGet, and **applies updates only after explicit user approval** via a modern web dashboard.

---

## Architecture & Monorepo Structure

```text
Update_Pilot/
├── frontend/          # Web Dashboard (React 19 + Vite + TypeScript + React Router)
├── backend/           # Core REST API & Database Layer (Express + TypeScript + Prisma)
├── agent/             # Windows Endpoint Agent (Python 3 WinGet Automation)
├── docs/              # System Architecture, Database Schema, Wireframes, and API Specs
├── tools/             # Diagnostic probes and environment verification scripts
└── docker-compose.yml # PostgreSQL 16 container service for local development
```

---

## Core Security & Operational Principles

1. **Explicit Approval Only**: No software update is ever applied without direct human authorization recorded in the dashboard.
2. **Zero Plaintext Credentials**: Passwords, device secrets, and pairing keys are strictly stored and verified as cryptographic hashes.
3. **Single-User Device Ownership**: Every device strictly belongs to exactly one user.
4. **Resilient WinGet Automation**: Subprocess execution uses explicit argument lists (no `shell=True`) with strict regex whitelisting and post-install version verification.

---

## Prerequisites

- **Node.js**: v20+ LTS (Tested with Node.js v24.x)
- **npm**: v10+ (Tested with npm v11.x)
- **Docker** / **Docker Compose** (Optional: for running PostgreSQL locally)
- **Python**: 3.11+ (For endpoint agent service)
- **Windows Package Manager**: `winget` (Windows 10/11)

---

## Exact Setup and Run Steps

### 1. Configure Environment Files

Create the local `.env` files from their documented examples:

```bash
# Backend environment configuration
cp backend/.env.example backend/.env

# Frontend environment configuration
cp frontend/.env.example frontend/.env
```

**Backend Environment Variables (`backend/.env`):**
| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server listening port | `3000` |
| `NODE_ENV` | Application environment (`development`, `test`, `production`) | `development` |
| `FRONTEND_ORIGIN` | Allowed CORS origin for web dashboard | `http://localhost:5173` |
| `DATABASE_URL` | PostgreSQL connection string via Prisma | `postgresql://postgres:postgres@localhost:5432/updatepilot?schema=public` |

**Frontend Environment Variables (`frontend/.env`):**
| Variable | Description | Default |
|---|---|---|
| `VITE_API_BASE_URL` | Backend REST API endpoint base URL | `http://localhost:3000` |

---

### 2. Start PostgreSQL (Optional Docker Container)

You can launch the isolated PostgreSQL 16 database using Docker Compose:

```bash
# From workspace root
docker compose up -d postgres
```

The database container exposes `localhost:5432` with credentials:
- **User**: `postgres`
- **Password**: `postgres`
- **Database**: `updatepilot`

*(If Docker is not installed, you can use any local PostgreSQL instance by updating `DATABASE_URL` in `backend/.env`.)*

---

### 3. Backend Setup & Run

```bash
cd backend

# Install dependencies
npm install

# Generate Prisma Client (supports generation before models are added)
npm run prisma:generate

# Start development server with live reload
npm run dev
```

The backend server will start on **http://localhost:3000**.

#### Health & Database Check
Verify the service is active by visiting:
```text
GET http://localhost:3000/api/health
```

- When PostgreSQL is running:
  ```json
  {
    "status": "OK",
    "timestamp": "2026-10-30T10:33:27.853Z",
    "database": {
      "status": "connected"
    }
  }
  ```
- When PostgreSQL is offline/disconnected:
  ```json
  {
    "status": "DEGRADED",
    "timestamp": "2026-10-30T10:33:27.853Z",
    "database": {
      "status": "disconnected",
      "error": "Database query timed out"
    }
  }
  ```

---

### 4. Frontend Setup & Run

```bash
cd frontend

# Install dependencies
npm install

# Start Vite development server
npm run dev
```

The frontend dashboard will start on **http://localhost:5173**.

---

### 5. Code Quality: Linting & Formatting

Both `frontend/` and `backend/` have ESLint and Prettier configured:

```bash
# In backend/
npm run lint          # Run ESLint on src/
npm run lint:fix      # Automatically fix ESLint issues
npm run format        # Format code using Prettier
npm run format:check  # Check formatting compliance

# In frontend/
npm run lint          # Run ESLint on src/
npm run lint:fix      # Automatically fix ESLint issues
npm run format        # Format code using Prettier
npm run format:check  # Check formatting compliance
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
