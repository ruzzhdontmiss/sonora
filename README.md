# SONORA — Universal Music Library & Portability Platform

SONORA is an open-source, provider-independent music library and portability platform designed to help users curate, preserve, back up, and transfer music metadata and ordered playlist structures across streaming services without locking their catalog to a single ecosystem.

> **Architectural Invariant:** SONORA stores music metadata, canonical track identifiers, and ordered curation relationships only. It does **not** host, stream, proxy, download, or redistribute provider audio files.

---

## Implementation Status & Provider Boundaries

**Status:** **Phase 1 through Phase 5 Fully Implemented & Verified** (Foundation, Canonical Library, Spotify & Apple Music Integrations, Matching & Playlist Migration, YouTube Integration, Portable Backups, Automated Sync & Launch Hardening).

> **Operating & Security Boundaries:**
> - **Official Streaming Provider APIs Only:** Live connections to **Spotify Web API**, **Apple Music API / MusicKit JS**, and **YouTube Data API v3** are implemented exclusively through official developer endpoints. SONORA strictly rejects unofficial Innertube endpoints, `ytmusicapi`, and browser cookie scraping (`SAPISIDHASH`).
> - **Provider Parity Boundary:** YouTube Data API v3 supports verified public resources (playlists, playlist items, liked videos with category filtering) and does not claim full native YouTube Music personal-library parity (e.g. native saved albums).
> - **Delivery Semantics & Uncertain Writes:** External provider writes do not support distributed 2PC transactions. Background migrations use **at-least-once** outbox delivery, lease fencing tokens, and paginated **dual-read prefix verification** to prevent duplicate track insertions after network drops.
> - **Authentication:** Supports official OAuth 2.0 with PKCE (`S256`) for Spotify and Google / YouTube, developer token generation + MusicKit JS for Apple Music, and local development demo authentication (`DEMO_AUTH_ENABLED=true` in `NODE_ENV=development`).

---

## Architecture & Tech Stack

SONORA is structured as a strict **modular monolith** backed by ACID PostgreSQL persistence and Redis/BullMQ queue dispatch:

- **Framework & UI:** Next.js 15 (App Router, React 19, TypeScript Strict), Tailwind CSS, Lucide Icons
- **Runtime & Package Manager:** Node.js 26 Active LTS, `pnpm` (v9+)
- **Database & ORM:** PostgreSQL 16 & Prisma 6
  - **Multi-Tenant Isolation:** Composite database foreign keys (`(id, userId)`) enforce tenant boundaries across libraries, playlists, snapshots, and provider links at the storage engine level.
  - **Playlist Invariants:** Repeated track occurrences in the same playlist are preserved with contiguous `position` integers, serialized with row-level `FOR UPDATE` locks and two-phase position shifts.
  - **Track Matching:** Deterministic matching by ISRC (Tier 1) and normalized metadata with $\pm 10\text{s}$ duration tolerance (Tier 2). Strict version gating prevents studio tracks from automatically matching Live, Cover, or Remix candidates without manual review.
- **Queue, Outbox & Idempotency:** Redis 7 + BullMQ 6
  - **Transactional Outbox:** PostgreSQL `FOR UPDATE SKIP LOCKED` claims with monotonic `leaseGeneration`, per-claim UUID `leaseToken` fencing, automatic worker heartbeat renewal, lease expiry rejection, and authoritative PostgreSQL retry budgets.
  - **Idempotency Wrapper:** Atomic reservation claims with background lease renewal and fencing-token completion checks.
- **Provider Quota Management:**
  - Multi-bucket quota manager separating Search Queries (100 calls/day) from General Quota (10,000 units/day) with Pacific Time midnight resets, active lease reservations, and crash recovery.
- **Backups & Portability:**
  - Immutable library snapshots with deterministic SHA-256 checksums.
  - Versioned portable JSON export (`sonora-export-v1`) with zero credential leakage.
  - Non-destructive dry-run restore preview diffing and transactional restoration.
- **Security & Validation:** Zod environment validation, `jose` JWT session cookies (`HttpOnly`, `SameSite=Lax`), Origin/Host CSRF protection, AES-256-GCM authenticated encryption for OAuth tokens at rest, structured logs with recursive secret redaction, and pre-commit secret scanning.

---

## Project Structure

```
sonora/
├── docs/
│   ├── architecture/          # Canonical domain model & data dictionary
│   ├── providers/             # Capability matrices & quota documentation
│   │   ├── apple-music-capabilities.md
│   │   ├── spotify-capabilities.md
│   │   └── youtube-capabilities.md
│   ├── phase4-report.md       # Phase 4 recovery & verification audit
│   └── phase5-report.md       # Phase 5 completion & release readiness report
├── prisma/
│   ├── schema.prisma          # Multi-tenant canonical schema & outbox models
│   ├── migrations/            # Versioned Prisma PostgreSQL migrations
│   └── seed.ts                # Realistic synthetic catalog & ordered playlist seed script
├── scripts/
│   └── secret-scan.mjs        # Automated secret & tracked .env scanner
├── src/
│   ├── app/                   # Next.js App Router pages and API routes
│   │   ├── (auth)/login/      # Login screen with development demo sign-in
│   │   ├── (dashboard)/       # Authenticated dashboard (overview, library, playlists, matching, transfer, sync, backups)
│   │   └── api/               # Auth, connection, matching, migration, sync, backup & health API routes
│   ├── components/            # Shared UI layout and navigation shell
│   ├── config/                # Zod environment validation & configuration guardrails
│   ├── lib/                   # Prisma client, Redis, AES-256-GCM encryption, CSRF, logger, idempotency
│   ├── modules/               # Modular domain services
│   │   ├── auth/              # Session validation and hashing
│   │   ├── backup/            # Snapshots, portable exports & restore engine
│   │   ├── common/            # Typed domain error classes
│   │   ├── jobs/              # Durable outbox service, BullMQ dispatch & migration orchestrator
│   │   ├── library/           # Sovereign library reads, batch import & conflict persistence
│   │   ├── matching/          # Deterministic ISRC, metadata harmonization & YouTube normalizer
│   │   ├── playlists/         # Contiguous ordering, duplicate repeats & safe reordering
│   │   ├── providers/         # Provider adapters (Spotify, Apple Music, YouTube) & capability registry
│   │   └── sync/              # Automated sync rules & continuous reconciliation service
│   └── middleware.ts          # Edge authentication guard for /dashboard/*
├── tests/
│   ├── unit/                  # 27 unit test suites (auth, matching, normalizers, writers, quotas, snapshots, sync)
│   └── integration/           # 5 integration suites (outbox, schema invariants, Redis quota, db health)
├── .env.example               # Placeholder-only environment variable template
├── .gitignore                 # Secret, local data, runtime artifact & build exclusions
├── CONTRIBUTING.md
├── LICENSE                    # MIT License
├── RULES.md                   # Core development rules & invariants
├── SECURITY.md                # Architecture security boundaries
└── TICKETS.md                 # Master ticket tracker (Phases 1–5 completed)
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
- `DEMO_AUTH_ENABLED`: Set to `"true"` (strictly when `NODE_ENV=development`) to enable local demo sign-in.
- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`: Spotify developer credentials (optional for local demo).
- `APPLE_TEAM_ID` / `APPLE_MUSIC_KEY_ID`: Apple Developer credentials (optional for local demo).
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: Google Cloud Console credentials for YouTube (optional for local demo).

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
`pnpm db:seed` seeds 24 realistic canonical tracks across 6 artists and albums, 3 playlists (including duplicate track occurrence preservation), and 3 ambiguous tracks for match review.

### 6. Run the Application
```bash
pnpm dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser:
- Sign in at `/login` using **Demo Sign-In (Synthetic User)** (requires `DEMO_AUTH_ENABLED=true` in development).
- Browse `/dashboard/library`, `/dashboard/playlists`, `/dashboard/matching`, `/dashboard/transfer`, `/dashboard/sync`, and `/dashboard/backups`.
- Inspect service health at `/api/health`.

### 7. Background Outbox Worker
```bash
pnpm worker
```

---

## Verification & Quality Checks

Run the full verification suite:

```bash
pnpm typecheck     # Strict TypeScript compilation check (0 errors)
pnpm lint          # ESLint checks (0 warnings, 0 errors)
pnpm test          # 32 test files, 334 tests (100% passing)
pnpm build         # Production Next.js build verification (19/19 routes compiled)
pnpm secret-scan   # Automated scanner for secrets and tracked .env files
```

Verify Prisma migration alignment:
```bash
pnpm prisma migrate status
```

---

## Roadmap & Phase History

- **Phase 1 — Foundation (Completed):** Project scaffold, security boundaries, DB health checks, session auth foundation, dashboard shell.
- **Phase 2 — Canonical Library & Sync Foundations (Completed):** Canonical multi-tenant PostgreSQL schema, deterministic track matching with material conflict splitting, order-preserving playlists, encrypted token storage, capability contracts, transactional outbox + BullMQ lease fencing & heartbeat renewal, idempotency reservation recovery.
- **Phase 3 — Spotify & Apple Music Integrations (Completed):** Spotify Web API with PKCE and February 2026 endpoint compliance, Apple Music developer token signing and MusicKit JS user authorization, paginated library and playlist importers.
- **Phase 4 — Cross-Provider Migration & Safe Transfer (Completed):** Deterministic matching engine with version gating, interactive match review UI, canonical playlist manager, Spotify and Apple Music destination writers with verified prefix recovery.
- **Phase 5 — YouTube Integration, Portable Backups & Release Hardening (Completed):** Official YouTube Data API v3 integration, dual-bucket quota management, ISO 8601 duration parser and ISRC extractor, liked music extraction, auxiliary Google Data Portability API importer, dual-read prefix write safeguards, immutable snapshots, versioned portable JSON exports (`sonora-export-v1`), restore dry-run diffing and transactional restore, automated sync rules, and structured redacted logging.

---

## Security & Privacy

See [`SECURITY.md`](SECURITY.md) for architecture security boundaries, CSRF/XSS design notes, and vulnerability reporting.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening issues or pull requests.

## License

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 Rushat Yadav.
