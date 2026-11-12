# SONORA — Universal Music Library & Portability Platform

SONORA is an open-source, provider-independent music library and portability platform designed to help users curate, preserve, back up, and transfer music metadata and ordered playlist structures across streaming services without locking their catalog to a single ecosystem.

> **Architectural Invariant:** SONORA stores music metadata, canonical track identifiers, and ordered curation relationships only. It does **not** host, stream, proxy, download, or redistribute provider audio files.

---

## Current Implementation Status & Honest Limitations

**Status:** **Phase 1 & Phase 2 Complete** (Foundation + Canonical Library, Matching, Provider Contracts & Durable Outbox)

> **Important Pre-Release Notice:**
> - **Production Authentication Is Not Yet Implemented:** Login is currently restricted strictly to local development synthetic demo authentication (`NODE_ENV=development` and `DEMO_AUTH_ENABLED=true`). All passwordless email login paths fail closed. Do **not** deploy publicly with real user traffic until full OAuth/OIDC or verified authentication is added in a subsequent phase.
> - **Live Streaming Provider Integrations Are Not Yet Operational:** Live connections to **Spotify Web API**, **Apple Music API / MusicKit JS**, and **YouTube Data API v3** are **not** yet implemented or connected. Phase 2 provides the capability-aware adapter interfaces, runtime registry, AES-256-GCM credential encryption, and deterministic in-memory fake adapters for automated testing only.
> - **Provider Parity Boundary:** When implemented in later phases, YouTube Data API v3 will support only verified public resources and will not claim full YouTube Music personal-library parity.
> - **Delivery Semantics:** External provider calls cannot participate in distributed two-phase commit (2PC) transactions with PostgreSQL; background synchronization operates under **at-least-once** outbox delivery with worker lease fencing and provider-side idempotency boundaries.

---

## Architecture & Tech Stack

SONORA is structured as a strict **modular monolith** backed by ACID PostgreSQL persistence and Redis/BullMQ queue dispatch:

- **Framework & UI:** Next.js 15 (App Router, React 19, TypeScript Strict), Tailwind CSS, Lucide Icons
- **Runtime & Package Manager:** Node.js 26 Active LTS, `pnpm` (v9+)
- **Database & ORM:** PostgreSQL 16 & Prisma 6
  - **Multi-Tenant Isolation:** Composite database foreign keys (`(id, userId)`) enforce tenant boundaries across libraries, playlists, snapshots, and provider links at the storage engine level.
  - **Playlist Invariants:** Repeated track occurrences in the same playlist are preserved with contiguous `position` integers, serialized with row-level `FOR UPDATE` locks and two-phase position shifts.
  - **Track Matching:** Deterministic matching by ISRC (with material metadata contradiction splitting into reviewable tracks rather than silent merges) and exact normalized metadata (title, artist, explicit status, live/remix/acoustic version discrimination, and $\pm 2\text{s}$ duration tolerance).
- **Queue, Outbox & Idempotency:** Redis 7 + BullMQ 6
  - **Transactional Outbox:** PostgreSQL `FOR UPDATE SKIP LOCKED` claims with monotonic `leaseGeneration`, per-claim UUID `leaseToken` fencing, automatic worker heartbeat renewal, lease expiry rejection, and authoritative PostgreSQL retry budgets.
  - **Idempotency Wrapper:** Atomic reservation claims with background lease renewal and fencing-token completion checks.
- **Security & Validation:** Zod environment validation (`NODE_ENV=production` enforces 256-bit 64-hex-character `TOKEN_ENCRYPTION_KEY`), `jose` JWT session cookies (`HttpOnly`, `SameSite=Lax`), Origin/Host CSRF protection, AES-256-GCM authenticated encryption for OAuth tokens at rest, and pre-commit secret scanning.

---

## Project Structure

```
sonora/
├── docs/
│   └── architecture/          # Canonical domain model & data dictionary
├── prisma/
│   ├── schema.prisma          # Multi-tenant canonical schema & outbox models
│   ├── migrations/            # Versioned Prisma PostgreSQL migrations
│   └── seed.ts                # Synthetic catalog & ordered playlist seed script
├── scripts/
│   └── secret-scan.mjs        # Automated secret & tracked .env scanner
├── src/
│   ├── app/                   # Next.js App Router pages and API routes
│   │   ├── (auth)/login/      # Development demo login screen
│   │   ├── (dashboard)/       # Authenticated dashboard routes (library, playlists, backups, etc.)
│   │   └── api/               # Auth (/api/auth/*) & health check (/api/health) handlers
│   ├── components/            # Shared UI layout and navigation shell
│   ├── config/                # Zod environment validation & configuration guardrails
│   ├── lib/                   # Prisma client, Redis, AES-256-GCM encryption, CSRF, idempotency
│   ├── modules/               # Modular domain services
│   │   ├── auth/              # DB-backed session validation and hashing
│   │   ├── common/            # Typed domain error classes
│   │   ├── jobs/              # Durable outbox service, BullMQ dispatch & fenced workers
│   │   ├── library/           # Sovereign library reads, batch import & conflict persistence
│   │   ├── matching/          # Deterministic ISRC & metadata harmonization
│   │   ├── playlists/         # Contiguous ordering, duplicate repeats & safe reordering
│   │   └── providers/         # Explicit provider capability contracts & fake test adapter
│   └── middleware.ts          # Edge authentication guard for /dashboard/*
├── tests/
│   ├── unit/                  # Auth, env, encryption, matching & contract unit tests
│   └── integration/           # PostgreSQL/Redis outbox, domain services & schema invariant tests
├── .env.example               # Placeholder-only environment variable template
├── .gitignore                 # Secret, local data, runtime artifact & build exclusions
├── CONTRIBUTING.md
├── LICENSE                    # MIT License
└── SECURITY.md
```

---

## Local Setup & Development

### 1. Prerequisites
- **Node.js:** `v26.x` (Active LTS)
- **pnpm:** `v9.x` (`corepack enable` or `npm i -g pnpm`)
- **Docker:** PostgreSQL 16 and Redis 7 containers running locally

### 2. Install Dependencies
```bash
git clone https://github.com/ruzzhdontmiss/sonora.git sonora
cd sonora
pnpm install
```

### 3. Environment Configuration
Copy `.env.example` to `.env.local` and `.env`:
```bash
cp .env.example .env.local
cp .env.example .env
```

Key environment variables (placeholders shown in [`.env.example`](.env.example)):
- `AUTH_SECRET`: Session signing secret (minimum 16 characters; use a strong random value).
- `DATABASE_URL`: PostgreSQL connection string (`postgresql://sonora_user:sonora_password@localhost:5432/sonora_dev?schema=public`).
- `REDIS_URL`: Redis connection URL (`redis://localhost:6379`).
- `TOKEN_ENCRYPTION_KEY`: 32-byte key for OAuth tokens at rest. In `NODE_ENV=production`, a 64-character hex string (`openssl rand -hex 32`, 256 bits) is strictly required.
- `DEMO_AUTH_ENABLED`: Must be `"true"` (strictly when `NODE_ENV=development`) to enable local demo sign-in. Defaults to `"false"`.

> Never commit `.env`, `.env.local`, `.p8`, `.pem`, `.key`, or real OAuth credentials. Server secrets must never carry a `NEXT_PUBLIC_` prefix.

### 4. Start PostgreSQL & Redis
```bash
docker compose up -d
docker compose ps
```

### 5. Run Migrations & Seed Synthetic Data
```bash
pnpm db:migrate
pnpm db:seed
```
`pnpm db:seed` creates one synthetic demo account (`synthetic-user@example.com`), a canonical library with 4 sample tracks, and a sample playlist (`Synthetic Morning Mix`) demonstrating preserved sequence ordering and repeated track occurrences.

### 6. Run the Application
```bash
pnpm dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser:
- Sign in at `/login` using **Demo Sign-In (Synthetic User)** (requires `DEMO_AUTH_ENABLED=true` in development).
- Browse `/dashboard/library` and `/dashboard/playlists` backed by live PostgreSQL queries.
- Inspect service health at `/api/health`.

### 7. Optional Background Outbox Worker
```bash
pnpm worker
```

---

## Verification & Quality Checks

Run the full verification suite cleanly with Docker running:

```bash
pnpm typecheck     # Strict TypeScript compilation check
pnpm lint          # ESLint checks
pnpm test          # 104 unit & integration tests across 9 Vitest suites
pnpm build         # Production Next.js build verification
pnpm secret-scan   # Automated scanner for secrets and tracked .env files
```

Verify Prisma migration alignment:
```bash
npx prisma migrate status
```

---

## Roadmap

- **Phase 1 — Foundation (Completed):** Project scaffold, security boundaries, DB health checks, session auth foundation, dashboard shell.
- **Phase 2 — Canonical Library & Sync Foundations (Completed):** Canonical multi-tenant PostgreSQL schema, deterministic track matching with material conflict splitting, order-preserving playlists, encrypted token storage, capability contracts, transactional outbox + BullMQ lease fencing & heartbeat renewal, idempotency reservation recovery.
- **Phase 3 — Verified Authentication & Read Adapters (Planned):** Real user authentication, Spotify Web API read integration within official quota/mode constraints, Apple Music MusicKit integration, and capability-gated YouTube Data API reads.
- **Phase 4 — Cross-Platform Transfer & Reconciliation Engine (Planned):** Conflict preview workflows, additive writes with idempotency, rate limiting, and audit logs.
- **Phase 5 — Portable Snapshots & Hardening (Planned):** Versioned JSON metadata export/restore, E2E browser testing, and deployment hardening.

---

## Security & Privacy

See [`SECURITY.md`](SECURITY.md) for architecture security boundaries, CSRF/XSS design notes, and vulnerability reporting.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening issues or pull requests.

## License

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 Rushat Yadav.
