# SONORA — Universal Music Library & Portability Platform

SONORA is a web application that stores a provider-independent music library and helps users organize, back up, and transfer music metadata and playlist structures between streaming providers (Spotify, Apple Music, and YouTube Data API v3).

> **Architectural Invariant:** SONORA does not host, proxy, download, or redistribute provider audio files. It stores music metadata and user library curation relationships only.

---

## Tech Stack (Phase 1 Foundation)

- **Framework:** Next.js 15 (App Router with TypeScript)
- **Styling:** Tailwind CSS & Lucide Icons
- **Language / Runtime:** TypeScript (Strict), Node.js 26 Active LTS
- **Package Manager:** `pnpm` (single pinned lockfile)
- **Database & ORM:** PostgreSQL 16 & Prisma 6
- **Cache & Jobs:** Redis 7 (via Docker Compose)
- **Authentication:** Database-backed sessions with signed HTTP-only cookies (`jose`)
- **Validation:** Zod for typed server-side environment variables and boundaries
- **Test Runner:** Vitest

---

## Project Structure (Modular Monolith)

```
sonora/
├── prisma/
│   ├── schema.prisma          # PostgreSQL schema with User and Session models
│   ├── migrations/            # Versioned Prisma migration history
│   └── seed.ts                # Synthetic data seed script
├── src/
│   ├── app/                   # Next.js App Router (auth & dashboard shells)
│   │   ├── (auth)/login/      # Login page with demo sign-in
│   │   ├── (dashboard)/       # Authenticated product views
│   │   │   ├── dashboard/     # Overview metrics
│   │   │   ├── library/       # Canonical library
│   │   │   ├── playlists/     # Playlist curation
│   │   │   ├── connections/   # Streaming provider capability matrix
│   │   │   ├── transfer/      # Cross-platform transfer engine
│   │   │   ├── sync/          # Reconciliation engine
│   │   │   └── backups/       # Portable snapshot exports
│   │   ├── api/               # API route handlers (auth, health)
│   │   └── layout.tsx         # Root layout
│   ├── components/            # Reusable UI & presentation layer
│   │   └── dashboard/         # Sidebar, Header, and responsive shell
│   ├── config/                # Typed server-side environment validation (Zod)
│   ├── lib/                   # Shared infrastructure (Prisma client, DB health check)
│   ├── modules/               # Domain boundaries
│   │   └── auth/              # Session service, token hashing, constants
│   └── middleware.ts          # Edge route protection for /dashboard/*
├── tests/
│   ├── unit/                  # Unit tests (env validation, auth & session)
│   └── integration/           # Integration tests (database connectivity)
├── scripts/
│   └── secret-scan.mjs        # Pre-push and local secret scanner
├── docker-compose.yml         # Local disposable PostgreSQL + Redis services
├── .env.example               # Safe variable templates with descriptive comments
├── .gitignore                 # Strict secret, OS, and build artifact exclusions
├── package.json
└── pnpm-lock.yaml
```

---

## Local Setup & Quickstart

### 1. Prerequisites
- **Node.js**: `v26.x` (Active LTS)
- **pnpm**: `v9.x`
- **Docker Desktop**: Running locally

### 2. Clone & Install Dependencies
```bash
git clone <repo-url> sonora
cd sonora
pnpm install
```

### 3. Environment Configuration
Copy `.env.example` to create local configuration:
```bash
cp .env.example .env.local
cp .env.example .env
```
*(Both `.env` and `.env.local` are strictly ignored by Git and never committed).*

### 4. Start Local PostgreSQL & Redis
```bash
docker compose up -d
```
Verify containers are running:
```bash
docker compose ps
```

### 5. Run Database Migrations & Synthetic Seed
```bash
pnpm db:migrate
pnpm db:seed
```
This initializes the database schema and seeds a test user:
- Email: `synthetic-user@example.com`
- Name: `Synthetic Demo User`

### 6. Start Development Server
```bash
pnpm dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.
- Visit `/login` and click **"Demo Sign-In (Synthetic User)"** to access the dashboard shell.
- Health check endpoint is available at `/api/health`.

---

## Verification & Quality Checks

Run the complete Phase 1 test and build suite:

```bash
# 1. Typecheck
pnpm typecheck

# 2. Linting
pnpm lint

# 3. Unit & Integration Tests
pnpm test

# 4. Production Build
pnpm build

# 5. Secret Scanner
pnpm secret-scan
```

---

## Security & Privacy Rules

- **No Secrets in Code:** Real credentials, tokens, Apple `.p8` keys, certificates, or `.env` files must NEVER be committed.
- **Server-Only Credentials:** Sensitive keys are never prefixed with `NEXT_PUBLIC_` and never returned in browser bundles.
- **Demo Mode Isolation:** Synthetic demo authentication is governed by `DEMO_AUTH_ENABLED` and is strictly locked to `NODE_ENV=development`. It is rejected in production and staging environments, and direct submission of the demo address cannot bypass authentication.
- **CSRF Protection:** State-changing requests (`POST`, `PUT`, `DELETE`) enforce strict Origin and Host header validation. State mutations are forbidden on `GET` requests. Cookies use `SameSite=Lax`.
- **XSS & Cookie Security Model:** Session cookies use the `HttpOnly` flag. While `HttpOnly` prevents JavaScript from reading raw cookie values via `document.cookie`, it does not prevent injected scripts from issuing authenticated same-origin requests. Therefore, the UI enforces strict output encoding and strictly avoids unsafe HTML injection (`dangerouslySetInnerHTML`).
- **Provider Parity Boundary:** YouTube Data API v3 does not imply full YouTube Music personal library parity. Capabilities are explicitly gated.
- **Audit:** All commits and diffs undergo pre-commit secret scans (`pnpm secret-scan`).
